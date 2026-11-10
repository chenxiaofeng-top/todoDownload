export const CSV_HEADERS = [
  '清单', '标题', '已完成', '重要', '截止日期', '备注', '子步骤',
];

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^(?:[\t\r\n]|\s*[=+\-@＝＋－＠])/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvRow(row) {
  return `${row.map(csvCell).join(',')}\r\n`;
}

function* csvParts({lists}) {
  yield `\uFEFF${csvRow(CSV_HEADERS)}`;
  for (const {name, tasks} of lists) {
    for (const task of tasks) {
      yield csvRow([
        name,
        task.title,
        task.completed ? '是' : '否',
        task.important ? '是' : '否',
        task.dueDate,
        task.notes,
        task.steps.map(step => `${step.completed ? '[x]' : '[ ]'} ${step.title}`).join('\n'),
      ]);
    }
  }
}

function* jsonParts({version, exportedAt, lists}) {
  yield `{\n  "version": ${JSON.stringify(version)},\n  "exportedAt": ${JSON.stringify(exportedAt)},\n  "lists": [`;
  for (const [index, {id, name, tasks}] of lists.entries()) {
    yield `${index ? ',' : ''}\n    {\n      "id": ${JSON.stringify(id)},\n      "name": ${JSON.stringify(name)},\n      "tasks": [`;
    for (const [offset, task] of tasks.entries()) {
      const json = JSON.stringify(task, null, 2).replaceAll('\n', '\n        ');
      yield `${offset ? ',' : ''}\n        ${json}`;
    }
    yield `${tasks.length ? '\n      ' : ''}]\n    }`;
  }
  yield `${lists.length ? '\n  ' : ''}]\n}\n`;
}

export function toCsv(snapshot) {
  return [...csvParts(snapshot)].join('');
}

export function toJson(snapshot) {
  return [...jsonParts(snapshot)].join('');
}

export async function buildExportBlob(snapshot, format) {
  const csv = format === 'csv';
  const type = csv ? 'text/csv;charset=utf-8' : 'application/json';
  const parts = [];
  let buffer = [];
  let length = 0;
  for (const part of (csv ? csvParts(snapshot) : jsonParts(snapshot))) {
    buffer.push(part);
    length += part.length;
    if (length >= 128 * 1024) {
      parts.push(new Blob(buffer));
      buffer = [];
      length = 0;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return new Blob([...parts, ...buffer], {type});
}

export function createSnapshot(lists, now = new Date()) {
  return {version: 1, exportedAt: now.toISOString(), lists};
}

export function exportName(date, format) {
  const pad = number => String(number).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `microsoft-todo-${day}-${time}.${format}`;
}
