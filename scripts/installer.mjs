import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const NAME = 'mcode-local-enhancements';
export const VERSION = '0.2.0';
const repository = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
export const LEGACY_LABELS = ['com.minimax.quotabar.daemon', 'com.minimax.quotabar', 'com.minimax.quotabar.restart-once', 'com.minimax.credit-guard.daemon'];
export const NEW_LABELS = ['com.minimax.local-enhancements.quotabar', 'com.minimax.local-enhancements.credit-guard'];
const moduleFiles = {
  'credit-guard': ['core.mjs', 'engine.mjs', 'lib.mjs', 'daemon.mjs', 'page-adapter.js', 'ui.js'],
  quotabar: ['src/quotabar.mjs', 'src/page-script.js'],
};
export const defaults = () => ({ schemaVersion: 1, modules: Object.fromEntries(['quotabar', 'credit-guard'].map(name => [name, { enabled: false, background: false, autostart: false, autoRestart: false }])) });
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function noSymlinks(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw Error('Symbolic path rejected: ' + current); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return absolute;
}
async function regular(path) {
  await noSymlinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1) throw Error('Expected a regular, unlinked file: ' + path);
  return info;
}
async function copy(source, target) {
  await regular(source);
  await noSymlinks(target);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o600);
}
async function jsonWrite(path, value) {
  await noSymlinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function locations(options) {
  const dataDir = resolve(options.dataDir || process.env.MINIMAX_DATA_DIR || join(homedir(), '.minimax'));
  const sourceDataDir = resolve(options.sourceDataDir || dataDir);
  for (const path of [dataDir, sourceDataDir]) if (path === parse(path).root || path === homedir()) throw Error('Use a dedicated application data directory');
  const manager = join(dataDir, 'local-enhancements');
  return { dataDir, sourceDataDir, manager, plugin: join(dataDir, 'plugins', NAME), config: join(manager, 'config.json'), staging: join(manager, 'staging'), previous: join(manager, 'previous-package') };
}
async function liveSafety() {
  if (process.platform !== 'darwin') throw Error('Installation and migration currently support macOS only');
  const { stdout } = await exec('/bin/ps', ['-axo', 'command='], { timeout: 3000, maxBuffer: 2 ** 22 });
  const appRunning = stdout.split('\n').some(line => /\/MiniMax Code\.app\/Contents\/MacOS\/MiniMax Code(?:\s|$)/.test(line));
  const registeredLabels = [];
  for (const label of [...LEGACY_LABELS, ...NEW_LABELS]) {
    try { await exec('/bin/launchctl', ['list', label], { timeout: 2000 }); registeredLabels.push(label); }
    catch (error) { if (error.code !== 113) throw Error('Cannot prove launchd job absent: ' + label); }
  }
  const runningWorkers = stdout.split('\n').filter(line => /\/(?:credit-guard\/daemon\.mjs|quotabar\/(?:src\/)?(?:daemon\.sh|injector\.mjs)|mcode-local-enhancements\/runtime\/supervisor\.mjs)(?:\s|$)/.test(line)).length;
  return { appRunning, registeredLabels, runningWorkers };
}
async function checkIcons(options) {
  if (!options.icon) throw Error('An explicit PNG/JPEG/WebP icon path is required for an installable package');
  for (const path of [options.icon, options.darkIcon].filter(Boolean)) {
    await regular(path);
    const bytes = await readFile(path);
    if (bytes.length > 2 ** 24) throw Error('Icon exceeds plugin file limit');
    const ext = path.toLowerCase().match(/\.(png|jpe?g|webp)$/)?.[1];
    const valid = ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : ext === 'jpg' || ext === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : ext === 'webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw Error('Icon bytes must match PNG/JPEG/WebP extension');
  }
}
function iconName(path, dark = false) { return 'icon' + (dark ? '-dark' : '') + '.' + path.toLowerCase().match(/\.(png|jpe?g|webp)$/)[1]; }

async function creditFiles(paths, migrate) {
  if (!migrate) return [];
  const entries = [];
  for (const name of ['enabled.json', 'state.json']) {
    const source = join(paths.sourceDataDir, 'credit-guard', name);
    if (!(await exists(source))) continue;
    await regular(source);
    const bytes = await readFile(source);
    let value;
    try { value = JSON.parse(bytes); } catch { throw Error('Invalid legacy credit file: ' + name); }
    if (name === 'enabled.json' && typeof value?.enabled !== 'boolean') throw Error('Invalid legacy enable marker');
    if (name === 'state.json' && (value?.engine?.version !== 1 || !Array.isArray(value.engine.sessions))) throw Error('Unsupported legacy state; refusing to reset counters');
    entries.push({ name, source, target: join(paths.dataDir, 'credit-guard', name), sha256: digest(bytes) });
  }
  return entries;
}

export function createInstaller({ sourceRoot = repository, safety = liveSafety } = {}) {
  async function plan(options = {}) {
    const paths = locations(options);
    await noSymlinks(paths.dataDir);
    await noSymlinks(paths.sourceDataDir);
    const mode = options.migrate ? 'migrate' : 'install';
    if (options.migrate && paths.sourceDataDir !== paths.dataDir) throw Error('Migration currently supports the same profile only; cross-profile state import is deliberately refused');
    const blockers = [];
    if (!options.icon) blockers.push('Provide --icon with a PNG/JPEG/WebP file for the installable package');
    const live = await safety();
    if (live.appRunning) blockers.push('Close MiniMax Code before applying; no automatic application exit is performed');
    for (const label of live.registeredLabels) blockers.push('Unregister launchd job before applying: ' + label);
    if (live.runningWorkers) blockers.push('Module worker processes are still running; wait for safe shutdown');
    for (const name of ['quotabar', 'credit-guard']) {
      const legacy = join(paths.dataDir, 'plugins', name);
      await noSymlinks(legacy);
      if (await exists(legacy)) {
        if (!options.migrate) blockers.push('Legacy plugin exists; use migrate preview: ' + name);
        else if (await exists(join(paths.manager, 'legacy-plugins', name))) blockers.push('Legacy backup slot already occupied: ' + name);
      }
    }
    if (await exists(join(paths.manager, 'install.lock'))) blockers.push('Installation lock exists; inspect the interrupted or concurrent operation');
    if (await exists(join(paths.manager, 'control.lock'))) blockers.push('Module control operation in progress');
    if (await exists(paths.staging)) blockers.push('Staging slot exists; inspect the previous interrupted attempt');
    if ((await exists(paths.plugin)) && (await exists(paths.previous))) blockers.push('Previous package backup slot occupied; inspect it before another upgrade');
    if (await exists(paths.plugin)) {
      const manifestPath = join(paths.plugin, '.minimax-plugin/plugin.json');
      await regular(manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name !== NAME) throw Error('Refusing to replace an unrelated plugin');
    }
    if (await exists(paths.config)) {
      await regular(paths.config);
      const { validateConfig } = await import('../runtime/config.mjs');
      validateConfig(JSON.parse(await readFile(paths.config, 'utf8')));
    }
    const preserve = await creditFiles(paths, options.migrate);
    for (const label of LEGACY_LABELS) {
      const file = join(homedir(), 'Library/LaunchAgents', label + '.plist');
      // Only the default profile owns the current user's legacy global LaunchAgents.
      if (paths.dataDir === resolve(homedir(), '.minimax') && await exists(file)) {
        await regular(file);
        if (!options.migrate) blockers.push('Legacy LaunchAgent file exists; use migrate: ' + label);
        else if (await exists(join(paths.manager, 'legacy-launchagents', label + '.plist'))) blockers.push('Legacy LaunchAgent backup slot occupied: ' + label);
      }
    }
    return { mode, version: VERSION, paths, blockers, ready: blockers.length === 0,
      preserve: preserve.map(({ name, sha256 }) => ({ file: 'credit-guard/' + name, sha256, bytePreserved: true })),
      permissions: 'Existing unified choices are retained; first installation sets both modules disabled and all permissions false. Legacy permissions are never silently imported.',
      effects: ['copy unified MCP package only', 'do not start modules or register launchd jobs', ...(options.migrate ? ['archive legacy plugin directories and unregistered legacy LaunchAgent files', 'leave credit state bytes and pause ownership unchanged'] : [])] };
  }
  async function build(target, options, dataDir) {
    for (const [module, files] of Object.entries(moduleFiles)) for (const file of files) await copy(join(sourceRoot, 'modules', module, file), join(target, 'modules', module, file));
    const runtime = join(sourceRoot, 'runtime');
    for (const file of await readdir(runtime)) {
      if (!/^[a-z][a-z0-9-]*\.mjs$/.test(file)) throw Error('Unexpected runtime package entry: ' + file);
      await copy(join(runtime, file), join(target, 'runtime', file));
    }
    const icon = iconName(options.icon), darkIcon = options.darkIcon ? iconName(options.darkIcon, true) : undefined;
    await copy(options.icon, join(target, icon));
    if (darkIcon) await copy(options.darkIcon, join(target, darkIcon));
    await jsonWrite(join(target, '.minimax-plugin/plugin.json'), {
      schemaVersion: 1, name: NAME, displayName: 'MCode 本地增强', version: VERSION,
      description: '统一管理用量条和会话积分限额；模块独立启停，后台常驻、自启动、自动重启均需主动授权。',
      author: 'MCode Local Enhancements contributors', icon, ...(darkIcon ? { darkIcon } : {}), category: 'Code',
      exampleQueries: ['查看本地增强状态', '只启用用量条', '停用积分限额并撤销后台启动'],
      apps: [], mcpServers: ['enhancements.mcp.json'], skills: [], agents: [], hooks: [],
    });
    await jsonWrite(join(target, 'enhancements.mcp.json'), { schemaVersion: 1, mcpServers: { 'mcode-local-enhancements': {
      type: 'stdio', command: 'node', args: ['./runtime/mcp-server.mjs'], env: { MINIMAX_DATA_DIR: dataDir },
      description: '本地增强的状态、显式权限选择和独立模块启停；默认不启动后台。', timeout: 120000,
    } } });
  }
  async function apply(options = {}) {
    if (options.apply !== true) return plan(options);
    const initial = await plan(options);
    if (!initial.ready) throw Error('Apply refused: ' + initial.blockers.join('; '));
    await checkIcons(options);
    const p = initial.paths;
    await mkdir(p.manager, { recursive: true, mode: 0o700 });
    const lock = join(p.manager, 'install.lock');
    await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    const moves = [];
    let published = false;
    try {
      if (await exists(join(p.manager, 'control.lock'))) throw Error('Module control operation in progress');
      const live = await safety();
      if (live.appRunning || live.registeredLabels.length || live.runningWorkers) throw Error('Offline precondition changed; refusing apply');
      await mkdir(p.staging, { mode: 0o700 });
      const packageRoot = join(p.staging, 'package');
      await build(packageRoot, options, p.dataDir);
      let entryCount = 0, fileCount = 0, totalBytes = 0;
      const visit = async dir => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          entryCount++;
          if (!/^[A-Za-z0-9._-]+$/.test(entry.name) || entry.name.endsWith('.') || entry.name.length > 128) throw Error('Nonportable package entry');
          const path = join(dir, entry.name);
          if (entry.isDirectory()) { await visit(path); continue; }
          const info = await regular(path);
          fileCount++; totalBytes += info.size;
          if (info.size > 16 * 1024 * 1024) throw Error('Plugin file size limit exceeded');
          if (/\.(mjs|js)$/.test(entry.name)) await exec(process.execPath, ['--check', path], { timeout: 10000 });
          if (entry.name.endsWith('.json')) {
            const value = JSON.parse(await readFile(path, 'utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid package JSON root');
          }
        }
      };
      await visit(packageRoot);
      if (entryCount > 2048 || fileCount > 1024 || totalBytes > 64 * 1024 * 1024) throw Error('Plugin package size limit exceeded');
      const preserve = await creditFiles(p, options.migrate);
      if (JSON.stringify(preserve.map(({ name, sha256 }) => ({ file: 'credit-guard/' + name, sha256, bytePreserved: true }))) !== JSON.stringify(initial.preserve)) throw Error('Legacy state changed after preview');
      await jsonWrite(join(p.staging, 'receipt.json'), { version: VERSION, mode: initial.mode, preserve: initial.preserve, sourceDataDir: p.sourceDataDir });
      const beforePublish = await safety();
      if (beforePublish.appRunning || beforePublish.registeredLabels.length || beforePublish.runningWorkers) throw Error('Offline precondition changed while preparing package');
      if (options.migrate) {
        for (const name of ['quotabar', 'credit-guard']) {
          const from = join(p.dataDir, 'plugins', name), to = join(p.manager, 'legacy-plugins', name);
          if (await exists(from)) { await mkdir(dirname(to), { recursive: true, mode: 0o700 }); await rename(from, to); moves.push([from, to]); }
        }
        if (p.dataDir === resolve(homedir(), '.minimax')) for (const label of LEGACY_LABELS) {
          const from = join(homedir(), 'Library/LaunchAgents', label + '.plist');
          const to = join(p.manager, 'legacy-launchagents', label + '.plist');
          if (await exists(from)) { await mkdir(dirname(to), { recursive: true, mode: 0o700 }); await rename(from, to); moves.push([from, to]); }
        }
      }
      if (await exists(p.plugin)) { await rename(p.plugin, p.previous); moves.push([p.plugin, p.previous]); }
      await mkdir(dirname(p.plugin), { recursive: true, mode: 0o700 });
      await rename(join(p.staging, 'package'), p.plugin); published = true;
      if (!(await exists(p.config))) await jsonWrite(p.config, defaults());
      await rename(join(p.staging, 'receipt.json'), join(p.manager, 'install-receipt.json'));
      const { rmdir, unlink } = await import('node:fs/promises');
      await rmdir(p.staging);
      await unlink(lock);
      return { applied: true, mode: initial.mode, version: VERSION, plugin: p.plugin, modulesStarted: false, legacyArchived: moves.length, statePreserved: initial.preserve, next: 'Explicitly choose module permissions, then start the selected module.' };
    } catch (error) {
      if (published && await exists(p.plugin)) await rename(p.plugin, join(p.staging, 'failed-package'));
      for (const [from, to] of moves.reverse()) if (await exists(to) && !(await exists(from))) await rename(to, from);
      // Keep failed staging and lock as evidence; never overwrite an interrupted install.
      throw Error('Install failed; previous package paths restored where possible. Inspect staging/install.lock: ' + error.message);
    }
  }
  async function rollback(options = {}) {
    const p = locations(options);
    await noSymlinks(p.dataDir);
    const live = await safety();
    const blockers = [...(live.appRunning ? ['Close MiniMax Code before rollback'] : []), ...live.registeredLabels.map(label => 'Unregister job: ' + label), ...(live.runningWorkers ? ['Module workers still running'] : [])];
    if (await exists(join(p.manager, 'control.lock'))) blockers.push('Module control operation in progress');
    if (await exists(join(p.manager, 'install.lock'))) blockers.push('Interrupted installation lock exists; inspect before rollback');
    const old = [];
    const previousUnified = await exists(p.previous);
    if (previousUnified) old.push([p.previous, p.plugin]);
    for (const name of previousUnified ? [] : ['quotabar', 'credit-guard']) {
      const from = join(p.manager, 'legacy-plugins', name), to = join(p.dataDir, 'plugins', name);
      if (await exists(from)) { if (await exists(to)) blockers.push('Legacy target already exists: ' + name); old.push([from, to]); }
    }
    if (!previousUnified && p.dataDir === resolve(homedir(), '.minimax')) for (const label of LEGACY_LABELS) {
      const from = join(p.manager, 'legacy-launchagents', label + '.plist'), to = join(homedir(), 'Library/LaunchAgents', label + '.plist');
      if (await exists(from)) { if (await exists(to)) blockers.push('LaunchAgent target exists: ' + label); old.push([from, to]); }
    }
    if (!old.length) blockers.push('No previous package or legacy plugin backup to restore');
    if (await exists(join(p.manager, 'rolled-back-package'))) blockers.push('Rollback archive slot occupied');
    for (const [from, to] of old) { await noSymlinks(from); await noSymlinks(to); }
    const result = { action: 'rollback', ready: !blockers.length, blockers, restoreCount: old.length, startsServices: false,
      warning: 'Restored legacy plugin Hooks and LaunchAgent files may resume their historical startup behavior on the next application/login. State data is never rewound.' };
    if (options.apply !== true) return result;
    if (blockers.length) throw Error('Rollback refused: ' + blockers.join('; '));
    const lock = join(p.manager, 'install.lock');
    await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    const moved = [];
    try {
      if (await exists(join(p.manager, 'control.lock'))) throw Error('Module control operation in progress');
      const again = await safety();
      if (again.appRunning || again.registeredLabels.length || again.runningWorkers) throw Error('Offline precondition changed');
      if (await exists(p.plugin)) {
        const archive = join(p.manager, 'rolled-back-package');
        await rename(p.plugin, archive); moved.push([p.plugin, archive]);
      }
      for (const [from, to] of old) { await mkdir(dirname(to), { recursive: true, mode: 0o700 }); await rename(from, to); moved.push([from, to]); }
      const { unlink } = await import('node:fs/promises');
      await unlink(lock);
      return { ...result, applied: true };
    } catch (error) {
      for (const [from, to] of moved.reverse()) if (await exists(to) && !(await exists(from))) await rename(to, from);
      throw Error('Rollback failed; inspect install.lock and package paths: ' + error.message);
    }
  }
  return { plan, apply, rollback };
}
