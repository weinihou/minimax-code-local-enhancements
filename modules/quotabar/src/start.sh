#!/bin/bash
# 重启 MiniMax Code 并带上调试端口，然后拉起限额条守护
# 注意：会退出当前运行的桌面端（正在进行的会话会被中断），请在合适的时候手动执行
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/app-proc.sh"
PORT="${QB_PORT:-9333}"
NODE_BIN="${QB_NODE:-$(command -v node || echo $HOME/.local/node/bin/node)}"
APP="/Applications/MiniMax Code.app"
STATE="${QB_STATE_DIR:-$HOME/.minimax/quotabar}"
mkdir -p "$STATE"

echo "==> 停止旧守护"
"$HERE/stop.sh" >/dev/null 2>&1 || true

if app_running; then
  echo "==> 退出正在运行的 MiniMax Code (pid=$(app_pid))"
  osascript -e 'tell application "MiniMax Code" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    app_running || break
    sleep 0.5
  done
  if app_running; then
    echo "    优雅退出超时，强制结束"
    kill -TERM "$(app_pid)" 2>/dev/null
    sleep 2
    app_running && kill -KILL "$(app_pid)" 2>/dev/null
    sleep 1
  fi
  app_running && echo "    警告：进程仍在"
  echo "    已退出：$(app_running && echo 否 || echo 是)"
fi

echo "==> 以 --remote-debugging-port=$PORT 重新启动"
open -a "$APP" --args --remote-debugging-port="$PORT"

echo "==> 等待调试端口就绪"
READY=0
for _ in $(seq 1 80); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "    端口已就绪"
    READY=1
    break
  fi
  sleep 0.5
done

if [ "$READY" != "1" ]; then
  echo "    端口未就绪，检查主进程命令行："
  ps -p "$(app_pid 2>/dev/null || echo 1)" -o command= 2>/dev/null | cut -c1-200
  if ! app_running; then
    echo "    桌面端没起来，改用直接拉起主程序的方式"
    nohup "$APP_MAIN" --remote-debugging-port="$PORT" >/dev/null 2>&1 &
    for _ in $(seq 1 60); do
      curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && { READY=1; echo "    端口已就绪"; break; }
      sleep 0.5
    done
  fi
fi

if [ "$READY" != "1" ]; then
  echo "!! 调试端口没起来，限额条不会出现。日志：$STATE/quotabar.log"
else
  echo "==> 启动限额条守护"
  # 守护必须由 launchd 直接 exec 拉起：nohup 出来的进程会随 launchd 作业结束被连坐杀掉
  launchctl remove com.minimax.quotabar.daemon 2>/dev/null || true
  launchctl submit -l com.minimax.quotabar.daemon -- /bin/bash "$HERE/daemon.sh" 2>/dev/null || true
  sleep 5
  "$HERE/status.sh"
fi
