#!/usr/bin/env bash
# Removes what setup-pi.sh / install-pi.sh / install-kiosk.sh set up on a Raspberry Pi.
# Standalone: can be run from a USB stick. Run as your normal user:
#   bash uninstall-pi.sh
# Removes: suutoo and suutoo-control services, sudoers rule, hardware watchdog setting, kiosk
# autostart, "SUUTOO Admin" desktop icon, "no confirmation on icon click" setting, screen
# blanking back on. Asks before removing Tailscale and the project folder (videos, settings, logs).
# Left untouched: Node.js, git, curl, SSH, Claude Code (other things may use them).
set -uo pipefail

[ "$(id -u)" -ne 0 ] || { echo "Run as your normal user, not root."; exit 1; }

DIR="$HOME/SUUTOO-AutoItalia2026"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ask() { read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }

step "Services"
for s in suutoo suutoo-control; do
  sudo systemctl disable --now "$s" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$s.service"
done
sudo systemctl daemon-reload

step "Passwordless start/stop rule"
sudo rm -f /etc/sudoers.d/suutoo

step "Hardware watchdog (back to the system default)"
sudo rm -f /etc/systemd/system.conf.d/watchdog.conf
sudo systemctl daemon-reexec

step "Kiosk autostart and desktop icon"
rm -f "$HOME/.config/autostart/suutoo-kiosk.desktop" "$DESKTOP_DIR/suutoo-admin.desktop" "$DESKTOP_DIR/suutoo-server.desktop"
pkill -f 'kiosk.sh' 2>/dev/null || true
LIBFM="$HOME/.config/libfm/libfm.conf"
[ -f "$LIBFM" ] && sed -i '/^quick_exec=1$/d' "$LIBFM"

step "Screen blanking back on"
sudo raspi-config nonint do_blanking 0 2>/dev/null || true

if command -v tailscale >/dev/null 2>&1 && ask "Also remove Tailscale (remote access will stop working)?"; then
  sudo tailscale down 2>/dev/null || true
  sudo apt-get remove -y tailscale
fi

if [ -d "$DIR" ]; then
  if ask "Also delete $DIR (videos, settings, logs)?"; then
    cd "$HOME" && rm -rf "$DIR"
  else
    echo "Folder kept: $DIR"
  fi
fi

echo
printf '\033[32mSUUTOO removed. SSH, Node.js and git were left in place. Reboot to be sure: sudo reboot\033[0m\n'
