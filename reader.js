(() => {
  'use strict';

  if (globalThis.todoExportReaderInstalled) return;
  globalThis.todoExportReaderInstalled = true;

  const NAV = '.sidebar-content ul.lists';
  const LIST = 'li.listItem-container[role="option"]';
  const SMART_LISTS = new Set(['important', 'planned', 'assigned_to_me', 'my_day', 'flagged_email', 'completed_tasks']);
  const GRID_VIEW = '.centerColumn-item.grid-view';
  const LIST_VIEW = '.chunkedScrollContainer';
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
    throw fail('网页上的任务勾选状态无法识别。');
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
        '清单组无法展开。');
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
    }, 4500, signal, '任务详情的关闭按钮未加载。');
    if (button === true) return;
    await pace(() => {
      if (!detailId()) return false;
      button.click();
    });
    // To Do keeps the closed pane mounted for reuse. The route marks it closed.
    await waitFor(() => !detailId(), 4500, signal, '任务详情未能关闭。');
  }

  async function openList(list, signal, pace) {
    await closeDetails(signal, pace);
    const entry = listRows().find(candidate => candidate.id === list.id);
    if (!entry) throw fail('清单已从侧栏消失。');
    if (!entry.row.matches('.active,[aria-selected="true"]')) await pace(() => entry.item.click());
    const selected = () => {
      const current = listRows().find(candidate => candidate.id === list.id);
      return current?.row.matches('.active,[aria-selected="true"]') && current;
    };
    const result = await waitFor(() => {
      const current = selected();
      const taskInput = document.getElementById(`baseAddInput-addTask-${list.id}`);
      const currentView = view();
      if (current && taskInput && currentView?.root.isConnected) return currentView;
      return null;
    }, 12000, signal, '清单内容未加载。');
    if (result.root.scrollTop) await pace(() => { result.root.scrollTop = 0; });
    await sleep(220, signal);
    return {...result, expectedOpen: openTaskCount(selected()?.row)};
  }

  function taskRows(root, grid) {
    const selector = grid ? '.grid-row [id$="_title"]' : '.taskItem[role="treeitem"]';
    return [...root.querySelectorAll(selector)].map(element => {
      if (grid) {
        const row = element.closest('.grid-row');
        const title = text(element.querySelector('.show-ellipsis'));
        const id = element.id.slice(0, -'_title'.length);
        const checkbox = row.querySelector('[id$="_markTaskAsComplete"] [role="checkbox"]');
        const star = row.querySelector('[id$="_importance"] [role="checkbox"]');
        const dueDate = text(row.querySelector('[id$="_due_date"] .grid-cell-content')) || null;
        return {element, id, title, checkbox, star, dueDate, trigger: element.querySelector('button.icon-wrapper')};
      }
      const title = text(element.querySelector('.taskItem-title'));
      const checkbox = element.querySelector('.taskItem-body .checkBox[role="checkbox"]');
      const star = element.querySelector('.importanceButton[role="checkbox"]');
      const trigger = element.querySelector('button.taskItem-titleWrapper');
      return {element, title, checkbox, star, dueDate: null, trigger};
    });
  }

  function readSteps(details) {
    const container = details.querySelector('.steps');
    if (!container) throw fail('任务详情中的步骤区域无法识别。');
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
      throw fail('任务子步骤的标题无法识别。');
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
    if (!row.title || !row.trigger) throw fail('网页上的任务标题或详情入口无法识别。');
    let important;
    const opened = await pace(() => {
      if (!row.element.isConnected || !row.trigger.isConnected) return false;
      if (boolCheckbox(row.checkbox) !== completed) throw fail('任务状态在读取期间发生变化。');
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
      }, 6500, signal, '任务详情或备注未加载。');
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
      throw fail(`未完成任务计数不符，网页显示 ${expectedOpen} 条，读取到 ${open} 条。`);
    }
    if (expectedCompleted !== null && done !== expectedCompleted) {
      throw fail(`已完成任务计数不符，网页显示 ${expectedCompleted} 条，读取到 ${done} 条。`);
    }
  }

  async function scanList(list, signal, pace, scope, onTask) {
    const {root, grid, expectedOpen} = await openList(list, signal, pace);
    const ids = new Set();
    const listPositions = new Set();
    let done = 0;
    let expectedCompleted = 0;
    let quietAtEnd = 0;
    let stalled = 0;

    while (quietAtEnd < 3) {
      signal.throwIfAborted();
      if (!root.isConnected) throw fail('任务列表在读取期间重新加载。');
      const start = root.scrollTop;
      const before = ids.size;
      const completed = root.querySelector('#completed_tasks-label');
      if (completed) expectedCompleted = displayedCount(completed.nextElementSibling);
      const expanded = await expandTaskGroups(root, signal, pace, scope);

      const rootTop = root.getBoundingClientRect().top;
      const mounted = taskRows(root, grid).map(row => ({
        ...row,
        position: grid ? null : JSON.stringify([Math.round(row.element.getBoundingClientRect().top - rootTop + root.scrollTop), row.title]),
      }));
      for (const row of mounted) {
        if (!row.element.isConnected) continue;
        if (row.id ? ids.has(row.id) : listPositions.has(row.position)) continue;
        const completed = boolCheckbox(row.checkbox);
        if ((scope === 'open' && completed) || (scope === 'completed' && !completed)) continue;
        const task = await readTask(row, completed, signal, pace);
        if (!task) continue;
        if (row.position !== null) listPositions.add(row.position);
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
      if (start >= bottom - 2) {
        quietAtEnd = ids.size === before && !expanded ? quietAtEnd + 1 : 0;
        await sleep(240, signal);
      } else {
        quietAtEnd = 0;
        await pace(() => { root.scrollTop = Math.min(bottom, start + Math.max(60, Math.floor(root.clientHeight * 0.7))); });
        await sleep(100, signal);
        stalled = root.scrollTop <= start ? stalled + 1 : 0;
        if (stalled >= 3) throw fail('任务列表无法继续滚动。');
      }
    }

    checkCounts(ids.size - done, done, scope === 'completed' ? null : expectedOpen,
      scope === 'open' ? null : expectedCompleted);
    return ids.size;
  }

  async function readAll(port, signal, {scope, intervalMs}, sendBatch) {
    const pace = paceActions(intervalMs, signal);
    const lists = await discoverLists(signal, pace);
    let count = 0;

    for (const [offset, list] of lists.entries()) {
      const readList = async retry => {
        const index = offset + 1;
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
      try {
        count += await readList(false);
      } catch (error) {
        signal.throwIfAborted();
        if (error.code === 'TRANSFER') throw error;
        try {
          count += await readList(true);
        } catch (error) {
          signal.throwIfAborted();
          throw fail(`「${list.name}」读取失败。${error.message}`);
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
        if (!['all', 'open', 'completed'].includes(scope) || !Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 10000) {
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
