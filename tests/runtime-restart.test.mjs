import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRestarter, createApplication } from '../runtime/restart.mjs';
import { createController } from '../runtime/control.mjs';
import { defaults, atomicJSON } from '../runtime/config.mjs';
const work = resolve(fileURLToPath(new URL('..', import.meta.url)), '../local/work');
await mkdir(work, { recursive: true });
const root = await mkdtemp(join(work, 'runtime-restart-test-'));
let index = 0;
async function fixture() {
  const dir = join(root, String(++index));
  await mkdir(dir);
  const config = defaults();
  config.modules.quotabar = { enabled: true, background: true, autostart: false, autoRestart: true };
  const save = () => atomicJSON(join(dir, 'config.json'), config);
  await save();
  const calls = [];
  const pages = { async portAvailable() { return true; }, async proveIdle() { return { safe: true, complete: true, sessionCount: 4, checkedAtMs: 100000 }; } };
  const application = {
    async running() { return true; },
    async quit() { calls.push('quit'); },
    async waitForExit() { calls.push('wait'); return true; },
    async open() { calls.push('open'); },
  };
  return { dir, config, save, calls, pages, application, now: () => 100000 };
}
test('all-idle complete fresh proof requests normal quit, waits, opens, then cooldown blocks repeat', async () => {
  const f = await fixture();
  const restart = createRestarter(f);
  assert.equal((await restart()).state, 'restarted');
  assert.deepEqual(f.calls, ['quit', 'wait', 'open']);
  assert.equal((await restart()).state, 'deferred');
  assert.deepEqual(f.calls, ['quit', 'wait', 'open']);
});
test('activity, truncation, unknown proof and unavailable CDP cause zero quits', async () => {
  for (const override of [
    { safe: false, complete: true },
    { safe: true, complete: false },
    { safe: true, complete: true, checkedAtMs: 1 },
    {},
  ]) {
    const f = await fixture();
    f.pages.proveIdle = async () => ({ sessionCount: 4, checkedAtMs: 100000, ...override });
    assert.notEqual((await createRestarter(f)()).state, 'restarted');
    assert.deepEqual(f.calls, []);
  }
  const f = await fixture();
  f.pages.portAvailable = async () => false;
  assert.equal((await createRestarter(f)()).reason, 'cdp-unavailable');
  assert.deepEqual(f.calls, []);
});
test('permissions revoked during second proof prevent quit; quit failure or timeout never opens', async () => {
  const f = await fixture();
  let proofs = 0;
  const original = f.pages.proveIdle;
  f.pages.proveIdle = async () => { if (++proofs === 2) { f.config.modules.quotabar.enabled = false; await f.save(); } return original(); };
  assert.equal((await createRestarter(f)()).reason, 'permission-revoked');
  assert.deepEqual(f.calls, []);
  for (const mode of ['throw', 'timeout']) {
    const g = await fixture();
    if (mode === 'throw') g.application.quit = async () => { g.calls.push('quit'); throw Error('quit rejected'); };
    else g.application.waitForExit = async () => { g.calls.push('wait'); return false; };
    assert.notEqual((await createRestarter(g)()).state, 'restarted');
    assert.equal(g.calls.includes('open'), false);
  }
});
test('system application adapter uses only normal quit and waits for confirmed exit', async () => {
  const calls = [];
  let running = true;
  let time = 0;
  const app = createApplication({ port: 9444, now: () => time, sleep: async () => { running = false; time += 200; },
    execCommand: async (file, args) => { calls.push([file, args]); return { stdout: running ? '/Applications/MiniMax Code.app/Contents/MacOS/MiniMax Code' : '' }; },
  });
  await app.quit();
  assert.equal(await app.waitForExit(), true);
  await app.open();
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.ok(calls.at(-1)[1].includes('--remote-debugging-port=9444'));
  assert.equal(calls.some(c => c[1].includes('SIGTERM') || c[1].includes('SIGKILL')), false);
});
test('stop persists disabled, repair/sessionStart do not revive; installation lock blocks all writes', async () => {
  const f = await fixture();
  const dataDir = join(root, 'control');
  const backend = { async stop() { return { stopped: true }; }, async autostart() {}, async start() { return { requested: true }; }, async info() { return {}; }, async autostartPresent() { return false; } };
  const pages = { async inject() { return { injected: true }; }, async dispose() {} };
  const c = createController({ dataDir, backend, pages });
  await c.start('quotabar');
  assert.equal((await c.status()).modules.quotabar.permissions.enabled, true);
  await c.configure('quotabar', { background: true, autostart: true });
  await c.stop('quotabar');
  assert.equal((await c.status()).modules.quotabar.permissions.enabled, false);
  await assert.rejects(c.repair('quotabar'), /disabled/);
  assert.equal((await c.sessionStart()).quotabar.skipped, true);
  await assert.rejects(c.start('credit-guard'), /background/);
  assert.equal((await c.status()).modules['credit-guard'].permissions.enabled, false);
  await writeFile(join(dataDir, 'local-enhancements/install.lock'), '');
  for (const op of [() => c.start('quotabar'), () => c.stop('quotabar'), () => c.configure('quotabar', { enabled: true }), () => c.repair('quotabar')]) await assert.rejects(op(), /Installation in progress/);
});
