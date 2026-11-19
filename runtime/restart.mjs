import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicJSON, locked, readConfig } from './config.mjs';
const execute = promisify(execFile);
export function createApplication({ port = 9333, execCommand = execute, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, quitTimeout = 30000 } = {}) {
  async function running() {
    const { stdout } = await execCommand('/bin/ps', ['-axo', 'command=']);
    return stdout.split('\n').some(line => /\/MiniMax Code\.app\/Contents\/MacOS\/MiniMax Code(?:\s|$)/.test(line));
  }
  return {
    running,
    async quit() {
      await execCommand('/usr/bin/osascript', ['-e', 'if application "MiniMax Code" is running then tell application "MiniMax Code" to quit'], { timeout: quitTimeout });
    },
    async waitForExit() {
      const deadline = now() + quitTimeout;
      while (await running()) {
        if (now() >= deadline) return false;
        await sleep(200);
      }
      return true;
    },
    async open() { await execCommand('/usr/bin/open', ['-a', 'MiniMax Code', '--args', `--remote-debugging-port=${port}`]); },
  };
}
export function createRestarter({ dir, pages, application = createApplication(), now = Date.now, cooldown = 20 * 60 * 1000, signal = new AbortController().signal }) {
  const result = (state, reason) => ({ state, reason });
  async function authorized() {
    if (signal.aborted) return false;
    const m = (await readConfig(dir)).modules.quotabar;
    return m.enabled && m.background && m.autoRestart;
  }
  async function proof() {
    const p = await pages.proveIdle();
    return p?.safe === true && p.complete === true && Number.isInteger(p.sessionCount) && p.sessionCount >= 0 && Number.isFinite(p.checkedAtMs) && now() - p.checkedAtMs >= 0 && now() - p.checkedAtMs < 5000;
  }
  return async function restart() {
    try {
      if (!await authorized()) return result('blocked', 'permission-revoked');
      if (!await pages.portAvailable()) return result('deferred', 'cdp-unavailable');
      if (!await proof()) return result('deferred', 'global-idle-unproven');
      const reserved = await locked(dir, async () => {
        if (!await authorized()) return false;
        let last;
        try { last = JSON.parse(await readFile(join(dir, 'restart-attempt.json'), 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (last && (!Number.isFinite(last.at) || now() - last.at < cooldown)) return false;
        await atomicJSON(join(dir, 'restart-attempt.json'), { at: now() });
        return true;
      });
      if (!reserved) return result('deferred', 'cooldown-or-permission-revoked');
      if (!await application.running()) return result('deferred', 'application-already-closed');
      if (!await pages.portAvailable() || !await proof()) return result('deferred', 'global-idle-recheck-failed');
      if (!await authorized()) return result('blocked', 'permission-revoked');
      await application.quit();
      if (!await application.waitForExit()) return result('blocked', 'graceful-quit-not-complete');
      if (!await authorized()) return result('blocked', 'permission-revoked-after-quit');
      await application.open();
      return result('restarted', 'global-idle-confirmed');
    } catch { return result('deferred', 'restart-check-or-operation-failed'); }
  };
}
