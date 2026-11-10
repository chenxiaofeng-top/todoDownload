import {appendFileSync, mkdirSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const endpoint = 'http://127.0.0.1:9222';
const pid = Number(process.argv[2]);
const startedAt = Date.now();
const stages = new Set(['open', 'login', 'discover', 'scan', 'retry', 'ready', 'failed', 'cancelled',
  'build-csv', 'build-json', 'download-csv', 'download-json', 'saved', 'save-failed']);
const targets = new Map();
const sessions = new Map();
const attaching = new Set();
const pending = new Map();
let socket;
let commandId = 0;
let lastStage;
let lastActiveStage;
let logPath;

function log(event, data = {}) {
  const line = JSON.stringify({time: new Date().toISOString(), event, ...data});
  appendFileSync(logPath, `${line}\n`);
  console.log(line);
}

function recordRequest(target, timestamp) {
  if (!Number.isFinite(timestamp)) return;
  target.requests++;
  // Rolling half-open windows on CDP's monotonic clock. Keep only the last ten seconds.
  target.times = target.times.filter(time => time > timestamp - 10);
  target.times.push(timestamp);
  const lastSecond = target.times.filter(time => time > timestamp - 1).length;
  target.peak1s = Math.max(target.peak1s, lastSecond);
  target.peak10s = Math.max(target.peak10s, target.times.length);
}

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error('CDP closed'));
    const id = ++commandId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP timed out'));
    }, 2000);
    pending.set(id, result => {
      clearTimeout(timer);
      if (result.error) reject(new Error('CDP command failed'));
      else resolve(result.result);
    });
    try {
      socket.send(JSON.stringify({id, method, params, sessionId}));
    } catch {
      pending.get(id)({error: true});
      pending.delete(id);
    }
  });
}

async function attach({targetId, type, url}) {
  if (targets.has(targetId) || attaching.has(targetId)) return;
  const todo = type === 'page' && url.startsWith('https://to-do.live.com/');
  const panel = /^chrome-extension:\/\/[a-p]{32}\/panel\.html$/.test(url);
  if (!todo && !panel) return;
  attaching.add(targetId);
  try {
    const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
    const target = {targetId, sessionId, todo, requests: 0, errors: {}, inflight: new Set(), failed: 0,
      times: [], peak1s: 0, peak10s: 0};
    targets.set(targetId, target);
    sessions.set(sessionId, target);
    log(todo ? 'todo-tab-attached' : 'panel-attached', {targetId});
    if (todo) {
      await send('Network.enable', {maxPostDataSize: 0}, sessionId);
      await send('Performance.enable', {}, sessionId);
    } else {
      await send('Runtime.enable', {}, sessionId);
    }
  } catch {
    log('target-instrumentation-unavailable', {targetId});
  } finally {
    attaching.delete(targetId);
  }
}

function summary(target) {
  const {targetId, requests, peak1s, peak10s, errors, failed} = target;
  return {targetId, requests, peak1s, peak10s, errors, failed};
}

function reportStage(stage, count, options = {}) {
  lastStage = stage;
  if (!['failed', 'cancelled', 'save-failed'].includes(stage)) lastActiveStage = stage;
  log('export-stage', {stage, count: Number.isSafeInteger(count) ? count : undefined, ...options});
}

function onMessage({data}) {
  const message = JSON.parse(data);
  const {id, method, params = {}, sessionId} = message;
  if (id) {
    pending.get(id)?.(message);
    pending.delete(id);
    return;
  }
  const target = sessions.get(sessionId);
  switch (method) {
    case 'Target.targetCreated':
    case 'Target.targetInfoChanged':
      void attach(params.targetInfo);
      break;
    case 'Target.targetCrashed':
      if (targets.has(params.targetId)) {
        log('target-crashed', {...summary(targets.get(params.targetId)), errorCode: params.errorCode, lastStage});
      }
      break;
    case 'Target.targetDestroyed': {
      const closed = targets.get(params.targetId);
      if (!closed) break;
      if (closed.todo) log('todo-tab-closed', {...summary(closed), lastStage});
      sessions.delete(closed.sessionId);
      targets.delete(params.targetId);
      break;
    }
    case 'Runtime.consoleAPICalled': {
      const [marker, stage, count, intervalMs, scope] = (params.args ?? []).map(arg => arg.value);
      if (target && !target.todo && marker === 'todo-export' && stages.has(stage)) {
        target.instrumented = true;
        reportStage(stage, count, {
          intervalMs: Number.isSafeInteger(intervalMs) ? intervalMs : undefined,
          scope: ['all', 'open', 'completed'].includes(scope) ? scope : undefined});
      }
      break;
    }
    case 'Network.requestWillBeSent':
      if (target?.todo && params.request.url.startsWith('https://to-do.live.com/')) {
        target.inflight.add(params.requestId);
        recordRequest(target, params.timestamp);
      }
      break;
    case 'Network.loadingFailed':
      if (target?.inflight.delete(params.requestId) && !params.canceled) target.failed++;
      break;
    case 'Network.loadingFinished':
      target?.inflight.delete(params.requestId);
      break;
    case 'Network.responseReceived': {
      const {status, url} = params.response;
      if (target?.todo && url.startsWith('https://to-do.live.com/') && status >= 400 && status <= 599) {
        target.errors[status] = (target.errors[status] ?? 0) + 1;
      }
      break;
    }
  }
}

