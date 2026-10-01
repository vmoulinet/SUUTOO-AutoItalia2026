#!/usr/bin/env bash
# Opens the SUUTOO admin interface fullscreen (kiosk mode) in Chromium.
# Started at session login and by the "SUUTOO Admin" desktop icon.
URL="${SUUTOO_URL:-http://localhost:8080/admin}"
PROFILE="$HOME/.config/suutoo-kiosk"

# Already open: do nothing (avoids duplicates when the icon is clicked)
if pgrep -f -- "user-data-dir=$PROFILE" >/dev/null; then exit 0; fi

# Wait for the server to answer (60 s max), then open anyway
for _ in $(seq 60); do
  curl -fs -o /dev/null "$URL" && break
  sleep 1
done

# Avoids the "Chromium didn't shut down correctly" bar
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"Crashed"/"exit_type":"Normal"/' \
  "$PROFILE/Default/Preferences" "$PROFILE/Local State" 2>/dev/null || true

exec chromium --kiosk "$URL" \
  --user-data-dir="$PROFILE" \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --no-first-run --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --ozone-platform=wayland \
  --check-for-update-interval=31536000
