import {buildExportBlob, createSnapshot, exportName} from './export.mjs';
import {sanitizeDiagnostic} from './diagnostics.mjs';

const TODO_HOME = 'https://to-do.live.com/tasks/inbox';
const TODO_ORIGIN = new URL(TODO_HOME).origin;
const LOGIN_HOSTS = new Set(['login.live.com', 'login.microsoftonline.com', 'login.microsoft.com', 'account.live.com']);
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]));
let currentRun;
let snapshot;
let saving = false;
const pendingDiagnostics = new Set();

const intervalPreference = 'todo-export-interval';
function updateIntervalValidity() {
  const intervalMs = ui.interval.valueAsNumber;
  ui.interval.setCustomValidity(intervalMs > 0 && intervalMs < 250 ? '请输入 0 或 250–10000 之间的整数。' : '');
}

ui.interval.value = localStorage.getItem(intervalPreference) ?? '1000';
updateIntervalValidity();
if (!ui.interval.validity.valid) {
  ui.interval.value = '1000';
  updateIntervalValidity();
}
ui.interval.addEventListener('input', updateIntervalValidity);
ui.interval.addEventListener('change', () => {
  updateIntervalValidity();
  if (ui.interval.validity.valid) localStorage.setItem(intervalPreference, ui.interval.value);
});

function stage(run, name, label, {count = run.count, code, expected, observed, errorType} = {}) {
  if (label) run.lastStage = label;
  console.info('todo-export', name, count, run.intervalMs, run.scope, run.listIndex, run.retries, code, expected, observed);
  recordStage(run, name, {count, code, expected, observed, errorType});
}

function recordStage(run, name, details) {
  const event = sanitizeDiagnostic({
    time: new Date().toISOString(), runId: run.id, stage: name, previousStage: run.phase,
    count: run.count, scope: run.scope, intervalMs: run.intervalMs, listIndex: run.listIndex, retries: run.retries,
    ...details,
  });
  if (!['list-error', 'read-error', 'failed', 'cancelled', 'save-failed'].includes(name)) run.phase = name;
  const write = appendDiagnostic(event).finally(() => pendingDiagnostics.delete(write));
  pendingDiagnostics.add(write);
}

async function appendDiagnostic(event) {
  try {
    const response = await chrome.runtime.sendMessage({type: 'diagnostic:append', event});
    if (!response?.ok) throw new Error();
  } catch {
    ui['diagnostic-warning'].hidden = false;
  }
}

