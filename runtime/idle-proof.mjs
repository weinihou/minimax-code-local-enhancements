import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
export async function readSessionIds(dataDir, { maxSessions = 256 } = {}) {
  const path = join(dataDir, 'v2/sqlite/runtime-state.sqlite');
  for (const entry of [join(dataDir, 'v2'), join(dataDir, 'v2/sqlite'), path]) {
    if ((await lstat(entry)).isSymbolicLink()) throw Error('Unsupported session index path');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    const columns = db.prepare('PRAGMA table_info(local_runtime_sessions)').all();
    if (!columns.some(c => c.name === 'session_id' && c.type === 'TEXT' && c.pk === 1) || !columns.some(c => c.name === 'columnar_version' && c.type === 'INTEGER')) throw Error('Unknown session index schema');
    const rows = db.prepare('SELECT session_id, columnar_version FROM local_runtime_sessions ORDER BY session_id LIMIT ?').all(maxSessions + 1);
    if (rows.length > maxSessions || rows.some(r => r.columnar_version !== 3 || typeof r.session_id !== 'string' || !r.session_id || r.session_id.length > 256)) throw Error('Unsupported or oversized session index');
    return rows.map(r => r.session_id);
  } finally { db.close(); }
}
export function activityExpression(ids, startedAt) {
  return `(${async function (ids, startedAt) {
    let req = window.__QB_QUOTA__?.req;
    if (!req) {
      const chunk = window.webpackChunk_N_E;
      if (!chunk || !Array.isArray(chunk)) return { safe: false, reason: 'client-unavailable' };
      chunk.push([['local_enhancements_idle_' + crypto.randomUUID()], {}, runtime => { req = runtime; }]);
    }
    if (typeof req !== 'function') return { safe: false, reason: 'client-unavailable' };
    const client = req(76599).u('local');
    if (typeof client?.getSessionActivity !== 'function') return { safe: false, reason: 'activity-unavailable' };
    for (let offset = 0; offset < ids.length; offset += 4) {
      if (Date.now() - startedAt > 4000) return { safe: false, reason: 'proof-expired' };
      const batch = await Promise.all(ids.slice(offset, offset + 4).map(id => client.getSessionActivity({ id })));
      for (const activity of batch) {
        if (activity?.state !== 0 || activity.truncated !== false || !Array.isArray(activity.items) || activity.items.length !== 0 || !Number.isInteger(activity.sessionCount) || activity.sessionCount < 1 || !Number.isFinite(activity.checkedAtMs) || activity.checkedAtMs < startedAt || Date.now() - activity.checkedAtMs > 4000) return { safe: false, reason: 'activity-or-unknown' };
      }
    }
    return { safe: true };
  }.toString()})(${JSON.stringify(ids)},${JSON.stringify(startedAt)})`;
}
export async function proveGlobalIdle({ dataDir, evaluate, enumerate = readSessionIds, now = Date.now }) {
  const startedAt = now();
  try {
    const before = await enumerate(dataDir);
    if (!Array.isArray(before) || before.length > 256 || new Set(before).size !== before.length) return { safe: false, complete: false, reason: 'unknown-session-index' };
    const activity = await evaluate(activityExpression(before, startedAt));
    if (activity?.safe !== true) return { safe: false, complete: false, reason: 'activity-or-unknown' };
    const after = await enumerate(dataDir);
    if (JSON.stringify(before) !== JSON.stringify(after)) return { safe: false, complete: false, reason: 'session-index-changed' };
    if (now() - startedAt > 4000 || now() < startedAt) return { safe: false, complete: false, reason: 'proof-expired' };
    return { safe: true, complete: true, sessionCount: before.length, checkedAtMs: startedAt };
  } catch { return { safe: false, complete: false, reason: 'session-index-or-activity-unavailable' }; }
}
