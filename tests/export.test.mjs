import assert from 'node:assert/strict';
import test from 'node:test';
import {createSnapshot, exportName, toCsv, toJson} from '../export.mjs';

const task = {
  id: 'task-one',
  title: '中文,"标题"',
  completed: true,
  important: false,
  dueDate: null,
  notes: '第一行\n第二行',
  steps: [{title: '已经完成', completed: true}, {title: '稍后处理', completed: false}],
};

test('CSV preserves commas, quotes, multiline text, flags, and steps', () => {
  const snapshot = createSnapshot([{id: 'inbox', name: '任务', tasks: [task]}]);
  assert.equal(toCsv(snapshot), [
    '\uFEFF"清单","标题","已完成","重要","截止日期","备注","子步骤"',
    '"任务","中文,""标题""","是","否","","第一行\n第二行","[x] 已经完成\n[ ] 稍后处理"',
    '',
  ].join('\r\n'));
});

test('CSV neutralizes formula-like values and JSON retains original text', () => {
  const snapshot = createSnapshot([{id: 'inbox', name: '  =1+1', tasks: [{...task, title: '\ttext', notes: '＠SUM(A1)'}]}]);
  assert.match(toCsv(snapshot), /"'  =1\+1","'\ttext".*"'＠SUM\(A1\)"/);
  assert.deepEqual(JSON.parse(toJson(snapshot)), snapshot);
});

test('JSON retains an empty list and output names share the local timestamp', () => {
  const when = new Date(2026, 0, 2, 3, 4, 5);
  const snapshot = createSnapshot([{id: 'empty', name: '空清单', tasks: []}], when);
  assert.deepEqual(JSON.parse(toJson(snapshot)), {
    version: 1,
    exportedAt: when.toISOString(),
    lists: [{id: 'empty', name: '空清单', tasks: []}],
  });
  assert.equal(exportName(when, 'csv'), 'microsoft-todo-20260102-030405.csv');
  assert.equal(exportName(when, 'json'), 'microsoft-todo-20260102-030405.json');
});
