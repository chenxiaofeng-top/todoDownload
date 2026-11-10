import {createSnapshot, exportName, toCsv, toJson} from './export.mjs';

const TODO_HOME = 'https://to-do.live.com/tasks/inbox';
const TODO_ORIGIN = new URL(TODO_HOME).origin;
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
let currentRun;
let snapshot;

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
    throw new Error('读取标签页已关闭，请重新读取。');
  }
}

function onTodo(tab) {
  return tab.url && new URL(tab.url).origin === TODO_ORIGIN;
}

async function waitForTodo(run) {
  const openedAt = Date.now();
  let loadingSince;
  while (true) {
    const tab = await getReaderTab(run);
    if (onTodo(tab)) {
      if (tab.status === 'complete') return;
      loadingSince ??= Date.now();
      if (Date.now() - loadingSince > 30000) {
        throw Object.assign(new Error('To Do 页面加载超时，请检查网络后重新读取。'), {code: 'NOT_READY'});
      }
    } else {
      loadingSince = undefined;
      if (Date.now() - openedAt >= 3000) {
        say('正在等待 Microsoft To Do。若标签页显示登录界面，请手动登录，返回 To Do 后将自动继续。');
      }
    }
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
    let settled = false;
    const handshake = setTimeout(() => finish(reject, Object.assign(new Error('未能连接 To Do 页面。'), {code: 'DISCONNECTED'})), 5000);
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
      const error = new Error('读取连接中断，请重新读取。');
      error.code = 'DISCONNECTED';
      finish(reject, error);
    }
    signal.addEventListener('abort', abort, {once: true});
    port.onDisconnect.addListener(disconnected);
    port.onMessage.addListener(message => {
      clearTimeout(handshake);
      switch (message.type) {
        case 'progress':
          showProgress(message);
          break;
        case 'done':
          finish(resolve, message.lists);
          break;
        case 'error':
          finish(reject, Object.assign(new Error(message.message), {code: message.code}));
          break;
      }
    });
    try {
      port.postMessage({type: 'start'});
    } catch {
      disconnected();
    }
  });
}

async function collect(run) {
  let retried = false;
  while (true) {
    try {
      await waitForTodo(run);
      checkCancelled(run);
      say('正在识别清单…');
      ui.progress.removeAttribute('value');
      try {
        await chrome.scripting.executeScript({target: {tabId: run.tabId}, files: ['reader.js']});
      } catch {
        throw Object.assign(new Error('无法读取 To Do 页面，请确认扩展具有该网站的访问权限。'), {code: 'NOT_READY'});
      }
      return await readTab(run);
    } catch (error) {
      const tab = await getReaderTab(run);
      if (!onTodo(tab)) continue;
      if (retried || !['DISCONNECTED', 'NOT_READY'].includes(error.code)) throw error;
      retried = true;
      say('To Do 页面正在重新加载，正在重试…');
      if (error.code === 'NOT_READY') await chrome.tabs.reload(run.tabId);
      await delay(800, run);
    }
  }
}

async function startRead() {
  if (currentRun) return;
  const run = {controller: new AbortController()};
  currentRun = run;
  snapshot = undefined;
  ui.start.disabled = true;
  ui.cancel.hidden = false;
  ui.downloads.hidden = true;
  ui['download-status'].textContent = '';
  ui.progress.hidden = false;
  ui.progress.removeAttribute('value');
  say('正在打开 To Do 读取标签页…');

  try {
    const current = await chrome.windows.getCurrent();
    checkCancelled(run);
    const tab = await chrome.tabs.create({url: TODO_HOME, windowId: current.id});
    run.tabId = tab.id;
    const lists = await collect(run);
    checkCancelled(run);
    snapshot = createSnapshot(lists);
    const count = lists.reduce((total, list) => total + list.tasks.length, 0);
    say(`读取完成，共 ${lists.length} 个清单、${count} 条任务。`);
    ui.downloads.hidden = false;
    ui.start.textContent = '重新读取';
  } catch (error) {
    say(run.controller.signal.aborted ? '已取消读取。' : `读取失败。${error.message}`);
    ui.start.textContent = '重新读取';
  } finally {
    closeReaderTab(run);
    currentRun = undefined;
    ui.cancel.hidden = true;
    ui.start.disabled = false;
    ui.progress.hidden = true;
  }
}

async function save(format) {
  if (!snapshot) return;
  const resultStatus = ui['download-status'];
  const content = format === 'csv' ? toCsv(snapshot) : toJson(snapshot);
  const type = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
  const url = URL.createObjectURL(new Blob([content], {type}));
  const filename = exportName(new Date(snapshot.exportedAt), format);
  const button = ui[format];
  let downloadId;
  let cleanupTimer;

  function cleanup() {
    clearTimeout(cleanupTimer);
    chrome.downloads.onChanged.removeListener(changed);
    URL.revokeObjectURL(url);
    button.disabled = false;
  }

  function changed(delta) {
    if (downloadId === undefined || delta.id !== downloadId || !delta.state) return;
    const state = delta.state.current;
    if (state === 'complete' || state === 'interrupted') {
      cleanup();
      resultStatus.textContent = state === 'complete' ? `已保存 ${filename}` : `下载中断，可重新下载 ${format.toUpperCase()}。`;
    }
  }

  button.disabled = true;
  chrome.downloads.onChanged.addListener(changed);
  resultStatus.textContent = `正在下载 ${format.toUpperCase()}…`;
  try {
    downloadId = await chrome.downloads.download({url, filename, conflictAction: 'uniquify'});
    cleanupTimer = setTimeout(cleanup, 300000);
    const [item] = await chrome.downloads.search({id: downloadId});
    if (item) changed({id: downloadId, state: {current: item.state}});
  } catch (error) {
    cleanup();
    resultStatus.textContent = `下载失败，可重新下载 ${format.toUpperCase()}。`;
  }
}

ui.start.addEventListener('click', startRead);
ui.cancel.addEventListener('click', cancelRead);
ui.csv.addEventListener('click', () => save('csv'));
ui.json.addEventListener('click', () => save('json'));
window.addEventListener('pagehide', cancelRead);
