import {buildExportBlob, createSnapshot, exportName} from './export.mjs';

const TODO_HOME = 'https://to-do.live.com/tasks/inbox';
const TODO_ORIGIN = new URL(TODO_HOME).origin;
const LOGIN_HOSTS = new Set(['login.live.com', 'login.microsoftonline.com', 'login.microsoft.com', 'account.live.com']);
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
let currentRun;
let snapshot;
let saving = false;

const intervalPreference = 'todo-export-interval';
ui.interval.value = localStorage.getItem(intervalPreference) ?? '1000';
if (!ui.interval.validity.valid) ui.interval.value = '1000';
ui.interval.addEventListener('change', () => {
  if (ui.interval.validity.valid) localStorage.setItem(intervalPreference, ui.interval.value);
});

function stage(run, name, label, count) {
  if (label) run.lastStage = label;
  console.info('todo-export', name, count, run.intervalMs, run.scope);
}

function say(text) {
  ui.status.textContent = text;
}

function closeReaderTab(run) {
  const tabId = run.tabId;
  run.tabId = undefined;
  if (tabId !== undefined) chrome.tabs.remove(tabId).catch(() => {});
}

function cancelRead() {
  if (!currentRun) return;
  currentRun.controller.abort();
  closeReaderTab(currentRun);
}

function checkCancelled(run) {
  run.controller.signal.throwIfAborted();
}

function delay(ms, run) {
  const signal = run.controller.signal;
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

async function getReaderTab(run) {
  checkCancelled(run);
  try {
    return await chrome.tabs.get(run.tabId);
  } catch {
    checkCancelled(run);
    throw new Error(`读取标签页已关闭（最后阶段：${run.lastStage}）。请重新读取。`);
  }
}

function tabLocation(tab) {
  let url;
  try {
    url = new URL(tab.pendingUrl || tab.url || 'about:blank');
  } catch {
    return 'other';
  }
  if (url?.origin === TODO_ORIGIN) return 'todo';
  if (url?.protocol === 'https:' && LOGIN_HOSTS.has(url.hostname)) return 'login';
  return 'other';
}

async function waitForTodo(run, login = false) {
  let loadingSince = Date.now();
  let announcedLogin = false;
  while (true) {
    const tab = await getReaderTab(run);
    const location = tabLocation(tab);
    login ||= location === 'login';
    if (location === 'todo') {
      if (tab.status === 'complete' && !tab.pendingUrl) return;
    } else if (login) {
      loadingSince = Date.now();
      if (!announcedLogin) {
        stage(run, 'login', '等待登录');
        say('请在读取标签页手动登录 Microsoft To Do。返回 To Do 后将自动继续。');
        announcedLogin = true;
      }
    }
    if (Date.now() - loadingSince > 30000) throw new Error('To Do 页面加载超时，请检查网络后重新读取。');
    await delay(750, run);
  }
}

function showProgress({list, index, total, count, retry}) {
  ui.progress.max = total;
  ui.progress.value = index - 1;
  say(`${retry ? '正在重试' : '正在读取'}「${list}」（${index}/${total}）\n已读取 ${count} 条任务`);
}

function readTab(run) {
  checkCancelled(run);
  const signal = run.controller.signal;
  const port = chrome.tabs.connect(run.tabId, {name: 'todo-export'});
  return new Promise((resolve, reject) => {
    const lists = [];
    let draft;
    let count = 0;
    let sequence = 0;
    let lastLogged = -Infinity;
    let settled = false;
    const handshake = setTimeout(() => finish(reject, Object.assign(
      new Error(`未能连接 To Do 页面（最后阶段：${run.lastStage}）。`), {code: 'DISCONNECTED'})), 5000);
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(handshake);
      signal.removeEventListener('abort', abort);
      port.onDisconnect.removeListener(disconnected);
      port.disconnect();
      callback(value);
    }
    function abort() {
      finish(reject, signal.reason);
    }
    function disconnected() {
      void chrome.runtime.lastError;
      const error = new Error(`读取连接中断（最后阶段：${run.lastStage}）。请重新读取。`);
      error.code = 'DISCONNECTED';
      finish(reject, error);
    }
    signal.addEventListener('abort', abort, {once: true});
    port.onDisconnect.addListener(disconnected);
    port.onMessage.addListener(message => {
      clearTimeout(handshake);
      try {
        switch (message.type) {
          case 'list-start':
            if (message.index !== lists.length + 1) throw new Error('清单接收顺序异常。');
            draft = {...message.list, tasks: []};
            showProgress({...message, list: draft.name});
            stage(run, message.retry ? 'retry' : 'scan', `读取清单 ${message.index}/${message.total}`, message.count);
            lastLogged = performance.now();
            break;
          case 'progress':
            showProgress(message);
            if (performance.now() - lastLogged >= 1000) {
              stage(run, 'scan', undefined, message.count);
              lastLogged = performance.now();
            }
            break;
          case 'batch':
            if (!draft || message.sequence !== ++sequence) throw new Error('任务批次接收顺序异常。');
            for (const task of message.tasks) draft.tasks.push(task);
            port.postMessage({type: 'ack', sequence});
            break;
          case 'list-end':
            if (!draft || message.index !== lists.length + 1 || draft.tasks.length !== message.size) {
              throw new Error('清单接收数量不符。');
            }
            lists.push(draft);
            count += message.size;
            stage(run, 'scan', undefined, count);
            draft = undefined;
            break;
          case 'done':
            if (draft || lists.length !== message.total || count !== message.count) throw new Error('导出接收数量不符。');
            finish(resolve, {lists, count});
            break;
          case 'error':
            finish(reject, Object.assign(new Error(message.message), {code: message.code}));
            break;
        }
      } catch (error) {
        finish(reject, error);
      }
    });
    try {
      port.postMessage({type: 'start', scope: run.scope, intervalMs: run.intervalMs});
    } catch {
      disconnected();
    }
  });
}

