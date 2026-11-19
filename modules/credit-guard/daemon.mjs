import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
import { GuardEngine } from './engine.mjs';
import { loadJSON, saveJSON, inject, pageCall, evalInApp } from './lib.mjs';
const lock = net.createServer(socket => socket.destroy());
lock.on('error', e => { process.stderr.write('credit-guard: ' + e.message + '\n'); process.exit(e.code === 'EADDRINUSE' ? 0 : 1); });
lock.listen(19334, '127.0.0.1', async () => {
  let engine;
  try {
    const state = await loadJSON('state.json', null);
    if (state && (state.engine?.version !== 1 || !Array.isArray(state.engine?.sessions))) throw Error('Invalid persisted state; refusing to reset counters');
    engine = new GuardEngine({ state, call: pageCall, save: s => saveJSON('state.json', s) });
  } catch (e) { process.stderr.write(String(e) + '\n'); process.exit(1); }
  async function authorized() {
    const dir = process.env.LOCAL_ENHANCEMENTS_CONFIG_DIR;
    if (!dir) return true;
    try {
      const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
      const m = config.modules?.['credit-guard'];
      return config.schemaVersion === 1 && m?.enabled === true && m.background === true;
    } catch { return false; }
  }
  while (!stopping) {
    try {
      if (!(await authorized()) || !(await loadJSON('enabled.json', { enabled: false })).enabled) break;
      const result = await inject();
      if (!result?.ready || !result?.ui) throw Error('Page adapter injection unavailable');
      await engine.tick();
      await saveJSON('health.json', { pid: process.pid, at: Date.now(), ok: true, error: null });
    } catch (e) {
      await saveJSON('health.json', { pid: process.pid, at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 500) }).catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  for (const item of engine.state.engine.sessions) {
    if (item.budgetPause) { item.budgetPause.resumeAllowed = false; item.budgetPause.ownership = 'manual'; item.phase = 'manual'; }
  }
  await engine.persist();
  try { await evalInApp('window.__CREDIT_GUARD_PAGE__?.dispose(); window.__CREDIT_GUARD_UI__?.dispose(); true'); } catch {}
  lock.close(); process.exit(0);
});
