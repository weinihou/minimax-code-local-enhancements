#!/bin/bash
# 限额条守护的启动包装：必须由 launchd 直接拉起
# 直接 nohup 出来的进程会被 launchd 任务连坐杀掉（任务退出时整组被杀）
# 注意：这个脚本只跑常驻进程。不要用 launchctl submit 跑会退出应用的动作，
# 那类任务会被 launchd 反复重跑。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${QB_PORT:-9333}"
STATE="${QB_STATE_DIR:-$HOME/.minimax/quotabar}"
mkdir -p "$STATE"
NODE_BIN="${QB_NODE:-$HOME/.local/node/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || echo node)"
fi
exec "$NODE_BIN" "$HERE/injector.mjs" --port "$PORT" >>"$STATE/quotabar.out" 2>&1
