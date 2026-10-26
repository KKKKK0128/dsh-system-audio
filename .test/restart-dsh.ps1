# Detached helper: close DSH Desktop (so it re-imports the host/client plugin modules)
# and start it again. Runs outside the agent turn so the app comes back on its own.
param(
  [int] $DelaySeconds = 60,
  [string] $Log = "$PSScriptRoot\restart-log.txt"
)

function Write-Log([string] $message) {
  $line = "{0} {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
}

$exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'

try {
  Write-Log "helper started; delay=${DelaySeconds}s; exe=$exe"
  Start-Sleep -Seconds $DelaySeconds

  $app = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  Write-Log ("app processes before quit: " + $app.Count)

  foreach ($p in $app) {
    try { $null = $p.CloseMainWindow() } catch { Write-Log "CloseMainWindow failed for $($p.Id): $_" }
  }

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
  }

  $left = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($left.Count -gt 0) {
    Write-Log ("polite quit timed out; forcing " + ($left | ForEach-Object { $_.Id }) -join ',')
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
  }
  Write-Log 'app closed'

  if (Test-Path -LiteralPath $exe) {
    Start-Process -FilePath $exe
    Write-Log 'relaunched'
  } else {
    Write-Log "exe NOT found: $exe"
  }
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
}
