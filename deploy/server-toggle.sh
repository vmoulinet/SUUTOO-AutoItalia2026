#!/usr/bin/env bash
# Desktop button: starts the SUUTOO server if it is stopped, stops it otherwise.
SVC=suutoo

say() { zenity --info --title="SUUTOO" --text="$1" --timeout=3 --width=260 2>/dev/null || echo "$1"; }

if systemctl is-active --quiet "$SVC"; then
  zenity --question --title="SUUTOO" --width=300 \
    --text="The server is running.\nStop it? All screens will go black." 2>/dev/null || exit 0
  if sudo -n systemctl stop "$SVC"; then say "Server stopped"; else say "Failed to stop the server"; fi
else
  if sudo -n systemctl start "$SVC"; then say "Server started"; else say "Failed to start the server"; fi
fi
