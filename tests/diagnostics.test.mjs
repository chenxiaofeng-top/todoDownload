import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
const extensionUrl = 'chrome-extension://test/';
const sender = {id: 'test', url: extensionUrl + 'panel.html'};
const privateText = 'private task at https://example.test/account';
let nextModule = 0;

function browserEvent() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => [...listeners].map(listener => listener(...args)),
    clear: () => listeners.clear(),
  };
}

async function fixture(t) {
  const stored = {};
  const downloads = [];
  const changes = browserEvent();
  const messages = browserEvent();
  const io = {
    download: async () => 11,
    search: async () => [{state: 'complete'}],
    getTab: async () => ({status: 'complete', url: 'https://to-do.live.com/tasks/inbox'}),
  };
  let rejectWrites = false;
  let rejectReads = false;
  let trustedAccess;
  let connected;
  let port;

  function sendMessage(message, from = sender) {
    return new Promise(resolve => {
      const [asyncResponse] = messages.emit(message, from, resolve);
      if (!asyncResponse) resolve();
    });
  }
  const chrome = {
    runtime: {
      id: 'test', getURL: path => extensionUrl + path, getManifest: () => ({version: '1.0.0'}),
      onInstalled: browserEvent(), onMessage: messages, sendMessage,
    },
    storage: {local: {
      async setAccessLevel({accessLevel}) { trustedAccess = accessLevel; },
      async get(key) {
        if (rejectReads) throw new Error(privateText);
        return {[key]: structuredClone(stored[key])};
      },
      async set(update) {
        if (rejectWrites) throw new Error(privateText);
        await new Promise(resolve => setImmediate(resolve));
        Object.assign(stored, structuredClone(update));
      },
    }},
    windows: {getCurrent: async () => ({id: 1})},
    scripting: {executeScript: async () => {}},
    tabs: {
      create: async () => ({id: 2}),
      get: (...args) => io.getTab(...args),
      remove: async () => {},
      connect() { return port; },
    },
    downloads: {
      onChanged: changes,
      search: (...args) => io.search(...args),
      download: async options => {
        downloads.push(options);
        return io.download(options);
      },
    },
  };
  const globals = new Map();
  function setGlobal(name, value) {
    if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {value, configurable: true});
  }
  t.after(() => {
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  t.mock.method(console, 'info', () => {});
  setGlobal('chrome', chrome);
  setGlobal('window', {addEventListener() {}});
  setGlobal('localStorage', {getItem: () => null, setItem() {}});

  async function restartWorker() {
    await sendMessage({type: 'diagnostic:read'});
    messages.clear();
    await import(`../background.js?fixture=${nextModule++}`);
    assert.equal(trustedAccess, 'TRUSTED_CONTEXTS');
  }
  async function openPanel() {
    const ui = Object.fromEntries([...html.matchAll(/id="([^"]+)"/gu)].map(([, id]) => {
      const callbacks = {};
      return [id, {
        id, hidden: id === 'diagnostic-warning', value: 'all', valueAsNumber: 0,
        validity: {valid: true}, reportValidity: () => true, setCustomValidity() {}, removeAttribute() {},
        addEventListener: (type, callback) => { callbacks[type] = callback; },
        click: () => callbacks.click(),
      }];
    }));
    setGlobal('document', {querySelectorAll: () => Object.values(ui)});
    await import(`../panel.js?fixture=${nextModule++}`);
    return ui;
  }
  async function read(ui, steps) {
    port = {
      onMessage: browserEvent(), onDisconnect: browserEvent(),
      disconnect() {},
      postMessage(message) { if (message.type === 'start') connected(); },
    };
    const started = new Promise(resolve => { connected = resolve; });
    const done = ui.start.click();
    await started;
    port.onMessage.emit({type: 'ready'});
    await steps(port);
    await done;
  }
  async function report(ui) {
    await ui['download-diagnostics'].click();
    const file = downloads.at(-1);
    assert.match(file.filename, /^microsoft-todo-diagnostics-\d{8}-\d{6}\.json$/u);
    assert.match(file.url, /^data:application\/json/u);
    return JSON.parse(decodeURIComponent(file.url.split(',')[1]));
  }
  await restartWorker();
  return {
    stored, downloads, changes, io, sendMessage, restartWorker, openPanel, read, report,
    rejectWrites(value) { rejectWrites = value; },
    rejectReads(value) { rejectReads = value; },
  };
}

