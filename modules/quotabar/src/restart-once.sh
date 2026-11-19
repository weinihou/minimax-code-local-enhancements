#!/bin/bash
# 一次性：重启桌面端并带上 --remote-debugging-port，让限额条能注入。
# 幂等 + 节流：
#   · 桌面端已经带端口 → 直接退出，不会把 app 反复重启
#   · 距上次尝试不足 20 分钟 → 直接退出，避免 app 起不来时无限重试
# 由 launchd 承载（app 一退出它还活着），所以桌面端重启后仍能完成注入。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/app-proc.sh"
PORT="${QB_PORT:-9333}"
APP="/Applications/MiniMax Code.app"
# 日志和状态标记属于运行期状态，写状态目录，别写进插件包
STATE="${QB_STATE_DIR:-$HOME/.minimax/quotabar}"
LOG="$STATE/quotabar.log"
STAMP="$STATE/restart-once.stamp"
COOLDOWN=1200
NODE_BIN="${QB_NODE:-$HOME/.local/node/bin/node}"
mkdir -p "$STATE"

log() { echo "[$(date '+%F %T')] $*" >>"$LOG"; }

# 无论走哪条退出路径都要卸载作业，否则巡检下次 bootstrap 会因「已加载」失败而再也触发不了
cleanup() { launchctl bootout "gui/$(id -u)/com.minimax.quotabar.restart-once" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# 已经带端口就不必空等，直接收工
if app_has_port; then
  log "桌面端已带调试端口，无需重启"
  exit 0
fi

now="$(date +%s)"
last="$(cat "$STAMP" 2>/dev/null || echo 0)"
if [ "$((now - last))" -lt "$COOLDOWN" ]; then
  log "距上次尝试不足 $((COOLDOWN / 60)) 分钟，跳过"
  exit 0
fi

# 留一点缓冲，让提示先送达再重启
sleep 30

# 等完再确认一次：这期间可能已经被别的方式修好了
if app_has_port; then
  log "等待期间桌面端已带调试端口，取消重启"
  exit 0
fi

echo "$now" >"$STAMP"

log "开始重启桌面端（带 --remote-debugging-port=$PORT）"
osascript -e 'tell application "MiniMax Code" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 60); do
  app_running || break
  sleep 0.5
done
if app_running; then
  log "优雅退出超时，强制结束 pid=$(app_pid)"
  kill -TERM "$(app_pid)" 2>/dev/null
  sleep 2
  app_running && kill -KILL "$(app_pid)" 2>/dev/null
  sleep 1
fi
log "旧实例已退出：$(app_running && echo 否 || echo 是)"

open -a "$APP" --args --remote-debugging-port="$PORT"

READY=0
for _ in $(seq 1 80); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ "$READY" != "1" ]; then
  log "!! 调试端口未就绪，限额条不会出现。主进程命令行："
  ps -axo pid=,command= | awk '/MiniMax Code\.app\/Contents\/MacOS\/MiniMax Code/ {print; exit}' >>"$LOG" 2>/dev/null
  exit 1
fi
log "调试端口已就绪"

sleep 3
"$NODE_BIN" "$HERE/injector.mjs" --once --port "$PORT" >>"$LOG" 2>&1 || true
log "已手动注入一次，限额条应已出现"
