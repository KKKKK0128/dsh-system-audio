# Synthesize the known sentence from say.txt with the Windows OneCore (WinRT)
# speech engine, independent of the SAPI COM voice path. Writes a PCM WAV.
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$VoiceLanguage = 'zh-CN'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# Force the WinRT type projection.
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]

$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
Write-Output ("voices: " + (($voices | ForEach-Object { "$($_.DisplayName) [$($_.Language)]" }) -join '; '))

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$chosen = $voices | Where-Object { $_.Language -like "$VoiceLanguage*" } | Select-Object -First 1
if ($chosen) {
  $synth.Voice = $chosen
  Write-Output ("using voice: " + $chosen.DisplayName)
}

$text = [System.IO.File]::ReadAllText($Text, [System.Text.Encoding]::UTF8)
Write-Output ("text chars: " + $text.Length)

$operation = $synth.SynthesizeTextToStreamAsync($text)
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
$task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($operation))
if (-not $task.Wait(60000)) { throw 'synthesis timed out' }
$stream = $task.Result

$directory = Split-Path -Parent $Out
if ($directory -and -not (Test-Path $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$file = [System.IO.File]::Create($Out)
try {
  $stream.AsStreamForRead().CopyTo($file)
} finally {
  $file.Close()
}
Write-Output ("wrote: " + $Out + " (" + (Get-Item $Out).Length + " bytes)")
