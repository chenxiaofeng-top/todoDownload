import {sanitizeDiagnostic} from './diagnostics.mjs';

const journalKey = 'todo-export-diagnostics-v1';
const maxEvents = 500;
const panelUrl = chrome.runtime.getURL('panel.html');
let queue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(console.error);
});

chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== panelUrl) return;
  if (message?.type !== 'diagnostic:append' && message?.type !== 'diagnostic:read') return;

  const operation = queue.then(async () => {
    const stored = (await chrome.storage.local.get(journalKey))[journalKey];
    const events = Array.isArray(stored) ? stored : [];
    if (message.type === 'diagnostic:read') {
      return {
        ok: true,
        events: events.slice(-maxEvents).map(sanitizeDiagnostic).filter(Boolean)
          .sort((first, second) => first.time.localeCompare(second.time)),
      };
    }

    const event = sanitizeDiagnostic(message.event);
    if (!event) return {ok: false};
    await chrome.storage.local.set({[journalKey]: [...events.slice(1 - maxEvents), event]});
    return {ok: true};
  });
  queue = operation.catch(() => {});
  void operation.then(respond, () => respond({ok: false})).catch(() => {});
  return true;
});
