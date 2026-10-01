#!/usr/bin/env bash
# Configure le mode kiosque sur le Pi (Raspberry Pi OS avec bureau) :
#  - ouvre l'interface admin en plein écran au démarrage
#  - icônes sur le bureau : « SUUTOO Admin » (relance le kiosque) et « SUUTOO Serveur » (démarrer/arrêter)
#  - écran jamais mis en veille
# À lancer DEPUIS le Pi, avec l'utilisateur normal :  bash deploy/install-kiosk.sh
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Lancez ce script avec votre utilisateur normal (pas root)."
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"

chmod +x "$APP_DIR"/deploy/*.sh

echo "==> Droit de démarrer/arrêter le serveur sans mot de passe (ces 3 commandes seulement)"
printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl start suutoo, /usr/bin/systemctl stop suutoo, /usr/bin/systemctl restart suutoo\n' "$APP_USER" \
  | sudo tee /etc/sudoers.d/suutoo >/dev/null
sudo chmod 440 /etc/sudoers.d/suutoo
sudo visudo -cf /etc/sudoers.d/suutoo

echo "==> Écran jamais en veille"
sudo raspi-config nonint do_blanking 1

echo "==> Lancement du kiosque au démarrage de la session"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/suutoo-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SUUTOO Kiosk
Exec=$APP_DIR/deploy/kiosk.sh
Terminal=false
EOF

echo "==> Icônes du bureau ($DESKTOP_DIR)"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/suutoo-admin.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SUUTOO Admin
Comment=Ouvrir l'interface admin en plein écran
Exec=$APP_DIR/deploy/kiosk.sh
Icon=video-display
Terminal=false
EOF
cat > "$DESKTOP_DIR/suutoo-server.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SUUTOO Serveur
Comment=Démarrer ou arrêter le serveur
Exec=$APP_DIR/deploy/server-toggle.sh
Icon=system-run
Terminal=false
EOF
chmod +x "$DESKTOP_DIR"/suutoo-*.desktop
gio set "$DESKTOP_DIR/suutoo-admin.desktop" metadata::trusted true 2>/dev/null || true
gio set "$DESKTOP_DIR/suutoo-server.desktop" metadata::trusted true 2>/dev/null || true

# Pas de question « Exécuter / Ouvrir ? » au clic sur une icône
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
echo "Terminé. Le kiosque se lancera au prochain démarrage (ou : $APP_DIR/deploy/kiosk.sh)."
