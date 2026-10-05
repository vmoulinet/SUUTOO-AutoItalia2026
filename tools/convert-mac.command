#!/bin/bash
# SUUTOO video converter (macOS). Double-click it, or drop a video file on its icon.
# Output: H.264, 720x1280 portrait, 30 fps, AAC, under 140 MB, keyframe every second.

MAX_MB=140; AUDIO_K=96; MAX_VIDEO_K=3500; MIN_VIDEO_K=300
DIR="$HOME/Library/Application Support/SUUTOO-converter"

pause_end() { [ -n "$SUUTOO_NOPAUSE" ] || { echo; read -r -p "  Press Enter to close" _; }; }
trap pause_end EXIT

echo
echo "  SUUTOO video converter"
echo "  Output: H.264, 720x1280 portrait, 30 fps, AAC, under ${MAX_MB} MB, keyframe every second"
echo

IN="$1"
if [ -z "$IN" ]; then
  IN=$(osascript -e 'POSIX path of (choose file with prompt "Choose the video to convert")' 2>/dev/null) || exit 0
fi
[ -f "$IN" ] || { echo "  ERROR: file not found: $IN"; exit 1; }

find_tool() {   # $1 = ffmpeg | ffprobe
  command -v "$1" 2>/dev/null && return 0
  for p in "/opt/homebrew/bin/$1" "/usr/local/bin/$1" "$DIR/$1"; do [ -x "$p" ] && { echo "$p"; return 0; }; done
  return 1
}

FFMPEG=$(find_tool ffmpeg); FFPROBE=$(find_tool ffprobe)
if [ -z "$FFMPEG" ] || [ -z "$FFPROBE" ]; then
  echo "  ffmpeg is needed and was not found. Downloading it once..."
  mkdir -p "$DIR"
  for t in ffmpeg ffprobe; do
    curl -L --fail -o "$DIR/$t.zip" "https://evermeet.cx/ffmpeg/getrelease/$t/zip" && unzip -o -q "$DIR/$t.zip" -d "$DIR" && rm -f "$DIR/$t.zip" && chmod +x "$DIR/$t"
  done
  FFMPEG=$(find_tool ffmpeg); FFPROBE=$(find_tool ffprobe)
fi
if [ -z "$FFMPEG" ] || ! "$FFMPEG" -version >/dev/null 2>&1; then
  echo "  ERROR: ffmpeg could not be installed automatically."
  echo "  Install it with Homebrew (brew install ffmpeg) and run this again."
  echo "  On a recent Mac you may also need Rosetta: softwareupdate --install-rosetta --agree-to-license"
  exit 1
fi

DUR=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$IN" | head -n1)
[ -n "$DUR" ] || { echo "  ERROR: could not read the video length."; exit 1; }
# Total bitrate that keeps the file under the size limit, minus the audio
VIDEO_K=$(awk -v d="$DUR" -v max="$MAX_MB" -v a="$AUDIO_K" -v hi="$MAX_VIDEO_K" -v lo="$MIN_VIDEO_K" \
  'BEGIN { k = int(max * 1048576 * 8 / d / 1000 * 0.95 - a); if (k > hi) k = hi; if (k < lo) k = lo; print k }')
MAXRATE=$((VIDEO_K * 5 / 4)); BUFSIZE=$((VIDEO_K * 2))

SRC_DIR=$(dirname "$IN"); BASE=$(basename "$IN"); BASE="${BASE%.*}"
OUT="$SRC_DIR/$BASE-suutoo.mp4"; N=2
while [ -e "$OUT" ]; do OUT="$SRC_DIR/$BASE-suutoo-$N.mp4"; N=$((N + 1)); done

echo "  Input : $IN"
printf "  Length: %.0f s   video bitrate: %s kbit/s\n" "$DUR" "$VIDEO_K"
echo "  Output: $OUT"
echo
echo "  Converting... (this can take a few minutes)"

"$FFMPEG" -hide_banner -loglevel warning -stats -n -i "$IN" \
  -map 0:v:0 -map "0:a:0?" \
  -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p" \
  -c:v libx264 -profile:v high -level 4.1 -preset medium \
  -b:v "${VIDEO_K}k" -maxrate "${MAXRATE}k" -bufsize "${BUFSIZE}k" \
  -g 30 -keyint_min 30 -sc_threshold 0 \
  -c:a aac -b:a "${AUDIO_K}k" -ar 48000 -ac 2 \
  -movflags +faststart "$OUT" || { echo; echo "  ERROR: the conversion failed (see the message above)."; exit 1; }

SIZE_MB=$(( $(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT") / 1048576 ))
echo
echo "  Done: $OUT  (${SIZE_MB} MB)"
echo "  Now import this file in the SUUTOO control panel (Library tab)."
[ -n "$SUUTOO_NOPAUSE" ] || open -R "$OUT" 2>/dev/null
