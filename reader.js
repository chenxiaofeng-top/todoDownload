(() => {
  'use strict';

  if (globalThis.todoExportReaderInstalled) return;
  globalThis.todoExportReaderInstalled = true;

  const NAV = '.sidebar-content ul.lists';
  const LIST = 'li.listItem-container[role="option"]';
  const SMART_LISTS = new Set(['important', 'planned', 'assigned_to_me', 'my_day', 'flagged_email', 'completed_tasks']);
  const GRID_VIEW = '.centerColumn-item.grid-view';
  const LIST_VIEW = '.chunkedScrollContainer';
  const LIST_SETTLE_MS = 220;
  const COUNT_PROGRESS_TIMEOUT_MS = 12000;
  const DETAILS = '.details';
  let activeRead;

  function fail(message, code) {
    return Object.assign(new Error(message), {code});
  }

  function text(element) {
    return (element?.innerText ?? element?.textContent ?? '').trim();
  }

  function sleep(ms, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      function abort() {
        clearTimeout(timer);
        reject(signal.reason);
      }
      signal.addEventListener('abort', abort, {once: true});
    });
  }

  function paceActions(intervalMs, signal) {
    let lastStart = -Infinity;
    return async action => {
      const remaining = lastStart + intervalMs - performance.now();
      if (remaining > 0) await sleep(remaining, signal);
      signal.throwIfAborted();
      const startedAt = performance.now();
      if (action() === false) return false;
      lastStart = startedAt;
      return true;
    };
  }

  async function waitFor(check, timeout, signal, message, code) {
    const deadline = Date.now() + timeout;
    do {
      signal.throwIfAborted();
      const result = check();
      if (result) return result;
      await sleep(65, signal);
    } while (Date.now() < deadline);
    throw fail(message, code);
  }

  function displayedCount(label) {
    const value = text(label);
    return /^\d[\d\s,.\u00a0\u202f]*$/.test(value) ? Number(value.replace(/\D/g, '')) : null;
  }

  function openTaskCount(row) {
    const badge = row?.querySelector('.listItem-count');
    if (badge) return displayedCount(badge);
    const label = row?.getAttribute('aria-label') || '';
    const count = label.match(/[,，]\s*([\d, .]+)\s*(?:个任务|tasks?)\s*$/i);
    return count ? Number(count[1].replace(/\D/g, '')) : null;
  }

  function boolCheckbox(element) {
    if (element?.matches('input[type="checkbox"]')) return element.checked;
    const state = element?.getAttribute('aria-checked');
    if (state === 'true' || state === 'false') return state === 'true';
    throw fail('网页上的任务勾选状态无法识别。', 'CHECKBOX_UNRECOGNIZED');
  }

  function listRows() {
    return [...document.querySelectorAll(`${NAV} ${LIST}`)].flatMap(row => {
      const item = row.querySelector(':scope > .listItem[id]');
      const name = text(item?.querySelector('.listItem-title'));
      return item?.id && name && !SMART_LISTS.has(item.id) ? [{row, item, id: item.id, name}] : [];
    });
  }

  async function discoverLists(signal, pace) {
    if (!document.querySelector(NAV)) {
      const button = document.querySelector('button.toggleSidebar, button[aria-label="切换边栏"], button[aria-label="Toggle sidebar"]');
      if (button) await pace(() => button.click());
    }
    const nav = await waitFor(() => document.querySelector(NAV), 18000, signal,
      'To Do 清单侧栏未加载。请检查登录状态或网页布局。', 'NOT_READY');
    await waitFor(() => listRows().some(list => list.id === 'inbox'), 12000, signal,
      '未找到默认任务清单。', 'NOT_READY');

    const opened = new WeakSet();
    while (true) {
      const toggle = [...nav.querySelectorAll('[aria-expanded="false"]')].find(element => {
        if (opened.has(element) || !element.getClientRects().length) return false;
        const label = element.getAttribute('aria-label') || element.getAttribute('title') || '';
        const group = element.closest('[class*="listGroup" i], [class*="groupItem" i], [class*="groupHeader" i], [class*="sidebar-group" i]');
        return /展开.*组|expand.*group/i.test(label) || Boolean(group && element.matches('button,[role="button"],li'));
      });
      if (!toggle) break;
      opened.add(toggle);
      await pace(() => toggle.isConnected ? toggle.click() : false);
      await waitFor(() => !toggle.isConnected || toggle.getAttribute('aria-expanded') === 'true', 2500, signal,
        '清单组无法展开。', 'LIST_GROUP_TIMEOUT');
      await sleep(100, signal);
    }

    return [...new Map(listRows().map(({id, name}) => [id, {id, name}])).values()];
  }

  function view() {
    const grid = document.querySelector(GRID_VIEW);
    if (grid?.querySelector('[role="grid"] .grid-body')) return {root: grid, grid: true};
    const list = document.querySelector(LIST_VIEW);
    if (list) return {root: list, grid: false};
    return null;
  }

  function emptyListPane(taskInput) {
    const addTask = taskInput?.closest('.addToTop.centerColumn-item');
    const pane = addTask?.parentElement;
    // To Do renders only the add-task area when empty. Loading adds a shimmer beside it.
    return pane?.matches('.main-background') && pane.childElementCount === 1 && pane.isConnected ? pane : null;
  }

  function detailId() {
    const match = location.pathname.match(/\/tasks\/id\/([^/]+)\/details(?:\/|$)/i);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function closeDetails(signal, pace) {
    if (!detailId()) return;
    const button = await waitFor(() => {
      if (!detailId()) return true;
      const close = document.querySelector(`${DETAILS} .detailFooter-close`);
      return close?.getClientRects().length && close;
    }, 4500, signal, '任务详情的关闭按钮未加载。', 'DETAIL_CLOSE_BUTTON_TIMEOUT');
    if (button === true) return;
    await pace(() => {
      if (!detailId()) return false;
      button.click();
    });
    // To Do keeps the closed pane mounted for reuse. The route marks it closed.
    await waitFor(() => !detailId(), 4500, signal, '任务详情未能关闭。', 'DETAIL_CLOSE_TIMEOUT');
  }

  async function openList(list, signal, pace) {
    await closeDetails(signal, pace);
    const entry = listRows().find(candidate => candidate.id === list.id);
    if (!entry) throw fail('清单已从侧栏消失。', 'LIST_MISSING');
    if (!entry.row.matches('.active,[aria-selected="true"]')) await pace(() => entry.item.click());
    const selected = () => {
      const current = listRows().find(candidate => candidate.id === list.id);
      return current?.row.matches('.active,[aria-selected="true"]') && current;
    };
    let emptyPane;
    let emptySince;
    const result = await waitFor(() => {
      const current = selected();
      const taskInput = document.getElementById(`baseAddInput-addTask-${list.id}`);
      const currentView = view();
      if (current && taskInput && currentView?.root.isConnected) return currentView;
      const pane = current && !currentView && !openTaskCount(current.row) ? emptyListPane(taskInput) : null;
      if (pane && pane === emptyPane && performance.now() - emptySince >= LIST_SETTLE_MS) return {empty: true};
      if (pane !== emptyPane) {
        emptyPane = pane;
        emptySince = performance.now();
      }
      return null;
    }, 12000, signal, '清单内容未加载。', 'LIST_TIMEOUT');
    if (result.empty) return result;
    if (result.root.scrollTop) await pace(() => { result.root.scrollTop = 0; });
    await sleep(LIST_SETTLE_MS, signal);
    return {...result, expectedOpen: openTaskCount(selected()?.row)};
  }

  function* unreadRows(root, grid, ids, listPositions) {
    const selector = grid ? '.grid-row [id$="_title"]' : '.taskItem[role="treeitem"]';
    const rootTop = grid ? 0 : root.getBoundingClientRect().top;
    for (const element of root.querySelectorAll(selector)) {
      if (!element.isConnected) continue;
      if (grid) {
        const id = element.id.slice(0, -'_title'.length);
        if (ids.has(id)) continue;
        const row = element.closest('.grid-row');
        const title = text(element.querySelector('.show-ellipsis'));
        const checkbox = row.querySelector('[id$="_markTaskAsComplete"] [role="checkbox"]');
        const star = row.querySelector('[id$="_importance"] [role="checkbox"]');
        const dueDate = text(row.querySelector('[id$="_due_date"] .grid-cell-content')) || null;
        yield {element, id, title, checkbox, star, dueDate, trigger: element.querySelector('button.icon-wrapper')};
        continue;
      }
      const title = text(element.querySelector('.taskItem-title'));
      const position = JSON.stringify([Math.round(element.getBoundingClientRect().top - rootTop + root.scrollTop), title]);
      if (listPositions.has(position)) continue;
      const checkbox = element.querySelector('.taskItem-body .checkBox[role="checkbox"]');
      const star = element.querySelector('.importanceButton[role="checkbox"]');
      const trigger = element.querySelector('button.taskItem-titleWrapper');
      yield {element, title, checkbox, star, dueDate: null, trigger, position};
    }
  }

  function nextTask(root, grid, ids, listPositions, scope) {
    for (const row of unreadRows(root, grid, ids, listPositions)) {
      const completed = boolCheckbox(row.checkbox);
      if ((scope === 'open' && completed) || (scope === 'completed' && !completed)) continue;
      return {row, completed};
    }
    return null;
  }

  function readSteps(details) {
    const container = details.querySelector('.steps');
    if (!container) throw fail('任务详情中的步骤区域无法识别。', 'STEP_CONTAINER_MISSING');
    const selector = '[role="checkbox"],input[type="checkbox"]';
    return [...container.querySelectorAll(selector)].map(checkbox => {
      let row = checkbox.parentElement;
      while (row && row !== container && row.querySelectorAll(selector).length === 1) {
        const title = text(row.querySelector('.step-title, .stepItem-title, .editableContent-editButton, .editableContent, [contenteditable="true"]'));
        if (title) return {title, completed: boolCheckbox(checkbox)};
        row = row.parentElement;
      }
      const label = checkbox.getAttribute('aria-label') || '';
      const title = label.replace(/^(?:将(?:步骤\s*)?|标记为(?:未|已)完成\s*|Mark (?:step )?(?:as )?(?:not )?completed?[:\s]*)+/i, '')
        .replace(/\s*(?:标记为(?:未|已)完成|\s+as (?:not )?completed?)\s*$/i, '').trim();
      if (title && title !== label) return {title, completed: boolCheckbox(checkbox)};
      throw fail('任务子步骤的标题无法识别。', 'STEP_TITLE_MISSING');
    });
  }

  function readDueDate(details) {
    for (const section of details.querySelectorAll('.section-item')) {
      const button = section.querySelector('.section-innerClick');
      const label = button?.getAttribute('aria-label') || '';
      if (/截止日期|到期日|due date/i.test(label)) {
        if (/^(?:添加|设置|add|set)\s*/i.test(label) && !section.querySelector('.section-delete')) return null;
        return text(button.querySelector('.date')) || text(button) || label;
      }
      if (section.querySelector('[aria-label*="删除截止日期"],[aria-label*="Remove due date" i],[aria-label*="Delete due date" i]')) {
        return text(button?.querySelector('.date')) || text(button) || null;
      }
    }
    return null;
  }

  async function readTask(row, completed, signal, pace) {
    if (!row.title || !row.trigger) throw fail('网页上的任务标题或详情入口无法识别。', 'TASK_ROW_UNRECOGNIZED');
    let important;
    const opened = await pace(() => {
      if (!row.element.isConnected || !row.trigger.isConnected) return false;
      if (row.id && row.element.id !== `${row.id}_title`) return false;
      if (boolCheckbox(row.checkbox) !== completed) throw fail('任务状态在读取期间发生变化。', 'TASK_STATE_CHANGED');
      important = boolCheckbox(row.star);
      row.trigger.click();
    });
    if (!opened) return null;
    try {
      const details = await waitFor(() => {
        const id = detailId();
        const pane = document.querySelector(`${DETAILS}:not(.detailsShimmer)`);
        return id && (!row.id || id === row.id) && pane &&
          !pane.closest('.rightColumn-exiting, .rightColumn-exited') &&
          pane.querySelector('.detailHeader')?.getClientRects().length &&
          pane.querySelector('.detailNote .ql-editor') && pane;
      }, 6500, signal, '任务详情或备注未加载。', 'DETAIL_TIMEOUT');
      const editor = details.querySelector('.detailNote .ql-editor');
      return {
        id: detailId(),
        title: row.title,
        completed,
        important,
        dueDate: row.dueDate ?? readDueDate(details),
        notes: editor.classList.contains('ql-blank') ? '' : (editor.innerText ?? editor.textContent),
        steps: readSteps(details),
      };
    } finally {
      if (!signal.aborted) await closeDetails(signal, pace);
    }
  }

  async function expandTaskGroups(root, signal, pace, scope) {
    let expanded = false;
    for (const toggle of root.querySelectorAll('.taskCard .openCloseArrow[aria-expanded="false"]')) {
      if (!toggle.isConnected || !toggle.getClientRects().length) continue;
      const group = toggle.closest('.taskCard');
      if (scope === 'open' && group?.querySelector('#completed_tasks-label')) continue;
      const clicked = await pace(() => {
        if (!toggle.isConnected || toggle.getAttribute('aria-expanded') !== 'false') return false;
        toggle.click();
      });
      expanded ||= clicked;
    }
    if (expanded) await sleep(175, signal);
    return expanded;
  }

  function checkCounts(open, done, expectedOpen, expectedCompleted) {
    if (expectedOpen !== null && open !== expectedOpen) {
      throw Object.assign(fail(`未完成任务计数不符，网页显示 ${expectedOpen} 条，读取到 ${open} 条。`, 'OPEN_COUNT_MISMATCH'),
        {expected: expectedOpen, observed: open});
    }
    if (expectedCompleted !== null && done !== expectedCompleted) {
      throw Object.assign(fail(`已完成任务计数不符，网页显示 ${expectedCompleted} 条，读取到 ${done} 条。`, 'COMPLETED_COUNT_MISMATCH'),
        {expected: expectedCompleted, observed: done});
    }
  }

  async function scanList(list, signal, pace, scope, onTask) {
    const {root, grid, expectedOpen: openCount, empty} = await openList(list, signal, pace);
    if (empty) return 0;
    const ids = new Set();
    const listPositions = new Set();
    const expectedOpen = scope === 'completed' ? null : openCount;
    let done = 0;
    let expectedCompleted = scope === 'open' ? null : 0;
    let quietAtEnd = 0;
    let stalled = 0;
    let largestBottom = 0;
    let shortfallSince;

    while (quietAtEnd < 3) {
      signal.throwIfAborted();
      if (!root.isConnected) throw fail('任务列表在读取期间重新加载。', 'TASK_LIST_REMOUNTED');
      const before = ids.size;
      if (scope !== 'open') {
        const completed = root.querySelector('#completed_tasks-label');
        if (completed) expectedCompleted = displayedCount(completed.nextElementSibling);
      }
      const expanded = await expandTaskGroups(root, signal, pace, scope);
      const start = root.scrollTop;

      // Opening details can replace the mounted rows. Re-query this window before scrolling on.
      let missed = 0;
      while (true) {
        signal.throwIfAborted();
        if (!root.isConnected) throw fail('任务列表在读取期间重新加载。', 'TASK_LIST_REMOUNTED');
        const next = nextTask(root, grid, ids, listPositions, scope);
        if (!next) break;
        const {row, completed} = next;
        const task = await readTask(row, completed, signal, pace);
        if (!task) {
          if (++missed >= 4) throw fail('任务行在读取期间持续重新渲染。', 'TASK_ROW_REMOUNTED');
          await sleep(65, signal);
          continue;
        }
        missed = 0;
        if (row.position !== undefined) listPositions.add(row.position);
        if (!ids.has(task.id)) {
          ids.add(task.id);
          if (task.completed) done++;
          await onTask(task, ids.size);
        }
        if (Math.abs(root.scrollTop - start) > 2) {
          await pace(() => { root.scrollTop = start; });
          await sleep(100, signal);
        }
      }

      const bottom = Math.max(0, root.scrollHeight - root.clientHeight);
      if (ids.size > before || bottom > largestBottom + 2) shortfallSince = undefined;
      largestBottom = Math.max(largestBottom, bottom);
      if (start >= bottom - 2) {
        const shortfall = (expectedOpen !== null && ids.size - done < expectedOpen) ||
          (expectedCompleted !== null && done < expectedCompleted);
        if (shortfall) {
          // The current bottom can move as To Do mounts more tasks.
          quietAtEnd = 0;
          shortfallSince ??= performance.now();
          if (performance.now() - shortfallSince >= COUNT_PROGRESS_TIMEOUT_MS) break;
        } else {
          shortfallSince = undefined;
          quietAtEnd = ids.size === before && !expanded ? quietAtEnd + 1 : 0;
        }
        await sleep(240, signal);
      } else {
        quietAtEnd = 0;
        await pace(() => { root.scrollTop = Math.min(bottom, start + Math.max(60, Math.floor(root.clientHeight * 0.7))); });
        await sleep(100, signal);
        stalled = root.scrollTop <= start ? stalled + 1 : 0;
        if (stalled >= 3) throw fail('任务列表无法继续滚动。', 'SCROLL_STALLED');
      }
    }

    checkCounts(ids.size - done, done, expectedOpen, expectedCompleted);
    return ids.size;
  }

  async function readAll(port, signal, {scope, intervalMs}, sendBatch) {
    const pace = paceActions(intervalMs, signal);
    const lists = await discoverLists(signal, pace);
    let count = 0;

    for (const [offset, list] of lists.entries()) {
      const index = offset + 1;
      let attemptCount;
      const readList = async retry => {
        attemptCount = 0;
        port.postMessage({type: 'list-start', list, index, total: lists.length, count, retry});
        let batch = [];
        let batchSize = 0;
        async function flush() {
          if (batch.length) await sendBatch(batch);
          batch = [];
          batchSize = 0;
        }
        let lastProgress = -Infinity;
        const size = await scanList(list, signal, pace, scope, async (task, size) => {
          attemptCount = size;
          const length = JSON.stringify(task).length;
          if (batchSize + length > 64 * 1024) await flush();
          batch.push(task);
          batchSize += length;
          if (batch.length >= 24 || batchSize >= 64 * 1024) await flush();
          const now = performance.now();
          if (now - lastProgress >= 500) {
            port.postMessage({type: 'progress', list: list.name, index, total: lists.length, count: count + size, retry});
            lastProgress = now;
          }
        });
        await flush();
        port.postMessage({type: 'list-end', index, size});
        return size;
      };
      function reportListError(error, retries) {
        port.postMessage({type: 'list-error', index, count: count + attemptCount, retries,
          code: error.code, expected: error.expected, observed: error.observed});
      }
      try {
        count += await readList(false);
      } catch (error) {
        signal.throwIfAborted();
        reportListError(error, 0);
        if (error.code === 'TRANSFER') throw error;
        try {
          count += await readList(true);
        } catch (error) {
          signal.throwIfAborted();
          reportListError(error, 1);
          throw fail(`「${list.name}」读取失败。${error.message}`, error.code);
        }
      }
    }
    port.postMessage({type: 'done', count, total: lists.length});
  }

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'todo-export' || port.sender.id !== chrome.runtime.id) return;
    let controller;
    let ack;
    let sequence = 0;
    port.onDisconnect.addListener(() => controller?.abort());
    port.onMessage.addListener(async message => {
      if (message.type === 'ack') {
        if (ack?.sequence === message.sequence) ack.finish();
        return;
      }
      if (message.type !== 'start' || controller) return;
      if (activeRead) {
        port.postMessage({type: 'error', message: '此标签页正在读取任务，请稍后重试。'});
        return;
      }
      controller = new AbortController();
      activeRead = controller;
      const {signal} = controller;
      function sendBatch(tasks) {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => finish(fail('侧栏未确认接收任务。', 'TRANSFER')), 10000);
          const abort = () => finish(signal.reason);
          function finish(error) {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            ack = undefined;
            if (error) reject(error);
            else resolve();
          }
          ack = {sequence: id, finish};
          signal.addEventListener('abort', abort, {once: true});
          try {
            port.postMessage({type: 'batch', sequence: id, tasks});
          } catch {
            finish(fail('无法将任务发送到侧栏。', 'TRANSFER'));
          }
        });
      }
      try {
        const scope = message.scope ?? 'all';
        const intervalMs = message.intervalMs ?? 1000;
        const validInterval = Number.isInteger(intervalMs) && (intervalMs === 0 || (intervalMs >= 250 && intervalMs <= 10000));
        if (!['all', 'open', 'completed'].includes(scope) || !validInterval) {
          throw fail('读取设置无效。');
        }
        await readAll(port, signal, {scope, intervalMs}, sendBatch);
      } catch (error) {
        if (!signal.aborted) port.postMessage({type: 'error', message: error.message, code: error.code});
      } finally {
        activeRead = undefined;
      }
    });
    port.postMessage({type: 'ready'});
  });
})();
