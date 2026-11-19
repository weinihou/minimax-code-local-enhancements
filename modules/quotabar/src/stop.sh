#!/bin/bash
# 停止限额条守护（不动桌面端）
# 守护由 launchd 直接 exec 拉起，所以用 launchctl remove 停（pid 文件那套已废弃）
set -uo pipefail
LABEL="com.minimax.quotabar.daemon"
PID="$(launchctl list 2>/dev/null | awk -v l="$LABEL" '$3==l {print $1}')"
if [ -n "$PID" ] && [ "$PID" != "-" ]; then
  launchctl remove "$LABEL" 2>/dev/null || true
  echo "已停止守护 $LABEL"
else
  echo "守护未在运行"
fi
