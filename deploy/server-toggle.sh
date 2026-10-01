#!/usr/bin/env bash
# Bouton du bureau : démarre le serveur SUUTOO s'il est arrêté, l'arrête sinon.
SVC=suutoo

say() { zenity --info --title="SUUTOO" --text="$1" --timeout=3 --width=260 2>/dev/null || echo "$1"; }

if systemctl is-active --quiet "$SVC"; then
  zenity --question --title="SUUTOO" --width=300 \
    --text="Le serveur tourne.\nL'arrêter ? Les écrans passeront au noir." 2>/dev/null || exit 0
  if sudo -n systemctl stop "$SVC"; then say "Serveur arrêté"; else say "Échec de l'arrêt du serveur"; fi
else
  if sudo -n systemctl start "$SVC"; then say "Serveur démarré"; else say "Échec du démarrage du serveur"; fi
fi
