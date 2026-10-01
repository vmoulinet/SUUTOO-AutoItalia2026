#!/usr/bin/env bash
# Installs the SUUTOO server on a Raspberry Pi (Raspberry Pi OS / Debian).
# Run FROM the Pi, in the copied project folder:
#   bash deploy/install-pi.sh [--tailscale] [--claude]
#
#   --tailscale  installs Tailscale (remote SSH access, no open port)
#   --claude     installs Claude Code
set -euo pipefail

WITH_TAILSCALE=0
WITH_CLAUDE=0
for arg in "$@"; do
  case "$arg" in
    --tailscale) WITH_TAILSCALE=1 ;;
    --claude)    WITH_CLAUDE=1 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this script as your normal user (not root); sudo is called when needed."
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"

echo "==> Folder: $APP_DIR  |  User: $APP_USER"

echo "==> Packages (Node.js, git, curl)"
sudo apt-get update
sudo apt-get install -y nodejs git curl
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js $NODE_MAJOR is too old (18+ required)."
  exit 1
fi

echo "==> systemd service"
sed -e "s|__USER__|$APP_USER|g" -e "s|__DIR__|$APP_DIR|g" \
  "$APP_DIR/deploy/suutoo.service" | sudo tee /etc/systemd/system/suutoo.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable suutoo
sudo systemctl restart suutoo

echo "==> Hardware watchdog (reboots the Pi if it freezes)"
sudo mkdir -p /etc/systemd/system.conf.d
printf '[Manager]\nRuntimeWatchdogSec=15\nRebootWatchdogSec=2min\n' | sudo tee /etc/systemd/system.conf.d/watchdog.conf >/dev/null
sudo systemctl daemon-reexec

echo "==> SSH enabled at boot"
sudo systemctl enable --now ssh

if [ "$WITH_TAILSCALE" -eq 1 ]; then
  echo "==> Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
  echo "Tailscale login (open the link shown):"
  sudo tailscale up --ssh
fi

if [ "$WITH_CLAUDE" -eq 1 ]; then
  echo "==> Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
  echo "Run 'claude' in $APP_DIR to log in (open a new terminal if the command is not found)."
fi

sleep 2
echo
systemctl --no-pager --lines=5 status suutoo || true
echo
echo "Done. Admin panel: http://$(hostname -I | awk '{print $1}'):8080/admin"
echo "Live logs: journalctl -u suutoo -f"
