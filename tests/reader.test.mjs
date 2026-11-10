import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('../reader.js', import.meta.url), 'utf8');

async function readFixture({scope = 'all', count = 2, completedFrom = count, expectedOpen = completedFrom,
  retryLastTask = false, cancelOnPace = false} = {}) {
  const location = {pathname: '/tasks/id/previous'};
  let taskId = 'previous';
  let paneVisible = false;
  let closes = 0;
  let now = 0;
  let expansions = 0;
  let expanded = false;
  let failed = false;
  let disconnect;
  const actions = [];
  const lookUp = elements => selector => elements[selector] ?? null;
  const checkbox = value => ({matches: () => false, getAttribute: () => String(value)});
  const close = {
    getClientRects: () => paneVisible ? [{}] : [],
    click() {
      assert.ok(paneVisible, 'the cached close button must not be clicked');
      closes++;
      actions.push({type: 'close', id: taskId, time: now});
      location.pathname = `/tasks/id/${taskId}`;
      paneVisible = false;
    },
  };
  const pane = {
    closest: () => paneVisible ? null : {},
    querySelector(selector) {
      return lookUp({
        '.detailHeader': {getClientRects: close.getClientRects},
        '.detailNote .ql-editor': {classList: {contains: () => false}, innerText: `note for ${taskId}`},
        '.steps': {querySelectorAll: () => []},
      })(selector);
    },
    querySelectorAll: () => [],
  };
  const rows = Array.from({length: count}, (_, index) => {
    const id = ['first', 'second'][index] ?? `task-${index}`;
    const parent = {querySelector: lookUp({
      '[id$="_markTaskAsComplete"] [role="checkbox"]': checkbox(index >= completedFrom),
      '[id$="_importance"] [role="checkbox"]': checkbox(false),
    })};
    return {
      id: `${id}_title`, isConnected: true,
      closest: () => parent,
      querySelector: lookUp({
        '.show-ellipsis': {innerText: id},
        'button.icon-wrapper': {isConnected: true, click() {
          actions.push({type: 'open', id, time: now});
          if (retryLastTask && index === count - 1 && !failed) {
            failed = true;
            return;
          }
          location.pathname = `/tasks/id/${id}/details`;
          // The previous task's cached pane can still be present on the first poll.
          queueMicrotask(() => { taskId = id; paneVisible = true; });
        }},
      }),
    };
  });
  const label = {nextElementSibling: {innerText: String(count - completedFrom)}};
  const toggle = {
    isConnected: true,
    getClientRects: () => [{}],
    getAttribute: () => String(expanded),
    closest: () => ({querySelector: lookUp({'#completed_tasks-label': label})}),
    click() { expanded = true; expansions++; actions.push({type: 'expand', time: now}); },
  };
  const root = {
    isConnected: true, scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    getBoundingClientRect: () => ({top: 0}),
    querySelector: lookUp({'[role="grid"] .grid-body': {},
      '#completed_tasks-label': completedFrom < count ? label : null}),
    querySelectorAll(selector) {
      if (selector === '.grid-row [id$="_title"]') return expanded ? rows : rows.slice(0, completedFrom);
      if (selector.includes('openCloseArrow') && completedFrom < count && !expanded) return [toggle];
      return [];
    },
  };
  const item = {id: 'inbox', querySelector: lookUp({'.listItem-title': {innerText: 'Tasks'}})};
  const list = {
    matches: () => true,
    querySelector: lookUp({':scope > .listItem[id]': item, '.listItem-count': {innerText: String(expectedOpen)}}),
  };
  const document = {
    getElementById: id => id === 'baseAddInput-addTask-inbox' ? {} : null,
    querySelector: lookUp({
      '.sidebar-content ul.lists': {querySelectorAll: () => []},
      '.centerColumn-item.grid-view': root,
      '.details .detailFooter-close': close,
      '.detailFooter-close': close,
      '.details:not(.detailsShimmer)': pane,
      '.details .detailHeader': {}, // It remains in the DOM even after closing.
    }),
    querySelectorAll: () => [list],
  };

  let connect;
  runInNewContext(source, {
    AbortController, document, location,
    Date: {now: () => now},
    performance: {now: () => now},
    setTimeout(callback, ms) {
      const timer = {active: true};
      queueMicrotask(() => {
        if (!timer.active) return;
        if (cancelOnPace && actions.length === 1 && ms > 500 && ms <= 1000) disconnect();
        if (timer.active) { now += ms; callback(); }
      });
      return timer;
    },
    clearTimeout(timer) { timer.active = false; },
    chrome: {runtime: {id: 'test', onConnect: {addListener(fn) { connect = fn; }}}},
  });
  let receive;
  const messages = [];
  const batches = [];
  connect({
    name: 'todo-export', sender: {id: 'test'},
    onDisconnect: {addListener(fn) { disconnect = fn; }},
    onMessage: {addListener(fn) { receive = fn; }},
    postMessage(message) {
      messages.push(message);
      if (message.type === 'batch') {
        batches.push({size: message.tasks.length, actionsBeforeAck: actions.length});
        void receive({type: 'ack', sequence: message.sequence});
      }
    },
  });
  await receive({type: 'start', scope, intervalMs: 1000});
  return {messages: JSON.parse(JSON.stringify(messages)), actions, closes, expansions, paneVisible, batches};
}

