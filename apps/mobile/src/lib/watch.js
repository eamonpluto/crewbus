// CrewBus M5 foreground watcher — polls inbox approvals + board dead-man
// state, alerts once per new id. Foreground only BY DESIGN: the scaffold
// forbids FCM/notification plugins, so there is no killed-app push; this
// is the in-app alert layer that makes the 300s approval window usable
// while the app is open. Quiet when offline (errors never alert).
// Screens start it on mount and stop on unmount; singleton dedupes.
import { Vibration } from 'react-native';

const seenApprovals = new Set();
const seenDead = new Set();
let timer = null;

const isApproval = (m) => /^approval:\s*/i.test(String((m && m.subject) || ''));
const isDeadWorker = (w) => w && w.alive === false && w.briefId && !w.reply;

async function tick(api, agent, onAlert) {
  try {
    const data = await api.fetchInbox(agent, { unacked: 1, limit: 50 });
    const list = Array.isArray(data) ? data : data.items || data.messages || [];
    for (const m of list) {
      if (!isApproval(m) || !m.id) continue;
      const k = `${agent}:${m.id}`;
      if (seenApprovals.has(k)) continue;
      seenApprovals.add(k);
      onAlert({ kind: 'approval', title: 'Approval needed', body: `${m.from || 'worker'}: ${m.subject || ''}` });
    }
  } catch { /* offline: stay quiet, next tick retries */ }
  try {
    const board = await api.fetchBoard();
    const workers = Array.isArray(board.workers) ? board.workers : [];
    for (const w of workers) {
      if (!isDeadWorker(w) || !w.name) continue;
      if (seenDead.has(w.name)) continue;
      seenDead.add(w.name);
      onAlert({ kind: 'dead', title: 'Worker exited, no reply', body: `${w.name} — check its log` });
    }
  } catch { /* offline: stay quiet, next tick retries */ }
}

export function startWatch({ getApi, agent, onAlert, intervalMs = 60000 }) {
  stopWatch();
  const run = () => {
    let api = null;
    try {
      api = getApi();
    } catch {
      return Promise.resolve();
    }
    if (!api) return Promise.resolve();
    return tick(api, agent, onAlert);
  };
  run().catch(() => {});
  timer = setInterval(() => { run().catch(() => {}); }, intervalMs);
  return stopWatch;
}

export function stopWatch() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function buzz() {
  try {
    Vibration.vibrate(80);
  } catch { /* haptics unavailable: banner still shows */ }
}
