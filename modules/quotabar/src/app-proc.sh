#!/bin/bash
# 桌面端主进程识别
# 注意：macOS 的 pgrep -f 对 "$" 锚点行为不可靠（实测 "MiniMax Code$" 匹配不到），
# 这里统一用 ps + awk，只认「命令行以主程序路径开头」的行——helper 进程路径里夹着
# Frameworks/MiniMax Code Helper.app，不会命中。

APP_MAIN='/Applications/MiniMax Code.app/Contents/MacOS/MiniMax Code'

# 主进程 pid（没有则空）
app_pid() {
  ps -axo pid=,command= | awk -v p="/Applications/MiniMax Code.app/Contents/MacOS/MiniMax Code" '
    $0 ~ ("^[ ]*[0-9]+ " p "( |$)") { print $1; exit }'
}

# 是否在运行
app_running() { [ -n "$(app_pid)" ]; }

# 运行中的实例是否带了调试端口
app_has_port() {
  local pid; pid="$(app_pid)"
  [ -n "$pid" ] || return 1
  ps -p "$pid" -o command= | grep -q -- "--remote-debugging-port"
}