test('reads successive tasks when To Do retains the closed detail pane', async () => {
  const {messages, closes, paneVisible, actions} = await readFixture();
  const result = messages.at(-1);
  assert.equal(result.type, 'done', result.message);
  assert.deepEqual(messages.find(message => message.type === 'batch').tasks.map(task => [task.id, task.notes]), [
    ['first', 'note for first'], ['second', 'note for second'],
  ]);
  assert.equal(closes, 2);
  assert.equal(paneVisible, false);
  assert.ok(actions.slice(1).every(({time}, index) => time - actions[index].time >= 1000));
});

test('completion filters skip unmatched details and only validate the selected count', async () => {
  const open = await readFixture({scope: 'open', completedFrom: 1});
  assert.equal(open.messages.at(-1).count, 1);
  assert.equal(open.expansions, 0);
  assert.deepEqual(open.actions.filter(action => action.type === 'open').map(action => action.id), ['first']);

  const done = await readFixture({scope: 'completed', completedFrom: 1, expectedOpen: 42});
  assert.equal(done.messages.at(-1).count, 1);
  assert.equal(done.expansions, 1);
  assert.deepEqual(done.actions.filter(action => action.type === 'open').map(action => action.id), ['second']);
  const all = await readFixture({completedFrom: 1});
  assert.equal(all.messages.at(-1).count, 2);
  assert.equal(all.expansions, 1);
  const empty = await readFixture({scope: 'completed'});
  assert.equal(empty.messages.at(-1).count, 0);
  assert.equal(empty.messages.find(message => message.type === 'list-end').size, 0);
  assert.deepEqual(empty.actions, []);
});

test('cancel during the pacing delay prevents the next action', async () => {
  const {actions, messages} = await readFixture({cancelOnPace: true});
  assert.deepEqual(actions.map(action => action.type), ['open']);
  assert.ok(!messages.some(message => ['done', 'error', 'batch'].includes(message.type)));
});

test('a failed attempt is reset after an acknowledged batch', async () => {
  const {messages, batches} = await readFixture({count: 25, retryLastTask: true});
  assert.deepEqual(batches.map(batch => batch.size), [24, 24, 1]);
  assert.equal(batches[0].actionsBeforeAck, 48);
  const retry = messages.findLastIndex(message => message.type === 'list-start');
  assert.equal(messages[retry].retry, true);
  assert.equal(messages.at(-1).count, 25);
  const committed = messages.slice(retry).flatMap(message => message.tasks ?? []);
  assert.equal(new Set(committed.map(task => task.id)).size, 25);
});
