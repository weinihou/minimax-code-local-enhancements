#!/bin/bash
# 安装开机自启（LaunchAgent）：巡检守护 + 必要时用带调试端口拉起桌面端
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.minimax.quotabar.plist"
STATE="${QB_STATE_DIR:-$HOME/.minimax/quotabar}"
mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.minimax.quotabar</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/ensure.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>$STATE/launchagent.out</string>
  <key>StandardErrorPath</key>
  <string>$STATE/launchagent.out</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"
echo "已安装自启：$PLIST"
echo "卸载：launchctl unload '$PLIST' && rm '$PLIST'"
