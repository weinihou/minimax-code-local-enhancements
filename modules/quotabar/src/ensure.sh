#!/bin/bash
# 巡检：保证限额条守护在跑；桌面端缺调试端口时自动带端口重启一次恢复
# 重启会掐断用户正在跑的会话，所以只在「会话空闲」时才动手（见 session_busy）
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/app-proc.sh"
PORT="${QB_PORT:-9333}"
APP="/Applications/MiniMax Code.app"
LABEL="com.minimax.quotabar.daemon"
STATE="${QB_STATE_DIR:-$HOME/.minimax/quotabar}"
LOG="$STATE/quotabar.log"
mkdir -p "$STATE"

# 最近 N 分钟内有会话/后台任务活动 → 用户正在用，别重启。
# 注意：只看 ~/.minimax/sessions 顶层的 mtime 不可靠（目录 mtime 仅在条目增删时更新，
# 只写 workspace 子目录不会刷新它），要连 background-tasks 一起看。
session_busy() {
  { find "$HOME/.minimax/background-tasks" -maxdepth 1 -type d -name 'bg_*' -mmin -3 2>/dev/null
    find "$HOME/.minimax/sessions" -maxdepth 3 -type f -mmin -3 2>/dev/null
  } | grep -q .
}

# 同一类提醒 30 分钟内只发一次，避免每分钟弹一次
notify() {
  local key="$1" title="$2" body="$3" last=0 now
  [ -f "$STATE/notify-$key" ] && last="$(cat "$STATE/notify-$key" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  [ "$((now - last))" -lt 1800 ] && return 0
  printf '%s' "$now" >"$STATE/notify-$key"
  /usr/bin/osascript -e "display notification \"$body\" with title \"$title\"" >/dev/null 2>&1 || true
  echo "[$(date '+%F %T')] 已提醒：$title" >>"$LOG"
}

daemon_alive() {
  local pid
  pid="$(launchctl list 2>/dev/null | awk -v l="$LABEL" '$3==l {print $1}')"
  [ -n "$pid" ] && [ "$pid" != "-" ] && kill -0 "$pid" 2>/dev/null
}

if ! daemon_alive; then
  # 必须由 launchd 直接 exec 拉起：nohup 出来的进程会随 launchd 作业结束被连坐杀掉
  launchctl submit -l "$LABEL" -- /bin/bash "$HERE/daemon.sh" 2>/dev/null || true
fi

if app_running && ! app_has_port; then
  # APP 自动更新后重启会丢掉 --remote-debugging-port，限额条随之消失。
  # 这里自动带端口重启一次恢复；restart-once.sh 自带「已带端口就退出」的幂等判断
  # 和 20 分钟冷却，由 launchd 承载（app 一退出它还活着），所以反复触发不会形成重启循环。
  if session_busy; then
    # 正在用：不重启，只提醒，等巡检下一轮空闲时再自动恢复
    echo "[$(date '+%F %T')] 当前桌面端实例没有调试端口，限额条不会出现；检测到会话活跃，稍后自动恢复" >>"$LOG"
    notify noport "侧边栏限额条待恢复" "桌面端这次启动没带调试端口。正在使用的会话结束后会自动重启恢复；也可手动运行 $HERE/restart-once.sh。"
  else
    echo "[$(date '+%F %T')] 当前桌面端实例没有调试端口，限额条不会出现；会话空闲，自动重启一次恢复" >>"$LOG"
    launchctl bootstrap "gui/$(id -u)" "$HERE/com.minimax.quotabar.restart-once.plist" 2>/dev/null || true    notify noport "侧边栏限额条已失效" "桌面端这次启动没带调试端口，正在自动重启恢复（会短暂中断当前会话）。"
  fi
else
  # 端口在，但注入没成功（多半是 APP 升级改了侧边栏 DOM）
  if [ -f "$LOG" ]; then
    last_status="$(grep -E '^\[.*\]\s+\[target\]' "$LOG" 2>/dev/null | tail -n 1)"
    if [ -n "$last_status" ] && ! echo "$last_status" | grep -q 'status=ok'; then
      echo "[$(date '+%F %T')] 注入未成功：$last_status" >>"$LOG"
      notify noinject "侧边栏限额条注入失败" "桌面端已带调试端口，但注入没成功，可能 APP 升级改了侧边栏结构。按 quotabar 技能手册重新找锚点。"
    fi
  fi
fi
