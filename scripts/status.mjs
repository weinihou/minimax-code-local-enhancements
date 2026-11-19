import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const dataDir = process.env.MINIMAX_DATA_DIR || join(homedir(), '.minimax');
const specs = [
  { name: 'quotabar', labels: ['com.minimax.quotabar.daemon', 'com.minimax.quotabar', 'com.minimax.quotabar.restart-once'] },
  { name: 'credit-guard', labels: ['com.minimax.credit-guard.daemon'] },
];
async function readJSON(path) {
  try { return { ok: true, value: JSON.parse(await readFile(path, 'utf8')) }; }
  catch (error) { return { ok: false, error: error.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
}
async function job(label) {
  if (process.platform !== 'darwin') return { label, supported: false };
  try {
    const { stdout } = await exec('/bin/launchctl', ['list', label], { timeout: 2000, maxBuffer: 16384 });
    return { label, registered: true, running: /"PID"\s*=\s*\d+/.test(stdout) };
  } catch (error) { return { label, registered: error.code === 113 ? false : null, running: null, error: 'not-found-or-unavailable' }; }
}
async function moduleStatus(spec) {
  const [manifest, jobs] = await Promise.all([
    readJSON(join(dataDir, 'plugins', spec.name, '.minimax-plugin/plugin.json')),
    Promise.all(spec.labels.map(job)),
  ]);
  const rawVersion = manifest.value?.version;
  const result = { module: spec.name, installed: manifest.ok ? true : manifest.error === 'missing' ? false : null,
    version: typeof rawVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(rawVersion) ? rawVersion : null, jobs };
  if (spec.name === 'credit-guard') {
    const [enabled, health] = await Promise.all([
      readJSON(join(dataDir, spec.name, 'enabled.json')),
      readJSON(join(dataDir, spec.name, 'health.json')),
    ]);
    result.enabled = enabled.ok ? enabled.value?.enabled === true : null;
    result.enabledFile = enabled.ok ? 'readable' : enabled.error;
    const at = health.value?.at;
    result.health = health.ok ? { ok: health.value?.ok === true,
      fresh: Number.isFinite(at) && Date.now() >= at && Date.now() - at < 60000 } : { error: health.error };
  }
  return result;
}
async function debugStatus() {
  const port = Number(process.env.MCODE_DEBUG_PORT || 9333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { reachable: false, error: 'invalid-port' };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw Error('http');
    const targets = await response.json();
    return { port, reachable: true, appPagePresent: Array.isArray(targets) && targets.some(t => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('app://')) };
  } catch { return { port, reachable: false, error: 'debug-endpoint-unavailable' }; }
}
const [modules, debug] = await Promise.all([
  Promise.all(specs.map(async spec => { try { return await moduleStatus(spec); } catch { return { module: spec.name, error: 'status-unavailable' }; } })),
  debugStatus(),
]);
console.log(JSON.stringify({ readOnly: true, platform: process.platform, debug, modules,
  scope: '进程与配置摘要；不确认页面注入、余额新鲜或会话控制结果。' }, null, 2));
