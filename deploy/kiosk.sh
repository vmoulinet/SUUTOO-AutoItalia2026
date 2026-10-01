#!/usr/bin/env bash
# Ouvre l'interface admin SUUTOO en plein écran (mode kiosque) dans Chromium.
# Lancé au démarrage de la session et par l'icône « SUUTOO Admin » du bureau.
URL="${SUUTOO_URL:-http://localhost:8080/admin}"
PROFILE="$HOME/.config/suutoo-kiosk"

# Déjà ouvert : ne rien faire (évite les doublons si on clique sur l'icône)
if pgrep -f -- "user-data-dir=$PROFILE" >/dev/null; then exit 0; fi

# Attendre que le serveur réponde (60 s max), puis ouvrir quand même
for _ in $(seq 60); do
  curl -fs -o /dev/null "$URL" && break
  sleep 1
done

# Évite le bandeau « Chromium ne s'est pas fermé correctement »
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"Crashed"/"exit_type":"Normal"/' \
  "$PROFILE/Default/Preferences" "$PROFILE/Local State" 2>/dev/null || true

exec chromium --kiosk "$URL" \
  --user-data-dir="$PROFILE" \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --no-first-run --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --ozone-platform-hint=auto \
  --check-for-update-interval=31536000
