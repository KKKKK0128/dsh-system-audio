#!/usr/bin/env bash
# Phase 0 probe: play known Windows SAPI speech while capturing system output
# through WASAPI loopback, then report the recorder's JSON events.
set -u
cd "$(dirname "$0")/.."
test -d .test || mkdir -p .test
sayfile="$PWD/.test/say.txt"
wav="$PWD/.test/sapi.wav"
log="$PWD/.test/rec.log"
rm -f "$wav" "$log"

PWSH="${PWSH:-/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
if [ ! -x "$PWSH" ]; then
  PWSH="$(command -v pwsh || command -v powershell || true)"
fi
echo "pwsh: $PWSH"

speak() {
  "$PWSH" -NoProfile -Command "
    Add-Type -AssemblyName System.Speech;
    \$text = [System.IO.File]::ReadAllText('$sayfile', [System.Text.Encoding]::UTF8);
    \$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
    \$synth.SelectVoice('Microsoft Huihui Desktop');
    \$synth.Volume = 100;
    \$synth.Rate = 1;
    Start-Sleep -Milliseconds 1500;
    \$synth.Speak(\$text);
    Write-Output ('SPOKEN: ' + \$text)
  "
}

speak > .test/speak.log 2>&1 &
speaker=$!

./native/LoopbackRecorder.exe --capture --out "$wav" --seconds 7 --levels > "$log" 2>&1
recorded=$?

wait "$speaker"
echo "--- recorder exit: $recorded"
echo "--- recorder head"
head -3 "$log"
echo "--- recorder tail"
tail -6 "$log"
echo "--- speaker log"
cat .test/speak.log
echo "--- file"
ls -la "$wav" 2>/dev/null || echo "no wav"
