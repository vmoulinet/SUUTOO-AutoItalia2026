#!/usr/bin/env bash
# Installe le serveur SUUTOO sur un Raspberry Pi (Raspberry Pi OS / Debian).
# À lancer DEPUIS le Pi, dans le dossier du projet copié :
#   bash deploy/install-pi.sh [--tailscale] [--claude]
#
#   --tailscale  installe Tailscale (accès SSH à distance, sans ouvrir de port)
#   --claude     installe Claude Code
set -euo pipefail

WITH_TAILSCALE=0
WITH_CLAUDE=0
for arg in "$@"; do
  case "$arg" in
    --tailscale) WITH_TAILSCALE=1 ;;
    --claude)    WITH_CLAUDE=1 ;;
    *) echo "Option inconnue : $arg"; exit 1 ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  echo "Lancez ce script avec votre utilisateur normal (pas root) ; sudo sera appelé si besoin."
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"

echo "==> Dossier : $APP_DIR  |  Utilisateur : $APP_USER"

echo "==> Paquets (Node.js, git, curl)"
sudo apt-get update
sudo apt-get install -y nodejs git curl
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js $NODE_MAJOR trop ancien (18+ requis)."
  exit 1
fi

echo "==> Service systemd"
sed -e "s|__USER__|$APP_USER|g" -e "s|__DIR__|$APP_DIR|g" \
  "$APP_DIR/deploy/suutoo.service" | sudo tee /etc/systemd/system/suutoo.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable suutoo
sudo systemctl restart suutoo

echo "==> SSH activé au démarrage"
sudo systemctl enable --now ssh

if [ "$WITH_TAILSCALE" -eq 1 ]; then
  echo "==> Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
  echo "Connexion Tailscale (ouvrez le lien affiché) :"
  sudo tailscale up --ssh
fi

if [ "$WITH_CLAUDE" -eq 1 ]; then
  echo "==> Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
  echo "Lancez 'claude' dans $APP_DIR pour vous connecter (nouveau terminal si la commande est introuvable)."
fi

sleep 2
echo
systemctl --no-pager --lines=5 status suutoo || true
echo
echo "Terminé. Régie : http://$(hostname -I | awk '{print $1}'):8080/admin"
echo "Logs en direct : journalctl -u suutoo -f"
