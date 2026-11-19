#!/usr/bin/env node
// MiniMax Code 侧边栏限额条：CDP 注入守护
// 用法: node injector.mjs [--once] [--port 9333] [--shot out.png] [--eval <expr>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SRC_DIR, STATE_DIR, PORT, PAGE_SCRIPT, ensureStateDir, listTargets, connect, evalInApp, injectOnce,
} from './quotabar.mjs';

const HERE = SRC_DIR;
const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const PORT_ARG = Number(args[args.indexOf('--port') + 1]) || PORT;
const SHOT = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : null;
const EVAL = args.includes('--eval') ? args[args.indexOf('--eval') + 1] : null;
const LOG = path.join(STATE_DIR, 'quotabar.log');
const PAGE_SCRIPT_PATH = PAGE_SCRIPT;
const EVAL_EVERY_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try { fs.appendFileSync(LOG, line); } catch { /* 忽略 */ }
  process.stdout.write(line);
}

async function tryAllTargets() {
  const targets = await listTargets(PORT_ARG);
  if (!targets.length) throw new Error('没有可注入的页面目标');
  const attempts = [];
  for (const t of targets) {
    let client;
    try {
      client = await connect(t.webSocketDebuggerUrl);
      if (EVAL) {
        const r = await client.send('Runtime.evaluate', { expression: EVAL, awaitPromise: true, returnByValue: true });
        const v = r.exceptionDetails
          ? { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
          : r.result?.value;
        console.log('EVAL', t.url, JSON.stringify(v, null, 2));
        client.close();
        continue;
      }
      // 每轮重读，改了 page-script.js 不用重启守护
      const expression = fs.readFileSync(PAGE_SCRIPT_PATH, 'utf8');
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
      const value = r.result?.value ?? null;
      attempts.push({ url: t.url, value });
      if (value && value.ok) {
        if (SHOT) await shoot(client, SHOT);
        client.close();
        return { hit: true, attempts };
      }
      client.close();
    } catch (e) {
      attempts.push({ url: t.url, value: { ok: false, error: String(e) } });
      if (client) client.close();
    }
  }
  if (EVAL) return { hit: true, attempts };
  return { hit: false, attempts };
}

async function shoot(client, file) {
  try {
    const r = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    log(`截图已保存 ${file}`);
  } catch (e) {
    log('截图失败 ' + String(e.message || e));
  }
}

function describe(value) {
  if (!value) return 'null';
  const d = value.data;
  const s = [
    `status=${value.status}`,
    value.strategy ? `via=${value.strategy}` : null,
    value.error ? `err=${value.error}` : null,
    d ? `5h剩余=${d.remain5}% 重置=${d.reset5 || '-'}` : null,
    value.credits ? `积分=${value.credits}` : null,
    value.cards !== null && value.cards !== undefined ? `重置卡=${value.cards}张` : null,
  ].filter(Boolean);
  return s.join(' ');
}

async function main() {
  if (typeof globalThis.WebSocket === 'undefined') {
    log('FATAL 当前 node 不支持全局 WebSocket，需要 node >= 22');
    process.exit(2);
  }
  ensureStateDir();
  log(`=== quotabar 启动 port=${PORT_ARG} once=${ONCE} pid=${process.pid} script=${PAGE_SCRIPT_PATH}`);
  let lastSig = null;
  for (;;) {
    try {
      const { hit, attempts } = await tryAllTargets();
      const sig = JSON.stringify(attempts.map((a) => [a.url, a.value?.status, a.value?.data?.remain5]));
      if (sig !== lastSig) {
        lastSig = sig;
        for (const a of attempts) log(`[target] ${a.url} -> ${describe(a.value)}`);
        log(hit ? 'OK 已注入' : 'WARN 未命中主窗口');
      }
      if (ONCE) break;
    } catch (e) {
      const msg = String(e.message || e);
      if (msg !== lastSig) { lastSig = msg; log('WAIT ' + msg); }
      if (ONCE) break;
    }
    await sleep(EVAL_EVERY_MS);
  }
  log('退出');
}

process.on('SIGTERM', () => { log('收到 SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { log('收到 SIGINT'); process.exit(0); });
main().catch((e) => { log('FATAL ' + (e.stack || e)); process.exit(1); });
