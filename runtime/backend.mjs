import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
const exec = promisify(execFile);
export const labelFor = n => `com.minimax.local-enhancements.${n}`;
const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function createBackend({ dataDir, pluginRoot, port, nodePath, launchAgentsDir = join(homedir(), 'Library/LaunchAgents'), execCommand = exec, stopTimeout = 90000 }) {
  const plist = n => join(launchAgentsDir, labelFor(n) + '.plist');
  const command = n => ['/usr/bin/env', `MINIMAX_DATA_DIR=${dataDir}`, `CREDIT_GUARD_STATE_DIR=${join(dataDir, 'credit-guard')}`, `QB_STATE_DIR=${join(dataDir, 'quotabar')}`, `CREDIT_GUARD_PORT=${port}`, `QB_PORT=${port}`, `QB_NODE=${nodePath}`, nodePath, join(pluginRoot, 'runtime/supervisor.mjs'), n];
  async function info(n) {
    const { stdout } = await execCommand('/bin/launchctl', ['list']);
    const line = stdout.split('\n').map(l => l.trim().split(/\s+/)).find(c => c[2] === labelFor(n));
    return { registered: !!line, running: !!line && /^\d+$/.test(line[0]), pid: line && /^\d+$/.test(line[0]) ? Number(line[0]) : null };
  }
  async function unregister(n) {
    if ((await info(n)).registered) await execCommand('/bin/launchctl', ['remove', labelFor(n)]);
    await unlink(plist(n)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  return {
    info,
    async stop(n) {
      let state = await info(n);
      if (state.running) {
        await execCommand('/bin/launchctl', ['kill', 'SIGTERM', `gui/${process.getuid()}/${labelFor(n)}`]);
        const deadline = Date.now() + stopTimeout;
        do {
          await new Promise(r => setTimeout(r, 100));
          state = await info(n);
          if (!state.running) break;
        } while (Date.now() < deadline);
        if (state.running) throw Error('Graceful stop pending; refusing forced removal');
      }
      await unregister(n);
      return { stopped: true };
    },
    unregister,
    async autostart(n, enabled) {
      if (!enabled) { await unlink(plist(n)).catch(e => { if (e.code !== 'ENOENT') throw e; }); return; }
      await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
      const args = command(n).map(a => `<string>${xml(a)}</string>`).join('');
      await writeFile(plist(n), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${labelFor(n)}</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/></dict></plist>\n`, { mode: 0o600 });
    },
    async start(n, { autostart }) {
      if ((await info(n)).running) return { running: true, alreadyRunning: true };
      if ((await info(n)).registered) await unregister(n);
      if (autostart) {
        // unregister may have removed the plist of a completed job.
        await this.autostart(n, true);
        await execCommand('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist(n)]);
      } else await execCommand('/bin/launchctl', ['submit', '-l', labelFor(n), '--', ...command(n)]);
      return { requested: true, running: null };
    },
    async autostartPresent(n) { try { await access(plist(n)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } },
  };
}
