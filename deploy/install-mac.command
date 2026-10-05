#!/usr/bin/env bash
# Installs / updates the SUUTOO server on a Mac.
# Safe to run again: each run pulls the latest version from GitHub and restarts the server.
# Double-click this file (first time: right-click > Open), or run: bash install-mac.command
set -euo pipefail

TARBALL="https://codeload.github.com/vmoulinet/SUUTOO-AutoItalia2026/tar.gz/refs/heads/main"
DIR="${SUUTOO_DIR:-$HOME/SUUTOO}"
LABEL="com.suutoo.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT=8080

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

step "Stopping the running server (if any)"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

step "Latest version from GitHub -> $DIR"
mkdir -p "$DIR"
# Overwrites the code only: videos, state.json, logs and .node are not in the archive
curl -fsSL "$TARBALL" | tar -xz --strip-components=1 -C "$DIR"

step "Node.js (private copy, does not touch any Node already installed)"
NODE_DIR="$DIR/.node"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  VER="$(curl -fsSL https://nodejs.org/dist/index.json | tr '{' '\n' | grep -v '"lts":false' | grep '"lts"' | head -1 | sed -E 's/.*"version":"(v[^"]+)".*/\1/')"
  NAME="node-$VER-darwin-$ARCH"
  curl -fsSL "https://nodejs.org/dist/$VER/$NAME.tar.gz" | tar -xz -C /tmp
  mv "/tmp/$NAME" "$NODE_DIR"
fi
"$NODE_DIR/bin/node" -v

step "Auto-start at login, restart if it crashes, no sleep while running"
mkdir -p "$DIR/logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>$NODE_DIR/bin/node</string><string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardOutPath</key><string>$DIR/logs/service.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/service.log</string>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 3
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<ip>')"
echo
printf '\033[32mDone. The server starts by itself at each login (enable automatic login for an unattended Mac).\033[0m\n'
echo "If macOS asks to allow incoming connections for node, click Allow."
echo "Admin panel: http://$IP:$PORT/admin"
echo "To update later: run this installer again."
