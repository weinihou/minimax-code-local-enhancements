import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { readSessionIds, proveGlobalIdle } from '../runtime/idle-proof.mjs';
import { writeRuntimeSummary } from '../runtime/summary.mjs';
import { createController } from '../runtime/control.mjs';
import { runSupervisor } from '../runtime/supervisor.mjs';
import { defaults, atomicJSON } from '../runtime/config.mjs';
const work = resolve(fileURLToPath(new URL('..', import.meta.url)), '../local/work');
await mkdir(work, { recursive: true });
const root = await mkdtemp(join(work, 'runtime-idle-test-'));
let seq = 0;
async function database(rows) {
  const dataDir = join(root, `profile ${++seq}`);
  await mkdir(join(dataDir, 'v2/sqlite'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'v2/sqlite/runtime-state.sqlite'));
  db.exec('CREATE TABLE local_runtime_sessions(session_id TEXT PRIMARY KEY, columnar_version INTEGER, agent_name TEXT, archived INTEGER, visibility TEXT, project_id INTEGER)');
  for (const [id, version = 3] of rows) db.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?, ?)').run(id, version, 'orphan-agent', 1, 'hidden', 99);
  db.close();
  return dataDir;
}
function evaluator(activities, time = () => 100000) {
  return expression => runInNewContext(expression, { window: { __QB_QUOTA__: { req: () => ({ u: () => ({ getSessionActivity: async ({ id }) => activities(id) }) }) } }, Date: { now: time } });
}
const idle = () => ({ state: 0, truncated: false, items: [], sessionCount: 1, checkedAtMs: 100000 });
test('read-only global SQLite enumeration includes hidden archived project orphan-agent sessions', async () => {
  const dataDir = await database([['orphan'], ['another']]);
  assert.deepEqual(await readSessionIds(dataDir), ['another', 'orphan']);
  const seen = [];
  const proof = await proveGlobalIdle({ dataDir, evaluate: evaluator(id => { seen.push(id); return idle(); }), now: () => 100000 });
  assert.equal(proof.safe, true);
  assert.equal(proof.complete, true);
  assert.equal(proof.sessionCount, 2);
  assert.deepEqual(seen.sort(), ['another', 'orphan']);
});
test('unsupported schema version and scan limit never produce a complete proof', async () => {
  await assert.rejects(readSessionIds(await database([['legacy', 0]])), /Unsupported/);
  await assert.rejects(readSessionIds(await database([['one'], ['two']]), { maxSessions: 1 }), /oversized/);
  const proof = await proveGlobalIdle({ dataDir: join(root, 'missing'), evaluate() { assert.fail('must not evaluate'); } });
  assert.equal(proof.complete, false);
});
test('activity/waiting/scheduled/truncation/unknown fields fail closed', async () => {
  for (const change of [{ state: 1 }, { state: 2 }, { state: 3 }, { truncated: true }, { items: [{ kind: 3 }] }, { checkedAtMs: 90000 }, { sessionCount: undefined }]) {
    const proof = await proveGlobalIdle({ dataDir: root, enumerate: async () => ['id'], evaluate: evaluator(() => ({ ...idle(), ...change })), now: () => 100000 });
    assert.equal(proof.safe, false);
  }
});
test('changed session IDs and proof deadline prevent safe result', async () => {
  let scans = 0;
  const changed = await proveGlobalIdle({ dataDir: root, enumerate: async () => ++scans === 1 ? ['id'] : ['id', 'new-id'], evaluate: evaluator(idle), now: () => 100000 });
  assert.equal(changed.reason, 'session-index-changed');
  let clockReads = 0;
  const stale = await proveGlobalIdle({ dataDir: root, enumerate: async () => ['id'], evaluate: evaluator(idle), now: () => ++clockReads === 1 ? 100000 : 106000 });
  assert.equal(stale.reason, 'proof-expired');
});
test('runtime summaries whitelist fields and isolate corrupt per-module summaries', async () => {
  const dataDir = join(root, 'summaries');
  const dir = join(dataDir, 'local-enhancements');
  await writeRuntimeSummary(dir, 'quotabar', { state: 'blocked', reason: 'global-idle-unproven', consecutiveFailures: 3, rawError: 'private', sessionId: 'private' });
  const saved = JSON.parse(await readFile(join(dir, 'quotabar-runtime.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['at', 'consecutiveFailures', 'reason', 'state']);
  await writeRuntimeSummary(dir, 'credit-guard', { state: 'starting', reason: 'daemon-start-requested' });
  await writeFile(join(dir, 'quotabar-runtime.json'), '{bad');
  const c = createController({ dataDir, backend: { async info() { return { running: true }; }, async autostartPresent() { return false; } } });
  const status = await c.status();
  assert.equal(status.modules.quotabar.runtime.reason, 'invalid-runtime-summary');
  assert.equal(status.modules['credit-guard'].runtime.state, 'starting');
});
test('supervisor completes three-failure to full-index idle proof to graceful restart pipeline', async () => {
  const dataDir = await database([['archived-orphan']]);
  const dir = join(dataDir, 'local-enhancements');
  await mkdir(dir);
  const config = defaults();
  config.modules.quotabar = { enabled: true, background: true, autostart: false, autoRestart: true };
  await atomicJSON(join(dir, 'config.json'), config);
  const abort = new AbortController();
  let clock = 100000;
  let injections = 0;
  const calls = [];
  const summaries = [];
  const pages = {
    async inject() { injections++; throw Error('fixture injection failure'); },
    async portAvailable() { return true; },
    async proveIdle() { return proveGlobalIdle({ dataDir, evaluate: evaluator(() => ({ ...idle(), checkedAtMs: clock }), () => clock), now: () => clock }); },
    async dispose() {},
  };
  await runSupervisor({ name: 'quotabar', dataDir, pluginRoot: root, pages, signal: abort.signal, now: () => clock,
    async sleep() { clock += 30000; },
    onState: value => summaries.push(value),
    application: { async running() { return true; }, async quit() { calls.push('quit'); }, async waitForExit() { calls.push('wait'); return true; }, async open() { calls.push('open'); abort.abort(); } },
  });
  assert.equal(injections, 3);
  assert.deepEqual(calls, ['quit', 'wait', 'open']);
  assert.ok(summaries.some(s => s.state === 'restarted' && s.consecutiveFailures === 3));
});
test('revoking only login/restart permissions keeps the enabled background module running', async () => {
  const dataDir = join(root, 'permission-only');
  const calls = [];
  const c = createController({ dataDir, backend: { async stop() { calls.push('stop'); return { stopped: true }; }, async autostart(name, enabled) { calls.push(enabled ? 'register' : 'unregister'); }, async start() { return { requested: true }; } }, pages: { async dispose() {} } });
  await c.configure('quotabar', { enabled: true, background: true, autostart: true, autoRestart: true });
  calls.length = 0;
  await c.configure('quotabar', { autostart: false, autoRestart: false });
  assert.deepEqual(calls, ['unregister']);
});
