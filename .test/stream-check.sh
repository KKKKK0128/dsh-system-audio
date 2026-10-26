#!/usr/bin/env bash
# Verify the recorder's stream mode (--out -): WAV on stdout, events on stderr.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXE="$REPO/native/LoopbackRecorder.exe"
OUT="$REPO/.test/stream-tone.wav"
LOG="$REPO/.test/stream-events.log"
NODE="${NODE:-node}"
TONE="$(cygpath -w "$REPO/.test/tone.wav" 2>/dev/null || printf '%s' "$REPO/.test/tone.wav")"

rm -f "$OUT" "$LOG"
"$EXE" --capture --out - --seconds 5 --levels > "$OUT" 2> "$LOG" &
REC=$!
sleep 0.5
/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "(New-Object System.Media.SoundPlayer '$TONE').PlaySync()" >/dev/null 2>&1 || echo "(tone playback failed)"
wait "$REC"
echo "recorder status=$?"
echo "--- stderr events: first 2 and last 2 ---"
head -2 "$LOG"
echo "..."
tail -2 "$LOG"
echo "--- stdout wav ---"
ls -la "$OUT"
"$NODE" "$REPO/.test/wavcheck.mjs" "$OUT"