function listStart(port, retry = false) {
  port.onMessage.emit({type: 'list-start', list: {name: privateText}, index: 1, total: 1, count: 0, retry});
}

function taskSnapshot(port, task) {
  listStart(port);
  port.onMessage.emit({type: 'batch', sequence: 1, tasks: [{title: privateText, notes: privateText, ...task}]});
  port.onMessage.emit({type: 'list-end', index: 1, size: 1});
  port.onMessage.emit({type: 'done', count: 1, total: 1});
}

test('the worker serializes writes, caps the journal, and validates sender and fields', async t => {
  const env = await fixture(t);
  const runId = crypto.randomUUID();
  const otherRun = crypto.randomUUID();
  const request = {type: 'diagnostic:read'};
  const rejected = await env.sendMessage(request, {id: sender.id, url: 'https://to-do.live.com/'});
  assert.equal(rejected, undefined);
  const writes = Array.from({length: 502}, (_, count) => env.sendMessage({
    type: 'diagnostic:append',
    event: {
      time: new Date(502 - count).toISOString(), runId: count % 2 ? otherRun : runId, stage: 'scan',
      count, code: privateText, interruptReason: privateText, errorType: privateText, message: privateText,
    },
  }));
  const queuedRead = env.sendMessage(request);
  assert.ok((await Promise.all(writes)).every(result => result.ok));
  const {events} = await queuedRead;
  assert.equal(events.length, 500);
  assert.equal(events[0].count, 501);
  assert.equal(events.at(-1).count, 2);
  assert.deepEqual(new Set(events.map(event => event.runId)), new Set([runId, otherRun]));
  assert.ok(events.every(event => event.code === 'UNKNOWN'));
  assert.ok(!JSON.stringify(env.stored).includes(privateText));
  await env.restartWorker();
  assert.deepEqual((await env.sendMessage(request)).events, events);
});

test('records retry and transfer counts, and preserves disconnect before a tab lookup fails', async t => {
  const env = await fixture(t);
  const ui = await env.openPanel();
  await env.read(ui, port => {
    listStart(port);
    port.onMessage.emit({type: 'list-error', index: 1, retries: 0, count: 2,
      code: 'OPEN_COUNT_MISMATCH', expected: 3, observed: 2, message: privateText});
    listStart(port, true);
    port.onMessage.emit({type: 'batch', sequence: 1, tasks: [{title: privateText}]});
    port.onMessage.emit({type: 'list-end', index: 1, size: 2});
  });
  await env.read(ui, port => {
    env.io.getTab = async () => { throw new Error(privateText); };
    port.onDisconnect.emit();
  });
  await env.restartWorker();
  const reopened = await env.openPanel();
  const report = await env.report(reopened);
  assert.equal(report.version, 1);
  assert.equal(report.extensionVersion, '1.0.0');
  const {events} = report;
  const listError = events.find(event => event.stage === 'list-error');
  assert.deepEqual([listError.code, listError.expected, listError.observed], ['OPEN_COUNT_MISMATCH', 3, 2]);
  assert.ok(events.some(event => event.runId === listError.runId && event.stage === 'retry' && event.retries === 1));
  const transfer = events.find(event => event.stage === 'read-error' && event.code === 'LIST_TRANSFER_COUNT');
  assert.deepEqual([transfer.runId, transfer.previousStage, transfer.expected, transfer.observed],
    [listError.runId, 'retry', 2, 1]);
  const disconnect = events.find(event => event.code === 'DISCONNECTED');
  assert.equal(disconnect.stage, 'read-error');
  assert.ok(events.some(event => event.runId === disconnect.runId && event.stage === 'failed' && event.code === 'TAB_CLOSED'));
  assert.ok(!JSON.stringify(report).includes(privateText));
  assert.ok(!JSON.stringify(env.stored).includes(privateText));
});

