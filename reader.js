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

  async function discoverLists(signal) {
    if (!document.querySelector(NAV)) {
      document.querySelector('button.toggleSidebar, button[aria-label="切换边栏"], button[aria-label="Toggle sidebar"]')?.click();
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
      toggle.click();
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

  async function closeDetails(signal) {
    if (!detailId()) return;
    const button = await waitFor(() => {
      if (!detailId()) return true;
      const close = document.querySelector(`${DETAILS} .detailFooter-close`);
      return close?.getClientRects().length && close;
    }, 4500, signal, '任务详情的关闭按钮未加载。');
    if (button === true) return;
    button.click();
    // To Do keeps the closed pane mounted for reuse. The route marks it closed.
    await waitFor(() => !detailId(), 4500, signal, '任务详情未能关闭。');
  }

  async function openList(list, signal) {
    await closeDetails(signal);
    const entry = listRows().find(candidate => candidate.id === list.id);
    if (!entry) throw fail('清单已从侧栏消失。');
    if (!entry.row.matches('.active,[aria-selected="true"]')) entry.item.click();
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
    result.root.scrollTop = 0;
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

  async function readTask(row, signal) {
    if (!row.title || !row.trigger) throw fail('网页上的任务标题或详情入口无法识别。');
    const completed = boolCheckbox(row.checkbox);
    const important = boolCheckbox(row.star);
    row.trigger.click();
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
      if (!signal.aborted) await closeDetails(signal);
    }
  }

  async function expandTaskGroups(root, signal) {
    let expanded = false;
    for (const toggle of root.querySelectorAll('.taskCard .openCloseArrow[aria-expanded="false"]')) {
      if (!toggle.isConnected || !toggle.getClientRects().length) continue;
      toggle.click();
      expanded = true;
    }
    if (expanded) await sleep(175, signal);
    return expanded;
  }

  function checkCounts(tasks, expectedOpen, expectedCompleted) {
    let done = 0;
    for (const task of tasks) if (task.completed) done++;
    const open = tasks.length - done;
    if (expectedOpen !== null && open !== expectedOpen) {
      throw fail(`未完成任务计数不符，网页显示 ${expectedOpen} 条，读取到 ${open} 条。`);
    }
    if (expectedCompleted !== null && done !== expectedCompleted) {
      throw fail(`已完成任务计数不符，网页显示 ${expectedCompleted} 条，读取到 ${done} 条。`);
    }
  }

  async function scanList(list, signal, report) {
    const {root, grid, expectedOpen} = await openList(list, signal);
    const tasks = new Map();
    const listPositions = new Set();
    let expectedCompleted = 0;
    let quietAtEnd = 0;

    while (quietAtEnd < 3) {
      signal.throwIfAborted();
      if (!root.isConnected) throw fail('任务列表在读取期间重新加载。');
      const start = root.scrollTop;
      const before = tasks.size;
      const completed = root.querySelector('#completed_tasks-label');
      if (completed) expectedCompleted = displayedCount(completed.nextElementSibling);
      const expanded = await expandTaskGroups(root, signal);

      const rootTop = root.getBoundingClientRect().top;
      const mounted = taskRows(root, grid).map(row => ({
        ...row,
        position: grid ? null : JSON.stringify([Math.round(row.element.getBoundingClientRect().top - rootTop + root.scrollTop), row.title]),
      }));
      for (const row of mounted) {
        if (!row.element.isConnected) continue;
        if (row.id ? tasks.has(row.id) : listPositions.has(row.position)) continue;
        const task = await readTask(row, signal);
        if (row.position !== null) listPositions.add(row.position);
        tasks.set(task.id, task);
        report(tasks.size);
        if (Math.abs(root.scrollTop - start) > 2) {
          root.scrollTop = start;
          await sleep(100, signal);
        }
      }

      const bottom = Math.max(0, root.scrollHeight - root.clientHeight);
      if (start >= bottom - 2) {
        quietAtEnd = tasks.size === before && !expanded ? quietAtEnd + 1 : 0;
        await sleep(240, signal);
      } else {
        quietAtEnd = 0;
        root.scrollTop = Math.min(bottom, start + Math.max(60, Math.floor(root.clientHeight * 0.7)));
        await sleep(100, signal);
      }
    }

    const result = [...tasks.values()];
    checkCounts(result, expectedOpen, expectedCompleted);
    return result;
  }

  async function readAll(port, signal) {
    const lists = await discoverLists(signal);
    const result = [];
    let count = 0;

    for (const [offset, list] of lists.entries()) {
      const progress = (retry, size = 0) => port.postMessage({
        type: 'progress', list: list.name, index: offset + 1, total: lists.length, count: count + size, retry,
      });
      let tasks;
      try {
        progress(false);
        tasks = await scanList(list, signal, size => progress(false, size));
      } catch {
        signal.throwIfAborted();
        progress(true);
        try {
          tasks = await scanList(list, signal, size => progress(true, size));
        } catch (error) {
          signal.throwIfAborted();
          throw fail(`「${list.name}」读取失败。${error.message}`);
        }
      }
      result.push({...list, tasks});
      count += tasks.length;
    }
    return result;
  }

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'todo-export' || port.sender.id !== chrome.runtime.id) return;
    let controller;
    port.onDisconnect.addListener(() => controller?.abort());
    port.onMessage.addListener(async message => {
      if (message.type !== 'start' || controller) return;
      if (activeRead) {
        port.postMessage({type: 'error', message: '此标签页正在读取任务，请稍后重试。'});
        return;
      }
      controller = new AbortController();
      activeRead = controller;
      try {
        const lists = await readAll(port, controller.signal);
        if (!controller.signal.aborted) port.postMessage({type: 'done', lists});
      } catch (error) {
        if (!controller.signal.aborted) port.postMessage({type: 'error', message: error.message, code: error.code});
      } finally {
        activeRead = undefined;
      }
    });
    port.postMessage({type: 'ready'});
  });
})();
