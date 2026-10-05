#!/usr/bin/env bash
# One-shot setup of a Raspberry Pi as the SUUTOO server. Copy this file to a USB stick (or
# anywhere on the Pi) and run it as your normal user, with internet:
#   bash setup-pi.sh [--no-kiosk] [--no-tailscale] [--claude]
# Downloads the latest version from GitHub, installs the service (auto-start, watchdog, SSH),
# Tailscale (remote access) and the kiosk (control panel on the Pi's screen).
# Run it again at any time to update.
set -euo pipefail

KIOSK=1; TAILSCALE=1; CLAUDE=0
for arg in "$@"; do
  case "$arg" in
    --no-kiosk) KIOSK=0 ;;
    --no-tailscale) TAILSCALE=0 ;;
    --claude) CLAUDE=1 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done
[ "$(id -u)" -ne 0 ] || { echo "Run as your normal user, not root."; exit 1; }

REPO="https://github.com/vmoulinet/SUUTOO-AutoItalia2026.git"
DIR="$HOME/SUUTOO-AutoItalia2026"

sudo apt-get update
sudo apt-get install -y git curl
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi

ARGS=()
[ "$TAILSCALE" -eq 1 ] && ARGS+=(--tailscale)
[ "$CLAUDE" -eq 1 ] && ARGS+=(--claude)
bash "$DIR/deploy/install-pi.sh" "${ARGS[@]}"
[ "$KIOSK" -eq 0 ] || bash "$DIR/deploy/install-kiosk.sh"

echo
echo "Setup complete. Reboot to test the kiosk: sudo reboot"
echo "Reminder: give this Pi a DHCP reservation in the router (fixed IP)."
