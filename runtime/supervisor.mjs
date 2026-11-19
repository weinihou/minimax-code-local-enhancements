import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig, moduleName, atomicJSON } from './config.mjs';
import { pageAdapters } from './adapters.mjs';
import { createRestarter, createApplication } from './restart.mjs';
import { writeRuntimeSummary } from './summary.mjs';
export async function runSupervisor({ name, dataDir, pluginRoot, port = 9333, spawnChild = spawn, pages = pageAdapters(pluginRoot, port, dataDir), sleep = ms => new Promise(r => setTimeout(r, ms)), signal = new AbortController().signal, onState = () => {}, now = Date.now, application = createApplication({ port }) }) {
  moduleName(name);
  const dir = join(dataDir, 'local-enhancements');
  let child;
  let childExited = false;
  let childDone;
  let lastInjection = -Infinity;
  let failures = 0;
  const restart = createRestarter({ dir, pages, application, signal, now });
  try {
    while (!signal.aborted) {
      const config = await readConfig(dir);
      const permission = config.modules[name];
      if (!permission.enabled || !permission.background) break;
      if (name === 'credit-guard') {
        if (!child) {
          const stateDir = join(dataDir, 'credit-guard');
          await mkdir(stateDir, { recursive: true, mode: 0o700 });
          await atomicJSON(join(stateDir, 'enabled.json'), { enabled: true });
          child = spawnChild(process.execPath, [join(pluginRoot, 'modules/credit-guard/daemon.mjs')], {
            stdio: 'ignore', env: { ...process.env, MINIMAX_DATA_DIR: dataDir, CREDIT_GUARD_STATE_DIR: join(dataDir, 'credit-guard'), CREDIT_GUARD_PORT: String(port), LOCAL_ENHANCEMENTS_CONFIG_DIR: dir },
          });
          childDone = new Promise((resolve, reject) => {
            child.once('exit', () => { childExited = true; resolve(); });
            child.once('error', reject);
          });
          childDone.catch(() => {});
          await onState({ state: 'starting', reason: 'daemon-start-requested' });
        }
        if (childExited) break;
      } else if (now() - lastInjection >= 30000) {
        lastInjection = now();
        try {
          const injected = await pages.inject();
          if (injected?.injected === false) throw Error('Injection failed');
          failures = 0;
          await onState({ state: 'injected' });
        } catch {
          failures++;
          if (permission.autoRestart && failures >= 3) await onState({ ...await restart(), consecutiveFailures: failures });
          else await onState({ state: 'unavailable', reason: 'app-page-unavailable', consecutiveFailures: failures });
        }
      }
      await sleep(1000);
    }
  } finally {
    if (child && !childExited) { child.kill('SIGTERM'); await childDone; }
    if (name === 'quotabar') await pages.dispose().catch(() => {});
    await onState({ state: 'stopped', reason: 'supervisor-exited' });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const abort = new AbortController();
  process.on('SIGTERM', () => abort.abort());
  process.on('SIGINT', () => abort.abort());
  const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
  runSupervisor({ name: process.argv[2], dataDir: resolve(process.env.MINIMAX_DATA_DIR || join(homedir(), '.minimax')), pluginRoot, port: Number(process.env.QB_PORT || 9333), signal: abort.signal,
    onState: summary => writeRuntimeSummary(join(resolve(process.env.MINIMAX_DATA_DIR || join(homedir(), '.minimax')), 'local-enhancements'), process.argv[2], summary),
  })
    .catch(async () => {
      process.exitCode = 1;
      await writeRuntimeSummary(join(resolve(process.env.MINIMAX_DATA_DIR || join(homedir(), '.minimax')), 'local-enhancements'), process.argv[2], { state: 'unavailable', reason: 'supervisor-failed' }).catch(() => {});
    });
}
