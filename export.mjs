export const CSV_HEADERS = [
  '清单', '标题', '已完成', '重要', '截止日期', '备注', '子步骤',
];

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^(?:[\t\r\n]|\s*[=+\-@＝＋－＠])/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function toCsv({lists}) {
  const rows = [CSV_HEADERS];
  for (const {name, tasks} of lists) {
    for (const task of tasks) {
      rows.push([
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
  return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function toJson(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
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
