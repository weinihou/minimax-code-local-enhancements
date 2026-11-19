import { mkdir, readFile, writeFile, rename, chmod, rmdir, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const MODULES = ['quotabar', 'credit-guard'];
const KEYS = ['enabled', 'background', 'autostart', 'autoRestart'];
export function moduleName(name) {
  if (!MODULES.includes(name)) throw Error('Invalid module name');
  return name;
}
export function defaults() {
  return { schemaVersion: 1, modules: Object.fromEntries(MODULES.map(n => [n, Object.fromEntries(KEYS.map(k => [k, false]))])) };
}
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
export function validate(config) {
  if (!exact(config, ['schemaVersion', 'modules']) || config.schemaVersion !== 1 || !exact(config.modules, MODULES)) throw Error('Invalid configuration schema');
  for (const n of MODULES) {
    const m = config.modules[n];
    if (!exact(m, KEYS) || KEYS.some(k => typeof m[k] !== 'boolean')) throw Error('Invalid module configuration');
    if ((m.autostart || m.autoRestart) && !m.background) throw Error('autostart/autoRestart requires background permission');
    if (n === 'credit-guard' && m.autoRestart) throw Error('credit-guard does not support autoRestart');
  }
  return config;
}
export const validateConfig = validate;
export function changesValid(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(k => !KEYS.includes(k) || typeof changes[k] !== 'boolean')) throw Error('Invalid configuration changes');
}
export async function readConfig(dir) {
  try { return validate(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return defaults(); throw e; }
}
export async function atomicJSON(path, value) {
  const temp = path + '.' + randomUUID() + '.pending';
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function locked(dir, fn) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'control.lock');
  const end = Date.now() + 10000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (Date.now() >= end) throw Error('Control busy; lock was not removed'); await new Promise(r => setTimeout(r, 25)); }
  }
  try {
    try { await access(join(dir, 'install.lock')); }
    catch (e) { if (e.code === 'ENOENT') return await fn(); throw e; }
    throw Error('Installation in progress; refusing runtime changes');
  } finally { await rmdir(lock); }
}
