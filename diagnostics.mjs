const stages = new Set([
  'open', 'login', 'inject', 'connect', 'discover', 'scan', 'retry', 'list-error',
  'read-error', 'ready', 'failed', 'cancelled', 'build-csv', 'build-json',
  'download-csv', 'download-json', 'saved', 'save-failed',
]);
const codes = new Set([
  'UNKNOWN', 'NOT_READY', 'DISCONNECTED', 'CONNECT_TIMEOUT', 'TRANSFER', 'TAB_CLOSED', 'PAGE_TIMEOUT',
  'LIST_ORDER', 'BATCH_ORDER', 'LIST_TRANSFER_COUNT', 'TOTAL_TRANSFER_COUNT', 'CHECKBOX_UNRECOGNIZED',
  'LIST_GROUP_TIMEOUT', 'DETAIL_CLOSE_BUTTON_TIMEOUT', 'DETAIL_CLOSE_TIMEOUT', 'LIST_MISSING', 'LIST_TIMEOUT',
  'STEP_CONTAINER_MISSING', 'STEP_TITLE_MISSING', 'TASK_ROW_UNRECOGNIZED', 'TASK_STATE_CHANGED', 'DETAIL_TIMEOUT',
  'OPEN_COUNT_MISMATCH', 'COMPLETED_COUNT_MISMATCH', 'TASK_LIST_REMOUNTED', 'TASK_ROW_REMOUNTED', 'SCROLL_STALLED',
  'BUILD_FAILED', 'DOWNLOAD_START_FAILED', 'DOWNLOAD_INTERRUPTED', 'DOWNLOAD_TIMEOUT', 'DOWNLOAD_STATUS_FAILED',
]);
const interruptReasons = new Set([
  'FILE_FAILED', 'FILE_ACCESS_DENIED', 'FILE_NO_SPACE', 'FILE_NAME_TOO_LONG', 'FILE_TOO_LARGE',
  'FILE_VIRUS_INFECTED', 'FILE_TRANSIENT_ERROR', 'FILE_BLOCKED', 'FILE_SECURITY_CHECK_FAILED',
  'FILE_TOO_SHORT', 'FILE_HASH_MISMATCH', 'FILE_SAME_AS_SOURCE',
  'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN', 'NETWORK_INVALID_REQUEST',
  'SERVER_FAILED', 'SERVER_NO_RANGE', 'SERVER_BAD_CONTENT', 'SERVER_UNAUTHORIZED', 'SERVER_CERT_PROBLEM',
  'SERVER_FORBIDDEN', 'SERVER_UNREACHABLE', 'SERVER_CONTENT_LENGTH_MISMATCH', 'SERVER_CROSS_ORIGIN_REDIRECT',
  'USER_CANCELED', 'USER_SHUTDOWN', 'CRASH',
]);
const errorTypes = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'InvalidStateError', 'NotAllowedError',
  'QuotaExceededError', 'SecurityError',
]);
const numberFields = ['count', 'listIndex', 'retries', 'expected', 'observed', 'attempt', 'bytes'];
const runIdPattern = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function sanitizeDiagnostic(event) {
  if (!event || typeof event.time !== 'string' || !timePattern.test(event.time) ||
      typeof event.runId !== 'string' || !runIdPattern.test(event.runId) || !stages.has(event.stage)) return null;

  const clean = {time: event.time, runId: event.runId, stage: event.stage};
  if (stages.has(event.previousStage)) clean.previousStage = event.previousStage;
  if (codes.has(event.code)) clean.code = event.code;
  else if (event.code !== undefined) clean.code = 'UNKNOWN';
  if (interruptReasons.has(event.interruptReason)) clean.interruptReason = event.interruptReason;
  if (errorTypes.has(event.errorType)) clean.errorType = event.errorType;
  if (['all', 'open', 'completed'].includes(event.scope)) clean.scope = event.scope;
  if (['csv', 'json'].includes(event.format)) clean.format = event.format;
  if (Number.isInteger(event.intervalMs) &&
      (event.intervalMs === 0 || (event.intervalMs >= 250 && event.intervalMs <= 10000))) {
    clean.intervalMs = event.intervalMs;
  }
  for (const field of numberFields) {
    if (Number.isSafeInteger(event[field]) && event[field] >= 0) clean[field] = event[field];
  }
  return clean;
}