async function collect(run) {
  let login = false;
  while (true) {
    await waitForTodo(run, login);
    try {
      checkCancelled(run);
      stage(run, 'discover', '识别清单');
      say('正在识别清单…');
      ui.progress.removeAttribute('value');
      try {
        await chrome.scripting.executeScript({target: {tabId: run.tabId}, files: ['reader.js']});
      } catch {
        throw Object.assign(new Error('无法读取 To Do 页面，请确认扩展具有该网站的访问权限。'), {code: 'NOT_READY'});
      }
      return await readTab(run);
    } catch (error) {
      login = false;
      // A navigation can disconnect the port just before the login URL is visible.
      const checks = ['DISCONNECTED', 'NOT_READY'].includes(error.code) ? 5 : 1;
      for (let i = 0; i < checks; i++) {
        if (tabLocation(await getReaderTab(run)) === 'login') {
          login = true;
          break;
        }
        if (i + 1 < checks) await delay(300, run);
      }
      if (!login) throw error;
    }
  }
}

async function startRead() {
  if (currentRun || saving || !ui.interval.reportValidity()) return;
  const run = {controller: new AbortController(), scope: ui.scope.value, intervalMs: ui.interval.valueAsNumber};
  localStorage.setItem(intervalPreference, String(run.intervalMs));
  currentRun = run;
  snapshot = undefined;
  ui.start.disabled = true;
  ui.scope.disabled = true;
  ui.interval.disabled = true;
  ui.cancel.hidden = false;
  ui.downloads.hidden = true;
  ui['download-status'].textContent = '';
  ui.progress.hidden = false;
  ui.progress.removeAttribute('value');
  say('正在打开 To Do 读取标签页…');
  stage(run, 'open', '打开读取标签页', 0);

  try {
    const current = await chrome.windows.getCurrent();
    checkCancelled(run);
    const tab = await chrome.tabs.create({url: TODO_HOME, windowId: current.id});
    run.tabId = tab.id;
    const {lists, count} = await collect(run);
    checkCancelled(run);
    snapshot = createSnapshot(lists);
    stage(run, 'ready', undefined, count);
    say(`读取完成，共 ${lists.length} 个清单、${count} 条任务。`);
    ui.downloads.hidden = false;
    ui.start.textContent = '重新读取';
  } catch (error) {
    stage(run, run.controller.signal.aborted ? 'cancelled' : 'failed');
    say(run.controller.signal.aborted ? '已取消读取。' : `读取失败。${error.message}`);
    ui.start.textContent = '重新读取';
  } finally {
    closeReaderTab(run);
    currentRun = undefined;
    ui.cancel.hidden = true;
    ui.start.disabled = false;
    ui.scope.disabled = false;
    ui.interval.disabled = false;
    ui.progress.hidden = true;
  }
}

async function save(format) {
  if (!snapshot || saving || currentRun) return;
  saving = true;
  ui.start.disabled = ui.csv.disabled = ui.json.disabled = true;
  const resultStatus = ui['download-status'];
  const filename = exportName(new Date(snapshot.exportedAt), format);
  const count = snapshot.lists.reduce((total, list) => total + list.tasks.length, 0);
  let url;
  let downloadId;
  let cleanupTimer;
  let finished = false;

  function finish(message, ok = false) {
    if (finished) return;
    finished = true;
    saving = false;
    clearTimeout(cleanupTimer);
    chrome.downloads.onChanged.removeListener(changed);
    if (url) URL.revokeObjectURL(url);
    ui.start.disabled = ui.csv.disabled = ui.json.disabled = false;
    resultStatus.textContent = message;
    console.info('todo-export', ok ? 'saved' : 'save-failed', count);
  }

  function changed(delta) {
    if (downloadId === undefined || delta.id !== downloadId || !delta.state) return;
    const state = delta.state.current;
    if (state === 'complete' || state === 'interrupted') {
      finish(state === 'complete' ? `已保存 ${filename}` : `下载中断，可重新下载 ${format.toUpperCase()}。`, state === 'complete');
    }
  }

  try {
    console.info('todo-export', `build-${format}`, count);
    resultStatus.textContent = `正在生成 ${format.toUpperCase()}…`;
    url = URL.createObjectURL(await buildExportBlob(snapshot, format));
    chrome.downloads.onChanged.addListener(changed);
    console.info('todo-export', `download-${format}`, count);
    resultStatus.textContent = `正在下载 ${format.toUpperCase()}…`;
    downloadId = await chrome.downloads.download({url, filename, conflictAction: 'uniquify'});
    cleanupTimer = setTimeout(() => finish('下载未在规定时间内完成，请查看 Chrome 下载列表。'), 300000);
    const [item] = await chrome.downloads.search({id: downloadId});
    if (item) changed({id: downloadId, state: {current: item.state}});
  } catch {
    finish(`保存失败，可重新下载 ${format.toUpperCase()}。`);
  }
}

ui.start.addEventListener('click', startRead);
ui.cancel.addEventListener('click', cancelRead);
ui.csv.addEventListener('click', () => save('csv'));
ui.json.addEventListener('click', () => save('json'));
window.addEventListener('pagehide', cancelRead);