// The baseline has no console markers. Extract only stage and count from its panel.
const baselineStatus = `(() => {
  if (document.getElementById('interval')) return null;
  const status = document.getElementById('status')?.textContent ?? '';
  const download = document.getElementById('download-status')?.textContent ?? '';
  if (status.startsWith('读取失败')) return ['failed'];
  if (status.startsWith('已取消')) return ['cancelled'];
  if (status.startsWith('读取完成')) {
    const count = Number(status.match(/、(\\d+) 条任务/)?.[1] ?? 0);
    if (download.startsWith('正在下载 CSV')) return ['download-csv', count];
    if (download.startsWith('正在下载 JSON')) return ['download-json', count];
    if (download.startsWith('已保存')) return ['saved', count];
    if (/^下载(?:失败|中断)/.test(download)) return ['save-failed', count];
    return ['ready', count];
  }
  if (status.startsWith('正在读取') || status.startsWith('正在重试')) {
    return [status.startsWith('正在重试') ? 'retry' : 'scan', Number(status.match(/已读取 (\\d+) 条/)?.[1] ?? 0)];
  }
  if (status.startsWith('正在识别')) return ['discover'];
  if (status.startsWith('正在打开')) return ['open'];
  if (status.startsWith('正在等待')) return ['login'];
  return null;
})()`;

async function sample() {
  for (const target of targets.values()) {
    if (!target.todo) {
      if (!target.instrumented) {
        const status = await send('Runtime.evaluate', {expression: baselineStatus, returnByValue: true}, target.sessionId).catch(() => null);
        const value = status?.result?.value;
        if (Array.isArray(value) && stages.has(value[0]) && String(value) !== target.previousStatus) {
          target.previousStatus = String(value);
          reportStage(value[0], value[1], {baseline: true});
        }
      }
      continue;
    }
    const result = await send('Performance.getMetrics', {}, target.sessionId).catch(() => null);
    if (!targets.has(target.targetId)) continue;
    const heapUsedBytes = result?.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
    log('sample', {...summary(target), heapUsedBytes, lastStage});
  }
}

function browserAlive() {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function crashReports() {
  for (const folder of ['reports', 'pending', 'completed']) {
    const directory = new URL(`./.chrome-debug/Crashpad/${folder}/`, import.meta.url);
    for (const name of readdirSync(directory, {throwIfNoEntry: false}) ?? []) {
      if (!/^[\w-]+\.dmp$/i.test(name)) continue;
      const file = statSync(new URL(name, directory), {throwIfNoEntry: false});
      if (file?.mtimeMs >= startedAt) log('crashpad-report', {modifiedAt: file.mtime.toISOString(), bytes: file.size});
    }
  }
}

async function main() {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Start with start-chrome-debug.ps1 -Diagnose.');
  const response = await fetch(`${endpoint}/json/version`, {signal: AbortSignal.timeout(2000)});
  const {webSocketDebuggerUrl: url} = await response.json();
  if (!/^ws:\/\/127\.0\.0\.1:9222\/devtools\/browser\/[\w-]+$/.test(url)) throw new Error('Unexpected endpoint.');
  const directory = fileURLToPath(new URL('./.todo-diagnostics/', import.meta.url));
  mkdirSync(directory, {recursive: true});
  logPath = join(directory, `chrome-${startedAt}-${process.pid}.jsonl`);
  console.log(`Diagnostic log: ${logPath}`);
  socket = new WebSocket(url);
  socket.addEventListener('message', onMessage);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP handshake timed out')), 3000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, {once: true});
  });

  const stop = new AbortController();
  let interrupted = false;
  socket.addEventListener('close', () => stop.abort(), {once: true});
  process.once('SIGINT', () => { interrupted = true; stop.abort(); });
  log('connected', {pid});
  try {
    await send('Target.setDiscoverTargets', {discover: true});
    while (!stop.signal.aborted) {
      await sleep(2000, undefined, {signal: stop.signal}).catch(() => {});
      if (!stop.signal.aborted) await sample();
    }
  } finally {
    for (const target of targets.values()) if (target.todo) log('final-sample', summary(target));
    socket.close();
    if (!interrupted) {
      for (let attempt = 0; attempt < 10 && browserAlive(); attempt++) await sleep(200);
      log(browserAlive() ? 'cdp-disconnected-browser-alive' : 'browser-process-exited', {pid, lastStage, lastActiveStage});
      crashReports();
    } else {
      log('monitor-stopped', {pid, lastStage});
    }
  }
}

main().catch(() => {
  console.error('CDP monitoring failed. Verify that the project Chrome is running on 127.0.0.1:9222.');
  socket?.close();
  process.exitCode = 1;
});