test('records file generation, Chrome download failures and interruption reasons by attempt', async t => {
  const env = await fixture(t);
  const ui = await env.openPanel();
  const schedule = setTimeout;
  let expireDownload;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 300000) expireDownload = () => callback(...args);
    return schedule(callback, delay, ...args);
  });
  await env.read(ui, port => taskSnapshot(port));
  await ui.csv.click();
  env.io.download = async options => {
    if (options.url.startsWith('blob:')) throw new Error(privateText);
    return 11;
  };
  await ui.json.click();
  env.io.download = async () => 11;
  env.io.search = async () => [{state: 'interrupted', error: 'FILE_NO_SPACE'}];
  await ui.json.click();
  env.io.search = async () => [{state: 'in_progress'}];
  await ui.json.click();
  await Promise.all(env.changes.emit({id: 11, error: {current: 'USER_CANCELED'}}));
  await Promise.all(env.changes.emit({id: 11, state: {current: 'interrupted'}}));
  env.io.search = async () => [{state: 'in_progress'}];
  await ui.json.click();
  env.io.search = async () => [{state: 'interrupted', error: 'FILE_ACCESS_DENIED'}];
  await Promise.all(env.changes.emit({id: 11, state: {current: 'interrupted'}}));
  env.io.search = async () => { throw new Error(privateText); };
  await ui.json.click();
  env.io.search = async () => [{state: 'in_progress'}];
  await ui.json.click();
  expireDownload();
  env.io.search = async () => [{state: 'complete'}];
  await ui.json.click();
  const report = await env.report(ui);
  assert.equal(new Set(report.events.map(event => event.runId)).size, 1);
  assert.deepEqual(report.events.filter(event => ['save-failed', 'saved'].includes(event.stage))
    .map(({attempt, format, code, previousStage, interruptReason}) => [attempt, format, code, previousStage, interruptReason]), [
    [1, 'csv', 'BUILD_FAILED', 'build-csv', undefined],
    [2, 'json', 'DOWNLOAD_START_FAILED', 'download-json', undefined],
    [3, 'json', 'DOWNLOAD_INTERRUPTED', 'download-json', 'FILE_NO_SPACE'],
    [4, 'json', 'DOWNLOAD_INTERRUPTED', 'download-json', 'USER_CANCELED'],
    [5, 'json', 'DOWNLOAD_INTERRUPTED', 'download-json', 'FILE_ACCESS_DENIED'],
    [6, 'json', 'DOWNLOAD_STATUS_FAILED', 'download-json', undefined],
    [7, 'json', 'DOWNLOAD_TIMEOUT', 'download-json', undefined],
    [8, 'json', undefined, 'download-json', undefined],
  ]);
  assert.ok(!JSON.stringify(report).includes(privateText));
  assert.ok(!JSON.stringify(env.stored).includes(privateText));
});

test('diagnostics remain separate from task export and recover after storage failures', async t => {
  const env = await fixture(t);
  const ui = await env.openPanel();
  await ui['download-diagnostics'].click();
  assert.match(ui['diagnostic-status'].textContent, /暂无诊断日志/u);
  assert.equal(env.downloads.length, 0);

  env.rejectWrites(true);
  await env.read(ui, port => taskSnapshot(port, {steps: []}));
  await ui.csv.click();
  await ui['download-diagnostics'].click();
  assert.match(ui['download-status'].textContent, /已保存/u);
  assert.equal(ui['diagnostic-warning'].hidden, false);

  env.rejectWrites(false);
  await ui.json.click();
  await env.sendMessage({type: 'diagnostic:read'});
  env.rejectReads(true);
  await ui['download-diagnostics'].click();
  assert.match(ui['diagnostic-status'].textContent, /无法读取/u);
  env.rejectReads(false);
  env.io.download = async () => { throw new Error(privateText); };
  await ui['download-diagnostics'].click();
  assert.match(ui['diagnostic-status'].textContent, /无法启动/u);
  env.io.download = async () => 11;
  const report = await env.report(ui);
  assert.ok(report.events.some(event => event.stage === 'saved' && event.attempt === 2));
  assert.equal(ui['download-diagnostics'].disabled, false);
});
