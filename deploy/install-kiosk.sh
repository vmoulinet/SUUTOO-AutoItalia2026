#!/usr/bin/env bash
# Sets up kiosk mode on the Pi (Raspberry Pi OS with desktop):
#  - opens the admin interface fullscreen at boot
#  - desktop icon "SUUTOO Admin" (starts the server if stopped, reopens the kiosk)
#  - screen never goes to sleep
# Run FROM the Pi, as the normal user:  bash deploy/install-kiosk.sh
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this script as your normal user (not root)."
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"

chmod +x "$APP_DIR"/deploy/*.sh

echo "==> Allow starting/stopping the server without a password (these 3 commands only)"
printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl start suutoo, /usr/bin/systemctl stop suutoo, /usr/bin/systemctl restart suutoo\n' "$APP_USER" \
  | sudo tee /etc/sudoers.d/suutoo >/dev/null
sudo chmod 440 /etc/sudoers.d/suutoo
sudo visudo -cf /etc/sudoers.d/suutoo

echo "==> Screen never sleeps"
sudo raspi-config nonint do_blanking 1

echo "==> Start the kiosk at session login"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/suutoo-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SUUTOO Kiosk
Exec=$APP_DIR/deploy/kiosk.sh
Terminal=false
EOF

echo "==> Desktop icons ($DESKTOP_DIR)"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/suutoo-admin.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SUUTOO Admin
Comment=Start the server if needed and open the admin interface fullscreen
Exec=$APP_DIR/deploy/kiosk.sh
Icon=video-display
Terminal=false
EOF
# Only one icon: the old "SUUTOO Server" toggle icon is gone
rm -f "$DESKTOP_DIR/suutoo-server.desktop"
chmod +x "$DESKTOP_DIR/suutoo-admin.desktop"
gio set "$DESKTOP_DIR/suutoo-admin.desktop" metadata::trusted true 2>/dev/null || true

# No "Execute / Open?" question when clicking an icon
mkdir -p "$HOME/.config/libfm"
LIBFM="$HOME/.config/libfm/libfm.conf"
touch "$LIBFM"
grep -q '^\[config\]' "$LIBFM" || printf '[config]\n' >> "$LIBFM"
if grep -q '^quick_exec=' "$LIBFM"; then
  sed -i 's/^quick_exec=.*/quick_exec=1/' "$LIBFM"
else
  sed -i '/^\[config\]/a quick_exec=1' "$LIBFM"
fi

echo
echo "Done. The kiosk will start at next boot (or run: $APP_DIR/deploy/kiosk.sh)."
