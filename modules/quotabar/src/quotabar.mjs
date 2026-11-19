// quotabar 共享库：CDP 客户端 + 状态探测 + 守护管理
// 零依赖。插件包内不放 symlink（插件扫描器会拒），也不放 node_modules。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const HOME = process.env.HOME || homedir();
// 运行期状态（日志、pid）放插件包外，插件包本身保持只读
export const STATE_DIR = process.env.QB_STATE_DIR || join(HOME, '.minimax', 'quotabar');
export const PORT = Number(process.env.QB_PORT || 9333);
export const LABEL = 'com.minimax.quotabar.daemon';
export const PAGE_SCRIPT = join(SRC_DIR, 'page-script.js');
export const INJECTOR = join(SRC_DIR, 'injector.mjs');
export const DAEMON_SH = join(SRC_DIR, 'daemon.sh');
// 主进程路径按 bundle 匹配，别写死整串
const APP_MAIN_RE = /\/MiniMax Code\.app\/Contents\/MacOS\/MiniMax Code(\s|$)/;

export function log(...parts) {
  process.stderr.write(`[quotabar] ${parts.join(' ')}\n`);
}

// launchd 环境里没有 node（PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin），
// 守护脚本里要用绝对路径
export function resolveNode() {
  const candidates = [
    process.env.QB_NODE,
    join(HOME, '.local', 'node', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return 'node';
}

export function ensureStateDir() {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* 忽略 */ }
}

// ---------- CDP ----------

export async function listTargets(port = PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`json/list HTTP ${res.status}`);
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || 'cdp error'));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
    ws.addEventListener('close', () => {
      for (const { reject: rej } of pending.values()) rej(new Error('ws closed'));
      pending.clear();
    });
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timeout`)); }
        }, 15000);
      });
    ws.addEventListener('open', () =>
      resolve({ send, close: () => { try { ws.close(); } catch { /* 已关闭 */ } } }),
    );
  });
}

export async function evalInApp(expression, port = PORT) {
  const targets = await listTargets(port);
  const target = targets.find((t) => t.url?.startsWith('app://'));
  if (!target) throw new Error('没有可注入的页面目标');
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    const r = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'evaluate exception');
    }
    return r.result?.value ?? null;
  } finally {
    client.close();
  }
}

// ---------- 页面状态 ----------

export async function injectOnce(port = PORT) {
  const script = readFileSync(PAGE_SCRIPT, 'utf8');
  return evalInApp(script, port);
}

const READ_STATE = `(()=>{const S=window.__QB_QUOTA__||{};const d=S.last||null;const bar=document.getElementById('qb-quota-bar');const tip=document.getElementById('qb-quota-tip');return {
  status:S.status||null,
  strategy:S.strategy||null,
  error:S.lastError||null,
  credits:S.credits?S.credits.text:null,
  cards:S.cards?S.cards.count:null,
  remain5:d?d.remain5:null,
  reset5:d?d.reset5:null,
  reset5In:d?d.reset5In:null,
  unlimited:d?!!d.unlimited:null,
  barPresent:!!bar,
  barVisible:bar?bar.style.display!=='none':false,
  tipShown:tip?tip.getAttribute('data-show')==='1':false,
  fetchedAt:S.lastFetchAt||null};})()`;

export async function readState(port = PORT) {
  return evalInApp(READ_STATE, port);
}

// ---------- 进程与守护 ----------

// macOS 的 pgrep -f 对 "$" 锚点不可靠，统一用 ps + 匹配主程序路径
export function appInfo() {
  let out = '';
  try {
    out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  } catch {
    return { running: false, hasPort: false, pid: null };
  }
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    if (APP_MAIN_RE.test(m[2])) {
      return {
        running: true,
        pid: Number(m[1]),
        hasPort: /--remote-debugging-port=\d+/.test(m[2]),
      };
    }
  }
  return { running: false, hasPort: false, pid: null };
}

export function daemonInfo() {
  let out = '';
  try {
    out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
  } catch {
    return { running: false, pid: null };
  }
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 3 && cols[2] === LABEL) {
      const pid = cols[0];
      return { running: pid !== '-', pid: pid === '-' ? null : Number(pid) };
    }
  }
  return { running: false, pid: null };
}

// 守护必须由 launchd 直接拉起：被别的 launchd 作业用 nohup 间接拉起，
// 作业一结束就被连坐 SIGTERM
export function installDaemon() {
  ensureStateDir();
  try { execFileSync('launchctl', ['remove', LABEL], { stdio: 'ignore' }); } catch { /* 本来就没有 */ }
  execFileSync('launchctl', ['submit', '-l', LABEL, '--', '/bin/bash', DAEMON_SH], { stdio: 'ignore' });
}

export function uninstallDaemon() {
  try { execFileSync('launchctl', ['remove', LABEL], { stdio: 'ignore' }); } catch { /* 本来就没有 */ }
}

export async function portOpen(port = PORT) {
  try {
    await listTargets(port);
    return true;
  } catch {
    return false;
  }
}

// ---------- 汇总 ----------

export async function fullStatus(port = PORT) {
  const app = appInfo();
  const daemon = daemonInfo();
  const open = await portOpen(port);
  const out = {
    port,
    portOpen: open,
    app,
    daemon,
    needsManualRestart: app.running && !app.hasPort,
    state: null,
    injectError: null,
  };
  if (open) {
    try { out.state = await readState(port); } catch (e) { out.state = { error: String(e) }; }
  }
  return out;
}

export function formatStatus(s) {
  const d = s.state || {};
  const lines = [];
  lines.push(`调试端口 ${s.port}：${s.portOpen ? '已就绪' : '未开启'}`);
  lines.push(`桌面端：${s.app.running ? `运行中 pid=${s.app.pid}${s.app.hasPort ? '（带调试端口）' : '（无调试端口）'}` : '未运行'}`);
  lines.push(`守护进程：${s.daemon.running ? `运行中 pid=${s.daemon.pid} (launchd)` : '未运行'}`);
  if (s.needsManualRestart) {
    lines.push('→ 需要用户手动重启一次桌面端（带 --remote-debugging-port），这一步不能自动做：会掐断正在跑的会话');
  }
  if (d.status) lines.push(`注入状态：${d.status}${d.strategy ? `（${d.strategy}）` : ''}${d.error ? ` 错误=${d.error}` : ''}`);
  if (d.barPresent !== undefined) lines.push(`侧边栏限额条：${d.barPresent ? (d.barVisible ? '已渲染' : '已渲染但空间不足被隐藏') : '未找到'}`);
  if (d.remain5 !== null && d.remain5 !== undefined) {
    lines.push(`5 小时剩余：${d.unlimited ? '不限额' : `${d.remain5}%`}${d.reset5 ? ` 重置=${d.reset5}${d.reset5In ? `（${d.reset5In.replace('后重置', '后')}）` : ''}` : ''}`);
  }
  if (d.credits) lines.push(`积分：${d.credits}`);
  if (d.cards !== null && d.cards !== undefined) lines.push(`可用重置卡：${d.cards} 张`);
  return lines.join('\n');
}
