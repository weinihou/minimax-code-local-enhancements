import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInstaller, defaults, NAME } from '../scripts/installer.mjs';

const root = fileURLToPath(new URL('../../local/work/', import.meta.url));
const absent = async path => { try { await access(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
async function fixture(safety = async () => ({ appRunning: false, registeredLabels: [] })) {
  await mkdir(root, { recursive: true });
  const base = await mkdtemp(join(root, 'installer-'));
  const dataDir = join(base, 'profile with spaces');
  const icon = join(base, 'fixture.png');
  await writeFile(icon, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2GdAAAAAASUVORK5CYII=', 'base64'));
  const installer = createInstaller({ safety });
  return { base, dataDir, icon, installer, options: { dataDir, icon, apply: true } };
}
async function legacy(f) {
  for (const name of ['quotabar', 'credit-guard']) {
    const dir = join(f.dataDir, 'plugins', name, '.minimax-plugin');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  const dir = join(f.dataDir, 'credit-guard');
  await mkdir(dir, { recursive: true });
  const state = { engine: { version: 1, sessions: [{ sessionId: 'fixture', enabled: true, limit: 100, spent: 32,
    phase: 'paused', budgetPause: { ownership: 'budget', resumeAllowed: true, capture: { updatedAt: 1, lastMsgId: 'fixture-msg' } } }] }, scope: 'fixture-account', processed: ['fixture-command'] };
  const raw = JSON.stringify(state, null, 3) + '\n';
  await writeFile(join(dir, 'state.json'), raw);
  await writeFile(join(dir, 'enabled.json'), '{"enabled":true}\n');
  return raw;
}

test('install preview is read-only and does not create target profile', async () => {
  const f = await fixture();
  const plan = await f.installer.apply({ dataDir: f.dataDir });
  assert.equal(plan.ready, false);
  assert.match(plan.blockers[0], /--icon/);
  assert.equal((await f.installer.plan({ dataDir: f.dataDir, icon: f.icon })).ready, true);
  assert.equal(await absent(f.dataDir), true);
});

test('source CLI refuses module control before installation without creating state', async () => {
  const f = await fixture();
  const script = fileURLToPath(new URL('../scripts/manage.mjs', import.meta.url));
  const output = spawnSync(process.execPath, [script, 'start', 'quotabar', '--data-dir', f.dataDir], { encoding: 'utf8' });
  assert.equal(output.status, 1);
  assert.match(output.stderr, /Install or migrate/);
  assert.equal(await absent(f.dataDir), true);
});

test('fresh install copies only unified entry, defaults off, and never creates LaunchAgents', async () => {
  const f = await fixture();
  const result = await f.installer.apply(f.options);
  assert.equal(result.applied, true);
  assert.equal(result.modulesStarted, false);
  const config = JSON.parse(await readFile(join(f.dataDir, 'local-enhancements/config.json'), 'utf8'));
  assert.deepEqual(config, defaults());
  const packageRoot = join(f.dataDir, 'plugins', NAME);
  const manifest = JSON.parse(await readFile(join(packageRoot, '.minimax-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(manifest.hooks, []);
  assert.deepEqual(manifest.mcpServers, ['enhancements.mcp.json']);
  assert.equal(await absent(join(packageRoot, 'modules/quotabar/src/ensure.sh')), true);
  assert.equal(await absent(join(packageRoot, 'modules/credit-guard/control.mjs')), true);
  assert.equal(await absent(join(f.dataDir, 'credit-guard')), true);
  assert.equal(await absent(join(f.dataDir, 'local-enhancements/LaunchAgents')), true);
  const protocol = spawnSync(process.execPath, [join(packageRoot, 'runtime/mcp-server.mjs')], {
    env: { ...process.env, MINIMAX_DATA_DIR: f.dataDir }, encoding: 'utf8', timeout: 5000,
    input: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'enhancements_configure', arguments: { module: 'unknown', changes: { background: true } } } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n',
  });
  assert.equal(protocol.status, 0, protocol.stderr);
  const replies = protocol.stdout.trim().split('\n').map(x => JSON.parse(x));
  assert.equal(replies[0].result.serverInfo.version, '0.2.0');
  assert.equal(replies[1].result.tools.length, 5);
  assert.equal(replies[2].result.isError, true);
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'local-enhancements/config.json'), 'utf8')), defaults());
});

test('active application or even idle registered legacy job blocks apply before writes', async () => {
  for (const live of [{ appRunning: true, registeredLabels: [] }, { appRunning: false, registeredLabels: ['com.minimax.quotabar'] }, { appRunning: false, registeredLabels: [], runningWorkers: 1 }]) {
    const f = await fixture(async () => live);
    await assert.rejects(f.installer.apply(f.options), /Apply refused/);
    assert.equal(await absent(f.dataDir), true);
  }
});

test('legacy packages require explicit migrate, migration preserves state bytes and archives only code', async () => {
  const f = await fixture();
  const raw = await legacy(f);
  await assert.rejects(f.installer.apply(f.options), /Legacy plugin exists/);
  const preview = await f.installer.apply({ dataDir: f.dataDir, icon: f.icon, migrate: true });
  assert.equal(preview.ready, true);
  assert.equal(preview.preserve.length, 2);
  assert.equal(await absent(join(f.dataDir, 'plugins/credit-guard')), false);
  await f.installer.apply({ ...f.options, migrate: true });
  assert.equal(await readFile(join(f.dataDir, 'credit-guard/state.json'), 'utf8'), raw);
  assert.equal(await readFile(join(f.dataDir, 'credit-guard/enabled.json'), 'utf8'), '{"enabled":true}\n');
  assert.equal(await absent(join(f.dataDir, 'plugins/credit-guard')), true);
  assert.equal(await absent(join(f.dataDir, 'local-enhancements/legacy-plugins/credit-guard/.minimax-plugin/plugin.json')), false);
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'local-enhancements/config.json'), 'utf8')), defaults());
});

