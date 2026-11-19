import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { MODULES, moduleName, validate, changesValid, readConfig, atomicJSON, locked } from './config.mjs';
import { createBackend } from './backend.mjs';
import { pageAdapters } from './adapters.mjs';
import { readRuntimeSummary } from './summary.mjs';
export function createController(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.MINIMAX_DATA_DIR || join(homedir(), '.minimax'));
  const pluginRoot = resolve(options.pluginRoot || fileURLToPath(new URL('..', import.meta.url)));
  const dir = join(dataDir, 'local-enhancements');
  const port = options.port ?? 9333;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid CDP port');
  const backend = options.backend || createBackend({ dataDir, pluginRoot, port, nodePath: options.nodePath || process.execPath, ...options.backendOptions });
  const pages = options.pages || pageAdapters(pluginRoot, port, dataDir);
  const automaticRestart = { implemented: true, strategy: 'complete-session-index-idle', missingCDP: 'deferred', consecutiveFailures: 3, cooldownMs: 1200000 };
  const writeEnabled = async enabled => {
    const stateDir = join(dataDir, 'credit-guard');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await atomicJSON(join(stateDir, 'enabled.json'), { enabled });
  };
  async function stopInternal(name) {
    if (name === 'credit-guard') await writeEnabled(false);
    const result = await backend.stop(name);
    if (name === 'quotabar') {
      try { await pages.dispose(); return { ...result, cleanup: 'complete' }; }
      catch { return { ...result, cleanup: 'unavailable', needsPageReload: true }; }
    }
    return result;
  }
  async function startInternal(name, config) {
    const m = config.modules[name];
    if (!m.enabled) throw Error('Module is disabled; configure enabled explicitly');
    if (name === 'credit-guard' && !m.background) throw Error('credit-guard requires background permission');
    if (!m.background) return { module: name, mode: 'page-only', residentProcess: false, pageRefreshTimers: true, ...await pages.inject() };
    if (name === 'credit-guard') await writeEnabled(true);
    await backend.autostart(name, m.autostart);
    return { module: name, mode: 'background', ...await backend.start(name, m), automaticRestart: name === 'quotabar' && m.autoRestart ? automaticRestart : null };
  }
  return {
    async status() {
      const config = await readConfig(dir);
      const entries = await Promise.all(MODULES.map(async name => {
        try { return [name, { permissions: config.modules[name], runtime: await readRuntimeSummary(dir, name), ...await backend.info(name), autostartRegistered: await backend.autostartPresent(name), automaticRestart: name === 'quotabar' && config.modules[name].autoRestart ? automaticRestart : null }]; }
        catch { return [name, { permissions: config.modules[name], error: 'Runtime status unavailable' }]; }
      }));
      return { schemaVersion: 1, modules: Object.fromEntries(entries) };
    },
    async configure(name, changes) {
      moduleName(name); changesValid(changes);
      return locked(dir, async () => {
        const config = await readConfig(dir);
        const old = config.modules[name];
        const next = { ...old, ...changes };
        config.modules[name] = next;
        validate(config);
        await atomicJSON(join(dir, 'config.json'), config);
        let runtime = null;
        if (!next.enabled || !next.background) runtime = await stopInternal(name);
        await backend.autostart(name, next.enabled && next.background && next.autostart);
        return { module: name, permissions: next, runtime };
      });
    },
    async start(name) {
      moduleName(name);
      return locked(dir, async () => {
        const config = await readConfig(dir);
        if (name === 'credit-guard' && !config.modules[name].background) throw Error('credit-guard requires background permission');
        const wasEnabled = config.modules[name].enabled;
        config.modules[name].enabled = true;
        await atomicJSON(join(dir, 'config.json'), config);
        try { return await startInternal(name, config); }
        catch (error) {
          config.modules[name].enabled = wasEnabled;
          await atomicJSON(join(dir, 'config.json'), config);
          if (!wasEnabled) await stopInternal(name).catch(() => {});
          throw error;
        }
      });
    },
    async stop(name) {
      moduleName(name);
      return locked(dir, async () => {
        const config = await readConfig(dir);
        config.modules[name].enabled = false;
        await atomicJSON(join(dir, 'config.json'), config);
        return { module: name, ...await stopInternal(name) };
      });
    }, 
    async repair(name) {
      moduleName(name);
      return locked(dir, async () => ({ ...await startInternal(name, await readConfig(dir)), applicationRestarted: false }));
    },
    async sessionStart() {
      const config = await readConfig(dir);
      const results = {};
      for (const name of MODULES) {
        const m = config.modules[name];
        if (!m.enabled || !m.background || !m.autostart) { results[name] = { skipped: true }; continue; }
        try {
          results[name] = await locked(dir, async () => {
            const current = await readConfig(dir);
            const permission = current.modules[name];
            if (!permission.enabled || !permission.background || !permission.autostart) return { skipped: true };
            return startInternal(name, current);
          });
        } catch { results[name] = { error: 'Module start failed' }; }
      }
      return results;
    },
  };
}