async function downloadDiagnostics() {
  const button = ui['download-diagnostics'];
  const status = ui['diagnostic-status'];
  button.disabled = true;
  status.textContent = '正在读取诊断日志…';
  try {
    await Promise.all(pendingDiagnostics);
    const response = await chrome.runtime.sendMessage({type: 'diagnostic:read'});
    if (!response?.ok) throw new Error();
    if (!response.events.length) {
      status.textContent = '暂无诊断日志，请先复现导出问题。';
      return;
    }
    const now = new Date();
    const report = {
      version: 1, extensionVersion: chrome.runtime.getManifest().version,
      exportedAt: now.toISOString(), events: response.events,
    };
    const filename = exportName(now, 'json').replace('microsoft-todo-', 'microsoft-todo-diagnostics-');
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(report, null, 2))}`;
    try {
      await chrome.downloads.download({url, filename, conflictAction: 'uniquify'});
      status.textContent = '已发起诊断日志下载，可在 Chrome 下载列表查看。';
    } catch {
      status.textContent = '无法启动诊断日志下载，请重试。';
    }
  } catch {
    status.textContent = '无法读取诊断日志，请重试。';
  } finally {
    button.disabled = false;
  }
}

function codedError(message, code, expected, observed) {
  return Object.assign(new Error(message), {code, expected, observed});
}

function failureDetails(error) {
  return {code: error?.code ?? 'UNKNOWN', errorType: error?.name, expected: error?.expected, observed: error?.observed};
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
    throw codedError(`读取标签页已关闭（最后阶段：${run.lastStage}）。请重新读取。`, 'TAB_CLOSED');
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
    if (Date.now() - loadingSince > 30000) throw codedError('To Do 页面加载超时，请检查网络后重新读取。', 'PAGE_TIMEOUT');
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
    const handshake = setTimeout(() => finish(reject, codedError(
      `未能连接 To Do 页面（最后阶段：${run.lastStage}）。`, 'CONNECT_TIMEOUT')), 5000);
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
          case 'ready':
            recordStage(run, 'discover');
            break;
          case 'list-start':
            if (message.index !== lists.length + 1) {
              throw codedError('清单接收顺序异常。', 'LIST_ORDER', lists.length + 1, message.index);
            }
            run.listIndex = message.index;
            run.retries = Number(message.retry);
            run.count = message.count;
            draft = {...message.list, tasks: []};
            showProgress({...message, list: draft.name});
            stage(run, message.retry ? 'retry' : 'scan', `读取清单 ${message.index}/${message.total}`);
            lastLogged = performance.now();
            break;
          case 'progress':
            run.count = message.count;
            showProgress(message);
            if (performance.now() - lastLogged >= 5000) {
              stage(run, 'scan');
              lastLogged = performance.now();
            }
            break;
          case 'list-error':
            run.listIndex = message.index;
            run.retries = message.retries;
            run.count = message.count;
            stage(run, 'list-error', undefined, {code: message.code ?? 'UNKNOWN', expected: message.expected, observed: message.observed});
            break;
          case 'batch':
            if (!draft || message.sequence !== sequence + 1) {
              throw codedError('任务批次接收顺序异常。', 'BATCH_ORDER', sequence + 1, message.sequence);
            }
            sequence++;
            for (const task of message.tasks) draft.tasks.push(task);
            port.postMessage({type: 'ack', sequence});
            break;
          case 'list-end':
            if (message.index !== lists.length + 1) {
              throw codedError('清单接收顺序异常。', 'LIST_ORDER', lists.length + 1, message.index);
            }
            if (!draft || draft.tasks.length !== message.size) {
              throw codedError('清单接收数量不符。', 'LIST_TRANSFER_COUNT', message.size, draft?.tasks.length);
            }
            lists.push(draft);
            count += message.size;
            run.count = count;
            stage(run, 'scan');
            draft = undefined;
            break;
          case 'done':
            if (draft || lists.length !== message.total) {
              throw codedError('导出接收清单数不符。', 'TOTAL_TRANSFER_COUNT', message.total, lists.length);
            }
            if (count !== message.count) {
              throw codedError('导出接收任务数不符。', 'TOTAL_TRANSFER_COUNT', message.count, count);
            }
            finish(resolve, {lists, count});
            break;
          case 'error':
            finish(reject, codedError(message.message, message.code, message.expected, message.observed));
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
      run.listIndex = run.retries = undefined;
      run.count = 0;
      run.lastStage = '识别清单';
      console.info('todo-export', 'discover', undefined, run.intervalMs, run.scope);
      recordStage(run, 'inject');
      say('正在识别清单…');
      ui.progress.removeAttribute('value');
      try {
        await chrome.scripting.executeScript({target: {tabId: run.tabId}, files: ['reader.js']});
      } catch {
        throw Object.assign(new Error('无法读取 To Do 页面，请确认扩展具有该网站的访问权限。'), {code: 'NOT_READY'});
      }
      recordStage(run, 'connect');
      return await readTab(run);
    } catch (error) {
      if (!run.controller.signal.aborted) recordStage(run, 'read-error', failureDetails(error));
      login = false;
      // A navigation can disconnect the port just before the login URL is visible.
      const checks = ['DISCONNECTED', 'CONNECT_TIMEOUT', 'NOT_READY'].includes(error.code) ? 5 : 1;
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
  const run = {
    id: crypto.randomUUID(), controller: new AbortController(),
    scope: ui.scope.value, intervalMs: ui.interval.valueAsNumber, count: 0,
  };
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
  stage(run, 'open', '打开读取标签页');

  try {
    const current = await chrome.windows.getCurrent();
    checkCancelled(run);
    const tab = await chrome.tabs.create({url: TODO_HOME, windowId: current.id});
    run.tabId = tab.id;
    const {lists, count} = await collect(run);
    checkCancelled(run);
    snapshot = {
      data: createSnapshot(lists),
      run: {id: run.id, scope: run.scope, intervalMs: run.intervalMs, count, phase: 'ready', attempts: 0},
    };
    stage(run, 'ready', undefined, {count});
    say(`读取完成，共 ${lists.length} 个清单、${count} 条任务。`);
    ui.downloads.hidden = false;
    ui.start.textContent = '重新读取';
  } catch (error) {
    const cancelled = run.controller.signal.aborted;
    if (cancelled) {
      stage(run, 'cancelled');
    } else {
      stage(run, 'failed', undefined, failureDetails(error));
    }
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
  const {data, run: sourceRun} = snapshot;
  const filename = exportName(new Date(data.exportedAt), format);
  const {count} = sourceRun;
  const attempt = ++sourceRun.attempts;
  const run = {...sourceRun};
  let url;
  let downloadId;
  let cleanupTimer;
  let finished = false;
  let checkingInterrupt = false;
  let interruptReason;
  let failureCode = 'BUILD_FAILED';

  function finish(message, {code, errorType, interruptReason} = {}) {
    if (finished) return;
    finished = true;
    saving = false;
    clearTimeout(cleanupTimer);
    chrome.downloads.onChanged.removeListener(changed);
    if (url) URL.revokeObjectURL(url);
    ui.start.disabled = ui.csv.disabled = ui.json.disabled = false;
    resultStatus.textContent = message;
    console.info('todo-export', code ? 'save-failed' : 'saved', count, undefined, undefined,
      undefined, undefined, code, undefined, undefined, format);
    recordStage(run, code ? 'save-failed' : 'saved', {format, attempt, code, errorType, interruptReason});
  }

  function finishInterrupted() {
    finish(`下载中断，可重新下载 ${format.toUpperCase()}。`, {code: 'DOWNLOAD_INTERRUPTED', interruptReason});
  }

  async function changed(delta) {
    if (downloadId === undefined || delta.id !== downloadId || finished) return;
    interruptReason = delta.error?.current ?? interruptReason;
    if (delta.state?.current === 'complete') return finish(`已保存 ${filename}`);
    if (checkingInterrupt && interruptReason) return finishInterrupted();
    if (delta.state?.current !== 'interrupted' || checkingInterrupt) return;
    checkingInterrupt = true;
    if (!interruptReason) {
      try {
        const [item] = await chrome.downloads.search({id: downloadId});
        interruptReason ??= item?.error;
      } catch {
        // The interrupted state is still known when Chrome cannot look up the reason.
      }
    }
    finishInterrupted();
  }

  try {
    console.info('todo-export', `build-${format}`, count);
    recordStage(run, `build-${format}`, {format, attempt});
    resultStatus.textContent = `正在生成 ${format.toUpperCase()}…`;
    const blob = await buildExportBlob(data, format);
    url = URL.createObjectURL(blob);
    failureCode = 'DOWNLOAD_START_FAILED';
    chrome.downloads.onChanged.addListener(changed);
    console.info('todo-export', `download-${format}`, count);
    recordStage(run, `download-${format}`, {format, attempt, bytes: blob.size});
    resultStatus.textContent = `正在下载 ${format.toUpperCase()}…`;
    downloadId = await chrome.downloads.download({url, filename, conflictAction: 'uniquify'});
    cleanupTimer = setTimeout(() => {
      if (checkingInterrupt) finishInterrupted();
      else finish('下载未在规定时间内完成，请查看 Chrome 下载列表。', {code: 'DOWNLOAD_TIMEOUT'});
    }, 300000);
    failureCode = 'DOWNLOAD_STATUS_FAILED';
    const [item] = await chrome.downloads.search({id: downloadId});
    if (finished) return;
    interruptReason ??= item?.error;
    if (item?.state === 'complete') finish(`已保存 ${filename}`);
    if (item?.state === 'interrupted' && (!checkingInterrupt || interruptReason)) finishInterrupted();
  } catch (error) {
    if (!checkingInterrupt) {
      finish(`保存失败，可重新下载 ${format.toUpperCase()}。`, {code: failureCode, errorType: error?.name});
    }
  }
}

ui.start.addEventListener('click', startRead);
ui.cancel.addEventListener('click', cancelRead);
ui.csv.addEventListener('click', () => save('csv'));
ui.json.addEventListener('click', () => save('json'));
ui['download-diagnostics'].addEventListener('click', downloadDiagnostics);
window.addEventListener('pagehide', cancelRead);
