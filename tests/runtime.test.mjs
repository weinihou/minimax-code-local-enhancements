import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createController } from '../runtime/control.mjs';
import { defaults, validateConfig, atomicJSON } from '../runtime/config.mjs';
import { createBackend } from '../runtime/backend.mjs';
import { runSupervisor } from '../runtime/supervisor.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const work = resolve(root, '../local/work');
await mkdir(work, { recursive: true });
const fixtures = await mkdtemp(join(work, 'runtime-test-'));
let seq = 0;
async function setup() {
  const dataDir = join(fixtures, `profile with spaces ${++seq}`);
  const calls = [];
  const running = new Set();
  const auto = new Set();
  const backend = {
    async info(n) { return { running: running.has(n) }; },
    async autostartPresent(n) { return auto.has(n); },
    async autostart(n, v) { calls.push(['autostart', n, v]); v ? auto.add(n) : auto.delete(n); },
    async start(n) { calls.push(['start', n]); running.add(n); return { requested: true }; },
    async stop(n) { calls.push(['stop', n]); running.delete(n); auto.delete(n); return { stopped: true }; },
  };
  const pages = { async inject() { calls.push(['inject']); return { injected: true }; }, async dispose() { calls.push(['dispose']); } };
  const controller = createController({ dataDir, pluginRoot: root, backend, pages });
  return { dataDir, calls, running, auto, backend, pages, controller };
}
test('schema is complete and strict; credit autoRestart is rejected', () => {
  assert.doesNotThrow(() => validateConfig(defaults()));
  for (const edit of [c => { c.x = 1; }, c => { delete c.modules.quotabar.enabled; }, c => { c.modules.quotabar.enabled = 1; }, c => { c.modules.quotabar.extra = false; }, c => { c.modules.quotabar.autostart = true; }, c => { c.modules['credit-guard'].background = true; c.modules['credit-guard'].autoRestart = true; }]) {
    const c = defaults(); edit(c); assert.throws(() => validateConfig(c));
  }
});
test('start enables without granting background; opt-ins are independent; page-only mode is explicit', async () => {
  const s = await setup();
  for (const n of ['quotabar', 'credit-guard']) await assert.rejects(s.controller.repair(n), /disabled/);
  await assert.rejects(s.controller.start('credit-guard'), /background/);
  assert.equal((await s.controller.status()).modules['credit-guard'].permissions.enabled, false);
  assert.deepEqual(s.calls, []);
  const once = await s.controller.start('quotabar');
  assert.equal((await s.controller.status()).modules.quotabar.permissions.enabled, true);
  assert.equal(once.residentProcess, false);
  assert.equal(once.mode, 'page-only');
  await s.controller.configure('credit-guard', { enabled: true });
  await assert.rejects(s.controller.start('credit-guard'), /background/);
  await s.controller.configure('quotabar', { background: true });
  await s.controller.start('quotabar');
  assert.deepEqual([...s.running], ['quotabar']);
  assert.equal((await s.controller.status()).modules['credit-guard'].permissions.background, false);
  assert.equal(s.auto.size, 0);
  await assert.rejects(s.controller.start('../quotabar'), /Invalid module/);
});
test('revoking permissions stops and removes autostart; concurrent writers preserve fields', async () => {
  const s = await setup();
  await Promise.all([s.controller.configure('quotabar', { enabled: true }), createController({ dataDir: s.dataDir, backend: s.backend, pages: s.pages }).configure('credit-guard', { enabled: true, background: true })]);
  assert.equal((await s.controller.status()).modules['credit-guard'].permissions.enabled, true);
  await s.controller.configure('quotabar', { background: true, autostart: true });
  await s.controller.start('quotabar');
  assert.equal(s.auto.has('quotabar'), true);
  await s.controller.configure('quotabar', { enabled: false, background: false, autostart: false });
  assert.equal(s.running.has('quotabar'), false);
  assert.equal(s.auto.has('quotabar'), false);
  await s.controller.start('credit-guard');
  await s.controller.configure('credit-guard', { enabled: false });
  assert.equal(JSON.parse(await readFile(join(s.dataDir, 'credit-guard/enabled.json'))).enabled, false);
  const permissions = await stat(join(s.dataDir, 'local-enhancements/config.json'));
  assert.equal(permissions.mode & 0o777, 0o600);
});
test('status isolates one module failure; repair never enables or restarts application', async () => {
  const s = await setup();
  s.backend.info = async n => { if (n === 'quotabar') throw Error('private data'); return { running: false }; };
  const status = await s.controller.status();
  assert.equal(status.modules['credit-guard'].running, false);
  assert.equal(status.modules.quotabar.error, 'Runtime status unavailable');
  await assert.rejects(s.controller.repair('quotabar'), /disabled/);
  assert.deepEqual(s.calls, []);
  await s.controller.configure('quotabar', { enabled: true, background: true, autoRestart: true });
  const repaired = await s.controller.repair('quotabar');
  assert.equal(repaired.applicationRestarted, false);
  assert.equal(repaired.automaticRestart.implemented, true);
  assert.equal(repaired.automaticRestart.missingCDP, 'deferred');
});
test('broken configuration is not reset or rewritten', async () => {
  const s = await setup();
  await mkdir(join(s.dataDir, 'local-enhancements'), { recursive: true });
  const path = join(s.dataDir, 'local-enhancements/config.json');
  await writeFile(path, '{broken');
  await assert.rejects(s.controller.configure('quotabar', { enabled: true }));
  await assert.rejects(s.controller.stop('credit-guard'));
  assert.equal(await readFile(path, 'utf8'), '{broken');
  assert.deepEqual(s.calls, []);
});
test('launch backend keeps paths as argv, no shell, transient submit and opt-in plist', async () => {
  const dataDir = join(fixtures, 'launch profile with spaces');
  const commands = [];
  const launchAgentsDir = join(dataDir, 'Launch Agents');
  const backend = createBackend({ dataDir, pluginRoot: join(dataDir, 'plugin with spaces'), port: 9999, nodePath: '/node with spaces/node', launchAgentsDir, execCommand: async (file, args) => { commands.push([file, args]); return { stdout: '' }; } });
  await backend.start('quotabar', { autostart: false });
  const args = commands.at(-1)[1];
  assert.equal(args[0], 'submit');
  assert.ok(args.includes('/node with spaces/node'));
  assert.ok(args.includes(`QB_STATE_DIR=${join(dataDir, 'quotabar')}`));
  await backend.autostart('quotabar', true);
  const text = await readFile(join(launchAgentsDir, 'com.minimax.local-enhancements.quotabar.plist'), 'utf8');
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(text, /KeepAlive|ensure.sh|restart-once/);
});
test('missing CDP never kills or launches app; supervisor rereads revoked permissions', async () => {
  const s = await setup();
  await s.controller.configure('quotabar', { enabled: true, background: true, autoRestart: true });
  const states = [];
  let disposed = false;
  await runSupervisor({ name: 'quotabar', dataDir: s.dataDir, pluginRoot: root,
    pages: { async inject() { throw Error('no port'); }, async dispose() { disposed = true; } },
    spawnChild() { assert.fail('must not spawn app'); }, onState: x => states.push(x),
    async sleep() { await s.controller.configure('quotabar', { enabled: false }); },
  });
  assert.equal(states[0].reason, 'app-page-unavailable');
  assert.equal(disposed, true);
});
test('credit supervisor waits for graceful daemon completion on revoke', async () => {
  const s = await setup();
  await s.controller.configure('credit-guard', { enabled: true, background: true });
  const child = new EventEmitter();
  let exited = false;
  child.kill = sig => { assert.equal(sig, 'SIGTERM'); setTimeout(() => { exited = true; child.emit('exit', 0); }, 15); };
  await runSupervisor({ name: 'credit-guard', dataDir: s.dataDir, pluginRoot: root, spawnChild: () => child,
    async sleep() { const c = defaults(); await atomicJSON(join(s.dataDir, 'local-enhancements/config.json'), c); },
  });
  assert.equal(exited, true);
});
test('backend never removes a daemon that has not completed graceful shutdown', async () => {
  const commands = [];
  const backend = createBackend({ dataDir: fixtures, pluginRoot: root, port: 9333, nodePath: process.execPath, launchAgentsDir: join(fixtures, 'never-written'), stopTimeout: 0,
    execCommand: async (file, args) => { commands.push(args); return { stdout: '321 0 com.minimax.local-enhancements.credit-guard\n' }; },
  });
  await assert.rejects(backend.stop('credit-guard'), /Graceful stop pending/);
  assert.ok(commands.some(args => args[0] === 'kill' && args[1] === 'SIGTERM'));
  assert.equal(commands.some(args => args[0] === 'remove' || args.includes('SIGKILL')), false);
});
test('quotabar rejects unrelated CDP pages without opening any websocket', async () => {
  const { evalInApp } = await import('../modules/quotabar/src/quotabar.mjs');
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, async json() { return [{ type: 'page', url: 'https://example.test', webSocketDebuggerUrl: 'ws://never-connect' }]; } });
  try { await assert.rejects(evalInApp('true', 9999), /没有可注入/); }
  finally { globalThis.fetch = oldFetch; }
});
test('sessionStart respects login opt-in and isolates failures', async () => {
  const s = await setup();
  await s.controller.configure('quotabar', { enabled: true, background: true });
  assert.equal((await s.controller.sessionStart()).quotabar.skipped, true);
  await s.controller.configure('quotabar', { autostart: true });
  await s.controller.configure('credit-guard', { enabled: true, background: true, autostart: true });
  s.backend.start = async n => { if (n === 'quotabar') throw Error('failed'); return { requested: true }; };
  const results = await s.controller.sessionStart();
  assert.ok(results.quotabar.error);
  assert.equal(results['credit-guard'].requested, true);
});
