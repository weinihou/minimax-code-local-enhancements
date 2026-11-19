#!/usr/bin/env node
// SessionStart hook：新会话开始时自检侧边栏限额条，必要时自愈。
//
// 原则：
//   - 只做不会掐断会话的动作（拉守护、重新注入）。
//   - 桌面端没带调试端口时**不自动重启**——那会杀掉正在跑的会话；
//     但巡检 LaunchAgent（src/ensure.sh）会在**会话空闲**时自动带端口重启恢复，
//     所以这里只说明「正在自动恢复」，不要再让用户手动重启。
//   - 一切正常时静默退出，不往上下文里塞噪音。
import { appInfo, portOpen, daemonInfo, installDaemon, readState, injectOnce, PORT } from '../src/quotabar.mjs';

const STALE_MS = 120000;

function emit(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: text,
      },
    }) + '\n',
  );
}

function drainStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), 1500);
  });
}

async function main() {
  await drainStdin();

  const app = appInfo();
  const open = await portOpen(PORT);

  if (!open) {
    if (app.running) {
      emit(
        '侧边栏限额条（quotabar）当前不可用：桌面端在运行但没带 --remote-debugging-port。' +
          '巡检会在当前会话结束后自动带端口重启恢复（自动重启会掐断正在跑的会话，所以现在不动）。' +
          '若需立即恢复，可让 agent 运行 ~/.minimax/quotabar/restart-once.sh。',
      );
    }
    return;
  }

  const notes = [];

  const d = daemonInfo();
  if (!d.running) {
    try {
      installDaemon();
      notes.push('限额条守护进程不在，已重新拉起');
    } catch (e) {
      notes.push('拉起守护失败：' + (e && e.message ? e.message : String(e)));
    }
  }

  try {
    const st = await readState(PORT);
    const stale = !st || !st.barPresent || !st.fetchedAt || Date.now() - st.fetchedAt > STALE_MS;
    if (stale) {
      const r = await injectOnce(PORT);
      if (r && r.ok) notes.push('限额条已重新注入');
      else notes.push('重新注入未成功：' + JSON.stringify(r));
    }
  } catch (e) {
    notes.push('读取注入状态失败：' + (e && e.message ? e.message : String(e)));
  }

  if (notes.length) emit('侧边栏限额条（quotabar）已自愈：' + notes.join('；') + '。');
}

main().catch(() => {
  // hook 失败要 fail open：静默退出，不打扰会话
});
