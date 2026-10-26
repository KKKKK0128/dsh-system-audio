#!/usr/bin/env bash
# Live capture checks: play a tone through the default speakers while the
# plugin's capture session API records and stops it.
# Paths are derived from the script location; override NODE to point at another node.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-node}"
PS="/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
TONE="$(cygpath -w "$REPO/.test/tone.wav" 2>/dev/null || printf '%s' "$REPO/.test/tone.wav")"

"$PS" -NoProfile -Command "Start-Sleep -Milliseconds 600; \$p = New-Object System.Media.SoundPlayer '$TONE'; 1..3 | ForEach-Object { \$p.PlaySync() }" &
PLAYER=$!

cd "$REPO" || exit 1
"$NODE" .test/plugin-live.mjs
STATUS=$?

wait "$PLAYER" 2>/dev/null
exit "$STATUS"
