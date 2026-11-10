import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('../reader.js', import.meta.url), 'utf8');

test('reads successive tasks when To Do retains the closed detail pane', async () => {
  const location = {pathname: '/tasks/id/previous'};
  let taskId = 'previous';
  let paneVisible = false;
  let closes = 0;
  let now = 0;
  const lookUp = elements => selector => elements[selector] ?? null;
  const checkbox = {matches: () => false, getAttribute: () => 'false'};
  const close = {
    getClientRects: () => paneVisible ? [{}] : [],
    click() {
      assert.ok(paneVisible, 'the cached close button must not be clicked');
      closes++;
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
  const rows = ['first', 'second'].map(id => {
    const parent = {querySelector: lookUp({
      '[id$="_markTaskAsComplete"] [role="checkbox"]': checkbox,
      '[id$="_importance"] [role="checkbox"]': checkbox,
    })};
    return {
      id: `${id}_title`, isConnected: true,
      closest: () => parent,
      querySelector: lookUp({
        '.show-ellipsis': {innerText: id},
        'button.icon-wrapper': {click() {
          location.pathname = `/tasks/id/${id}/details`;
          // The previous task's cached pane can still be present on the first poll.
          queueMicrotask(() => { taskId = id; paneVisible = true; });
        }},
      }),
    };
  });
  const root = {
    isConnected: true, scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    getBoundingClientRect: () => ({top: 0}),
    querySelector: lookUp({'[role="grid"] .grid-body': {}}),
    querySelectorAll: selector => selector === '.grid-row [id$="_title"]' ? rows : [],
  };
  const item = {id: 'inbox', querySelector: lookUp({'.listItem-title': {innerText: 'Tasks'}})};
  const list = {
    matches: () => true,
    querySelector: lookUp({':scope > .listItem[id]': item, '.listItem-count': {innerText: '2'}}),
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
    setTimeout(callback, ms) { queueMicrotask(() => { now += ms; callback(); }); },
    clearTimeout() {},
    chrome: {runtime: {id: 'test', onConnect: {addListener(fn) { connect = fn; }}}},
  });
  let receive;
  const messages = [];
  connect({
    name: 'todo-export', sender: {id: 'test'},
    onDisconnect: {addListener() {}},
    onMessage: {addListener(fn) { receive = fn; }},
    postMessage(message) { messages.push(message); },
  });
  await receive({type: 'start'});

  const result = JSON.parse(JSON.stringify(messages.at(-1)));
  assert.equal(result.type, 'done', result.message);
  assert.deepEqual(result.lists[0].tasks.map(task => [task.id, task.notes]), [
    ['first', 'note for first'], ['second', 'note for second'],
  ]);
  assert.equal(closes, 2);
  assert.equal(paneVisible, false);
});