test('damaged persisted state is rejected without resetting counters', async () => {
  const f = await fixture();
  await legacy(f);
  const path = join(f.dataDir, 'credit-guard/state.json');
  await writeFile(path, '{broken');
  await assert.rejects(f.installer.apply({ ...f.options, migrate: true }), /Invalid legacy/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  assert.equal(await absent(join(f.dataDir, 'plugins/credit-guard')), false);
});

test('upgrade retains explicit choices and keeps one previous package; backup slot prevents unbounded growth', async () => {
  const f = await fixture();
  await f.installer.apply(f.options);
  const config = defaults();
  config.modules.quotabar.background = true;
  const raw = JSON.stringify(config);
  await writeFile(join(f.dataDir, 'local-enhancements/config.json'), raw);
  await f.installer.apply(f.options);
  assert.equal(await readFile(join(f.dataDir, 'local-enhancements/config.json'), 'utf8'), raw);
  assert.equal(await absent(join(f.dataDir, 'local-enhancements/previous-package')), false);
  await assert.rejects(f.installer.apply(f.options), /backup slot occupied/);
});

test('offline rollback restores legacy code and never rewinds state or starts services', async () => {
  const f = await fixture();
  const raw = await legacy(f);
  await f.installer.apply({ ...f.options, migrate: true });
  const preview = await f.installer.rollback({ dataDir: f.dataDir });
  assert.equal(preview.ready, true);
  assert.match(preview.warning, /historical startup behavior/);
  assert.equal(await absent(join(f.dataDir, 'plugins', NAME)), false);
  const result = await f.installer.rollback({ dataDir: f.dataDir, apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.startsServices, false);
  assert.equal(await absent(join(f.dataDir, 'plugins/credit-guard')), false);
  assert.equal(await absent(join(f.dataDir, 'plugins', NAME)), true);
  assert.equal(await readFile(join(f.dataDir, 'credit-guard/state.json'), 'utf8'), raw);
});

test('upgrade rollback never restores legacy hooks alongside a previous unified package', async () => {
  const f = await fixture();
  await legacy(f);
  await f.installer.apply({ ...f.options, migrate: true });
  await f.installer.apply(f.options);
  const result = await f.installer.rollback({ dataDir: f.dataDir, apply: true });
  assert.equal(result.restoreCount, 1);
  assert.equal(await absent(join(f.dataDir, 'plugins', NAME)), false);
  assert.equal(await absent(join(f.dataDir, 'plugins/credit-guard')), true);
  assert.equal(await absent(join(f.dataDir, 'local-enhancements/legacy-plugins/credit-guard')), false);
});

test('symlinked installation path and cross-profile state import are refused', async () => {
  const f = await fixture();
  await mkdir(join(f.base, 'real-profile'));
  await symlink(join(f.base, 'real-profile'), f.dataDir);
  await assert.rejects(f.installer.apply(f.options), /Symbolic path/);
  const next = await fixture();
  await assert.rejects(next.installer.plan({ dataDir: next.dataDir, sourceDataDir: join(next.base, 'other'), migrate: true }), /same profile/);
});

test('interrupted installation retains evidence and leaves legacy plugin paths intact', async () => {
  const f = await fixture();
  await legacy(f);
  const installer = createInstaller({ sourceRoot: join(f.base, 'missing-source'), safety: async () => ({ appRunning: false, registeredLabels: [] }) });
  await assert.rejects(installer.apply({ ...f.options, migrate: true }), /Install failed/);
  assert.equal(await absent(join(f.dataDir, 'plugins/credit-guard')), false);
  assert.equal(await absent(join(f.dataDir, 'local-enhancements/install.lock')), false);
  assert.equal(await absent(join(f.dataDir, 'local-enhancements/staging')), false);
});
