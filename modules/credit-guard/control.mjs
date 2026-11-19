import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const LABEL = 'com.minimax.credit-guard.daemon';
const exec = promisify(execFile);
const daemonPath = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
const unsupported = () => ({ supported: false, platform: process.platform, message: '积分限额守护仅支持 macOS；未执行系统命令或更改状态。' });

async function readJson(filename) {
  try {
    return { value: JSON.parse(await readFile(filename, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

async function settings() {
  const lib = await import('./lib.mjs');
  return { ...lib, enabledPath: path.join(lib.STATE_DIR, 'enabled.json') };
}

async function writeEnabled(enabled) {
  const { STATE_DIR, enabledPath } = await settings();
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${enabledPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ enabled }) + '\n', { mode: 0o600 });
  await rename(temporary, enabledPath);
}

async function launchStatus() {
  try {
    const { stdout } = await exec('/bin/launchctl', ['list', LABEL], { timeout: 1500, maxBuffer: 16384 });
    const pid = stdout.match(/"PID"\s*=\s*(\d+)/);
    const exitCode = stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
    return { registered: true, running: !!pid, pid: pid ? Number(pid[1]) : null, lastExitStatus: exitCode ? Number(exitCode[1]) : null };
  } catch (error) {
    return { registered: false, running: false, error: error.code === 113 ? null : 'launchctl-job-unavailable' };
  }
}

function safeState(state) {
  if (!state || typeof state !== 'object') return null;
  const scalar = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const engine = state.engine || state;
  const sessions = Array.isArray(engine.sessions) ? engine.sessions : [];
  return {
    version: scalar(engine.version),
    periodKey: typeof engine.periodKey === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00\+08:00$/.test(engine.periodKey) ? engine.periodKey : null,
    balanceBaseline: scalar(engine.balanceBaseline),
    updatedAt: scalar(state.updatedAt),
    lastFreshAt: scalar(state.lastFreshAt),
    hasCreditError: !!state.creditError,
    sessionCount: sessions.length,
    enabledSessionCount: sessions.filter(item => item?.enabled === true).length,
    budgetPausedSessionCount: sessions.filter(item => item?.budgetPause?.ownership === 'budget').length,
  };
}

export async function status() {
  if (process.platform !== 'darwin') return unsupported();
  const { STATE_DIR, enabledPath, evalInApp } = await settings();
  const [enabled, state, daemon, health] = await Promise.all([
    readJson(enabledPath), readJson(path.join(STATE_DIR, 'state.json')), launchStatus(), readJson(path.join(STATE_DIR, 'health.json')),
  ]);
  let page;
  try {
    const result = await evalInApp(`(() => {
      const page = globalThis.__CREDIT_GUARD_PAGE__;
      return { present: !!page, version: page?.version ?? null, hasLastError: !!page?.lastError };
    })()`);
    page = { reachable: true, present: result?.present === true,
      version: typeof result?.version === 'number' || (typeof result?.version === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(result.version)) ? result.version : null,
      lastError: result?.hasLastError ? '页面适配器报告错误（已隐藏原始错误内容）' : null };
  } catch {
    page = { reachable: false, error: 'app-debug-connection-unavailable' };
  }
  return { supported: true, enabled: enabled.value?.enabled === true, enabledFile: enabled.error,
    daemon: { label: LABEL, ...daemon }, state: safeState(state.value), stateFile: state.error,
    health: health.value ? { ok: health.value.ok === true, at: health.value.at, fresh: Date.now() - health.value.at < 60000 } : null, page };
}

export async function ensureRunning() {
  if (process.platform !== 'darwin') return unsupported();
  const { enabledPath } = await settings();
  const enabled = await readJson(enabledPath);
  if (enabled.value?.enabled !== true) return { supported: true, requested: false, enabled: false, message: '未启用守护，不自动启动。' };
  const current = await launchStatus();
  if (current.running) return { supported: true, requested: true, alreadyRunning: true, message: '守护已在运行；保留现有进程，由守护处理注入。' };
  try {
    await exec('/bin/launchctl', ['submit', '-l', LABEL, '--', process.execPath, daemonPath], { timeout: 2000, maxBuffer: 16384 });
  } catch {
    const after = await launchStatus();
    if (!after.running) {
      if (!after.registered) return { supported: true, requested: false, error: 'launchctl-submit-failed', message: '启动请求未确认成功；未移除或重启已有任务，请查询状态。' };
      // submit 保留已退出的 job；start 复用它，不移除或打断运行中的进程。
      try {
        await exec('/bin/launchctl', ['start', LABEL], { timeout: 2000, maxBuffer: 16384 });
      } catch {
        return { supported: true, requested: false, error: 'launchctl-start-failed', message: '已登记任务的启动请求失败；请查询状态。' };
      }
    }
  }
  return { supported: true, requested: true, alreadyRunning: false, message: '已请求启动守护；注入是否完成请查询状态。' };
}

export async function enable() {
  if (process.platform !== 'darwin') return unsupported();
  await writeEnabled(true);
  return { ...await ensureRunning(), enabled: true };
}

export async function repair() {
  return enable();
}

export async function disable() {
  if (process.platform !== 'darwin') return unsupported();
  await writeEnabled(false);
  return { supported: true, enabled: false, requested: true,
    message: '已请求停用；守护将在安全轮次清理页面与适配器后退出，正在执行的停止或恢复操作不会被强制中断。' };
}
