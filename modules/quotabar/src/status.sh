#!/bin/bash
# 查看限额条守护状态
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/app-proc.sh"
PORT="${QB_PORT:-9333}"
STATE="${QB_STATE_DIR:-$HOME/.minimax/quotabar}"

printf "调试端口 %s : " "$PORT"
if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "已就绪"
else
  echo "未开启（当前实例没带 --remote-debugging-port，执行 start.sh 重启一次）"
fi

printf "守护进程     : "
JOB_PID="$(launchctl list 2>/dev/null | awk '/com\.minimax\.quotabar\.daemon/ {print $1}')"
if [ -n "$JOB_PID" ] && [ "$JOB_PID" != "-" ] && kill -0 "$JOB_PID" 2>/dev/null; then
  echo "运行中 pid=$JOB_PID (launchd)"
elif [ -f "$STATE/injector.pid" ]; then
  PID="$(cat "$STATE/injector.pid")"
  if kill -0 "$PID" 2>/dev/null; then echo "运行中 pid=$PID"; else echo "未运行（pid 文件残留）"; fi
else
  echo "未运行"
fi

printf "桌面端实例   : "
if app_running; then
  if app_has_port; then echo "运行中（带调试端口）"; else echo "运行中（无调试端口）"; fi
else
  echo "未运行"
fi

echo "---- 最近日志 ----"
if [ -f "$STATE/quotabar.log" ]; then
  tail -n 12 "$STATE/quotabar.log"
else
  echo "（无日志）"
fi
