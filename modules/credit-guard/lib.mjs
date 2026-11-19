import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
export const ROOT = dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = process.env.CREDIT_GUARD_STATE_DIR || join(homedir(), '.minimax', 'credit-guard');
export async function loadJSON(name, fallback) {
  try { return JSON.parse(await readFile(join(STATE_DIR, name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function saveJSON(name, value) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const path = join(STATE_DIR, name);
  await writeFile(path + '.pending', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.pending', path);
}
export const PORT = Number(process.env.CREDIT_GUARD_PORT || 9333);
export async function evalInApp(expression, port = PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw Error('CDP endpoint HTTP ' + res.status);
  const target = (await res.json()).find(t => t.type === 'page' && t.url.startsWith('app://') && t.webSocketDebuggerUrl);
  if (!target) throw Error('MiniMax Code app page unavailable');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(Error('CDP request timed out')), 25000);
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timeout); ws.close();
      error ? reject(error) : resolve(value);
    }
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression, awaitPromise: true, returnByValue: true,
    } })));
    ws.addEventListener('message', ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      if (msg.error) return finish(Error(msg.error.message));
      if (msg.result.exceptionDetails) return finish(Error(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text));
      finish(null, msg.result.result?.value ?? null);
    });
    ws.addEventListener('error', () => finish(Error('CDP connection failed')));
    ws.addEventListener('close', () => finish(Error('CDP connection closed')));
  });
}
export async function inject(port = PORT) {
  const adapter = await readFile(join(ROOT, 'page-adapter.js'), 'utf8');
  const ui = await readFile(join(ROOT, 'ui.js'), 'utf8');
  return evalInApp(adapter + '\n; if (!window.__CREDIT_GUARD_UI__) { ' + ui + '\n }\n; ({ready:!!window.__CREDIT_GUARD_PAGE__,ui:!!window.__CREDIT_GUARD_UI__})', port);
}
export function pageCall(method, ...args) {
  if (!/^[A-Za-z]+$/.test(method)) throw Error('Invalid page method');
  return evalInApp(`window.__CREDIT_GUARD_PAGE__.${method}(...${JSON.stringify(args)})`);
}
export function captureOf(s) {
  return { updatedAt: s.updatedAt, lastMsgId: s.lastMsgId, goalId: s.goal?.goalId ?? null, goalUpdatedAt: s.goal?.updatedAt ?? null };
}
export function sameCapture(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
export function nextReset(now = Date.now()) {
  const d = new Date(now + 8 * 3600000);
  const hour = Math.floor(d.getUTCHours() / 5) * 5;
  d.setUTCHours(hour === 20 ? 24 : hour + 5, 0, 0, 0);
  return d.getTime() - 8 * 3600000;
}
