import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('../reader.js', import.meta.url), 'utf8');

async function readFixture({scope = 'all', count = 2, completedFrom = count, expectedOpen = completedFrom,
  retryLastTask = false, cancelOnPace = false, virtualize = false, intervalMs = 1000,
  listIds = ['inbox'], layout = id => ({id, type: 'grid'}), initialRows = count, appendDelay = Infinity,
  cancelWhileWaiting = false} = {}) {
  const location = {pathname: '/tasks/id/previous'};
  let taskId = 'previous';
  let paneVisible = false;
  let closes = 0;
  let now = 0;
  let expansions = 0;
  let expanded = false;
  let failed = false;
  let disconnect;
  let scrollTop = 0;
  let mounted = [];
  let available = initialRows;
  let atBottomSince = Infinity;
  let selectedList = 'inbox';
  let previousList;
  let selectedAt = 0;
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
      if (virtualize) mountRows();
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
  function makeRow(index) {
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
  }
  const rows = Array.from({length: count}, (_, index) => makeRow(index));
  const visibleCount = () => expanded ? available : Math.min(available, completedFrom);
  function mountRows() {
    for (const row of mounted) row.isConnected = false;
    const firstVisible = Math.floor(scrollTop / 40);
    const firstMounted = Math.max(0, firstVisible - 10);
    const end = Math.min(visibleCount(), firstVisible + 20);
    mounted = Array.from({length: end - firstMounted}, (_, i) => makeRow(firstMounted + i));
  }
  if (virtualize) mountRows();
  const label = {nextElementSibling: {innerText: String(count - completedFrom)}};
  const toggle = {
    isConnected: true,
    getClientRects: () => [{}],
    getAttribute: () => String(expanded),
    closest: () => ({querySelector: lookUp({'#completed_tasks-label': label})}),
    click() {
      expanded = true;
      expansions++;
      actions.push({type: 'expand', time: now});
      if (virtualize) mountRows();
    },
  };
  const root = {
    isConnected: true,
    get scrollHeight() { return virtualize ? visibleCount() * 40 : 100; },
    clientHeight: virtualize ? 400 : 100,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) {
      scrollTop = value;
      if (available < count && visibleCount() === available && value >= this.scrollHeight - this.clientHeight) {
        atBottomSince = Math.min(atBottomSince, now);
      }
      if (virtualize) mountRows();
    },
    getBoundingClientRect: () => ({top: 0}),
    querySelector: lookUp({'[role="grid"] .grid-body': {},
      '#completed_tasks-label': completedFrom < count ? label : null}),
    querySelectorAll(selector) {
      if (selector === '.grid-row [id$="_title"]') {
        if (virtualize) return mounted;
        return expanded ? rows : rows.slice(0, completedFrom);
      }
      if (selector.includes('openCloseArrow') && completedFrom < count && !expanded) return [toggle];
      return [];
    },
  };
  const lists = listIds.map(id => {
    const item = {id, querySelector: lookUp({'.listItem-title': {innerText: id}}), click() {
      previousList = selectedList;
      selectedList = id;
      selectedAt = now;
    }};
    return {
      matches: () => selectedList === id,
      getAttribute: () => null,
      querySelector: lookUp({':scope > .listItem[id]': item,
        '.listItem-count': expectedOpen === null ? null : {innerText: String(expectedOpen)}}),
    };
  });
  const currentLayout = () => layout(selectedList, previousList, now - selectedAt);
  const inputs = new Map(listIds.map(id => {
    const pane = {
      isConnected: true,
      matches: selector => selector === '.main-background' && currentLayout().type !== 'unknown',
      get childElementCount() { return currentLayout().type === 'empty' ? 1 : 2; },
    };
    return [id, {closest: lookUp({'.addToTop.centerColumn-item': {parentElement: pane}})}];
  }));
  const document = {
    getElementById(id) {
      const renderedList = currentLayout().id;
      return id === `baseAddInput-addTask-${renderedList}` ? inputs.get(renderedList) : null;
    },
    querySelector: selector => lookUp({
      '.sidebar-content ul.lists': {querySelectorAll: () => []},
      '.centerColumn-item.grid-view': currentLayout().type === 'grid' ? root : null,
      '.details .detailFooter-close': close,
      '.detailFooter-close': close,
      '.details:not(.detailsShimmer)': pane,
      '.details .detailHeader': {}, // It remains in the DOM even after closing.
    })(selector),
    querySelectorAll: () => lists,
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
        if (cancelWhileWaiting && ms === 240 && now - atBottomSince >= 960 && available < count) disconnect();
        if (timer.active) {
          now += ms;
          if (available < count && now - atBottomSince >= appendDelay && Number.isFinite(appendDelay)) {
            available = count;
            mountRows();
          }
          callback();
        }
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
  await receive({type: 'start', scope, intervalMs});
  return {messages: JSON.parse(JSON.stringify(messages)), actions, closes, expansions, paneVisible, batches, now};
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

test('zero interval reads the same tasks without delaying consecutive actions', async () => {
  const fast = await readFixture({intervalMs: 0});
  const paced = await readFixture();
  assert.equal(fast.messages.at(-1).type, 'done', fast.messages.at(-1).message);
  assert.deepEqual(fast.messages.filter(message => message.type === 'batch'),
    paced.messages.filter(message => message.type === 'batch'));
  assert.deepEqual(fast.actions.map(({type, id}) => ({type, id})),
    paced.actions.map(({type, id}) => ({type, id})));
  assert.ok(fast.actions.every(({time}) => time === fast.actions[0].time));
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

for (const [scope, taskIds] of [['all', ['first', 'second']], ['open', ['first']], ['completed', ['second']]]) {
  test(`reads past an empty pane and waits for the next list to load (${scope})`, async () => {
    const {messages} = await readFixture({
      scope, listIds: ['inbox', 'empty', 'slow'], completedFrom: 1, expectedOpen: null, intervalMs: 0,
      layout(id, previous, elapsed) {
        if (id === 'empty') return {id, type: 'empty'};
        if (id === 'slow' && elapsed < 325) return {id: previous, type: 'empty'};
        if (id === 'slow' && elapsed < 455) return {id, type: 'empty'};
        if (id === 'slow' && elapsed < 1200) return {id, type: 'loading'};
        return {id, type: 'grid'};
      },
    });
    const starts = messages.filter(m => m.type === 'list-start');
    const ends = messages.filter(m => m.type === 'list-end');
    assert.deepEqual(starts.map(m => [m.list.id, m.retry]), [['inbox', false], ['empty', false], ['slow', false]]);
    assert.deepEqual(ends.map(m => [m.index, m.size]), [[1, taskIds.length], [2, 0], [3, taskIds.length]]);
    const emptyMessages = messages.slice(messages.indexOf(starts[1]) + 1, messages.indexOf(ends[1]));
    assert.deepEqual(emptyMessages, []);
    const nextMessages = messages.slice(messages.indexOf(starts[2]) + 1, messages.indexOf(ends[2]));
    assert.deepEqual(nextMessages.flatMap(m => m.tasks ?? []).map(task => task.id), taskIds);
    assert.deepEqual(messages.at(-1), {type: 'done', count: 2 * taskIds.length, total: 3});
  });
}

test('finishes successfully when the only list is empty and displays a zero count', async () => {
  const {messages} = await readFixture({count: 0, layout: id => ({id, type: 'empty'})});
  assert.deepEqual(messages.filter(m => m.type !== 'ready').map(m => m.type), ['list-start', 'list-end', 'done']);
  assert.deepEqual(messages.at(-2), {type: 'list-end', index: 1, size: 0});
  assert.deepEqual(messages.at(-1), {type: 'done', count: 0, total: 1});
});

test('unrecognized panes and empty panes with outstanding tasks still time out', async () => {
  for (const [type, expectedOpen] of [['unknown', null], ['empty', 2]]) {
    const {messages} = await readFixture({expectedOpen, layout: id => ({id, type})});
    assert.equal(messages.at(-1).type, 'error');
    assert.equal(messages.at(-1).code, 'LIST_TIMEOUT');
    assert.deepEqual(messages.filter(m => m.type === 'list-error').map(m => m.retries), [0, 1]);
  }
});

test('reads delayed completed tasks within the first attempt', async () => {
  for (const [scope, expected] of [['all', 739], ['completed', 613]]) {
    const {messages} = await readFixture({scope, count: 739, completedFrom: 126, virtualize: true,
      intervalMs: 0, initialRows: 370, appendDelay: 1500});
    assert.deepEqual(messages.at(-1), {type: 'done', count: expected, total: 1});
    assert.ok(!messages.some(m => m.type === 'list-error'));
    const tasks = messages.flatMap(m => m.tasks ?? []);
    assert.equal(tasks.length, expected);
    assert.equal(new Set(tasks.map(task => task.id)).size, expected);
    assert.equal(tasks.filter(task => task.completed).length, 613);
  }
});

test('an unresolved shortfall retries once and still reports the count mismatch', async () => {
  const {messages, now} = await readFixture({count: 22, completedFrom: 0, virtualize: true,
    intervalMs: 0, initialRows: 12});
  assert.deepEqual(messages.filter(m => m.type === 'list-error').map(m => [m.expected, m.observed, m.retries]),
    [[22, 12, 0], [22, 12, 1]]);
  assert.equal(messages.at(-1).type, 'error');
  assert.equal(messages.at(-1).code, 'COMPLETED_COUNT_MISMATCH');
  assert.ok(now >= 24000 && now < 26000);
});

test('cancel while waiting for more rows stops before a retry', async () => {
  const {messages, now} = await readFixture({count: 22, completedFrom: 0, virtualize: true,
    intervalMs: 0, initialRows: 12, cancelWhileWaiting: true});
  assert.equal(messages.filter(m => m.type === 'list-start').length, 1);
  assert.ok(!messages.some(m => ['done', 'error', 'list-error'].includes(m.type)));
  assert.ok(now < 12000);
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

test('reads all 72 tasks when details remount the virtualized grid rows', async () => {
  const {messages, actions} = await readFixture({scope: 'open', count: 72, virtualize: true});
  assert.equal(messages.at(-1).type, 'done', messages.at(-1).message);
  assert.equal(messages.at(-1).count, 72);
  const opened = actions.filter(action => action.type === 'open');
  assert.equal(opened.length, 72);
  assert.equal(new Set(opened.map(action => action.id)).size, 72);
});
