<#  The app's launcher. Keeps the server running, restarts it after an approved update, and swaps in staged update
    files before relaunching. Started by the installed service / the Desktop shortcut. Do not run the server directly;
    run it through this so self-updates can restart it.  #>
[CmdletBinding()] param([int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path
$Server = Join-Path $Root 'server'
$Data = Join-Path $Server 'data'
$NodeExe = if (Test-Path (Join-Path $Root 'runtime\node.exe')) { Join-Path $Root 'runtime\node.exe' } else { 'node' }
$env:APP_ROOT = $Root
$env:HPS_LAUNCHER = '1'   # the server may exit 69 to be swapped to a staged update and relaunched
$env:TZ = if ($env:TZ) { $env:TZ } else { 'Africa/Cairo' }
$env:PORT = "$Port"
$env:DB_FILE = Join-Path $Data 'pharmacy.sqlite'

function Swap-StagedUpdate {
  $ready = Join-Path $Data 'update-ready.json'
  $staging = Join-Path $Data 'update-staging'
  if (-not (Test-Path $ready) -or -not (Test-Path $staging)) { return }
  try {
    $info = Get-Content -Raw $ready | ConvertFrom-Json
    Write-Host "Applying update to $($info.version)…" -ForegroundColor Cyan
    # Copy file by file. (Copy-Item of a folder onto an existing folder nests it — server\server — instead of
    # replacing it, and backing up whole top-level folders would copy server\data, rollback folders included, into
    # itself.) Keep a rollback copy of exactly the files the update replaces.
    $backup = Join-Path $Data ("rollback-" + (Get-Date -Format 'yyyyMMdd_HHmmss'))
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    $stagingFull = (Resolve-Path -LiteralPath $staging).Path.TrimEnd('\')
    Get-ChildItem -LiteralPath $staging -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($stagingFull.Length + 1)
      $dest = Join-Path $Root $rel
      if (Test-Path -LiteralPath $dest) {
        $b = Join-Path $backup $rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $b) | Out-Null
        Copy-Item -LiteralPath $dest -Destination $b -Force
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
    # Update brought a new package.json → refresh server dependencies (npm ci needs a lock file; a release ships none).
    Push-Location $Server
    $npmVerb = if (Test-Path (Join-Path $Server 'package-lock.json')) { 'ci' } else { 'install' }
    $npmCli = Join-Path $Root 'runtime\npm-cli.js'
    try { if (Test-Path $npmCli) { & $NodeExe $npmCli $npmVerb --omit=dev --ignore-scripts 2>&1 | Out-Null } else { & npm.cmd $npmVerb --omit=dev --ignore-scripts 2>&1 | Out-Null } } catch {}
    Pop-Location
    Remove-Item -LiteralPath $staging -Recurse -Force
    Remove-Item -LiteralPath $ready -Force
    # keep only the 3 newest rollback folders
    Get-ChildItem -LiteralPath $Data -Directory -Filter 'rollback-*' | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force
    Write-Host "Update applied." -ForegroundColor Green
  } catch { Write-Host "Update swap failed, keeping the current version: $($_.Exception.Message)" -ForegroundColor Yellow }
}

# The server's output goes to server\data\logs (the startup task has no window); the previous run's log is kept as .1.
$Logs = Join-Path $Data 'logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$crashes = 0
while ($true) {
  Swap-StagedUpdate
  foreach ($f in 'server.out.log', 'server.err.log') {
    $l = Join-Path $Logs $f; if (Test-Path -LiteralPath $l) { Move-Item -LiteralPath $l -Destination "$l.1" -Force }
  }
  $started = Get-Date
  $p = Start-Process -FilePath $NodeExe -ArgumentList @('--no-warnings=ExperimentalWarning', "`"$(Join-Path $Server 'dist\main.js')`"") `
    -WorkingDirectory $Server -NoNewWindow -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $Logs 'server.out.log') -RedirectStandardError (Join-Path $Logs 'server.err.log')
  $code = $p.ExitCode
  if ($code -eq 69) { Write-Host "Restarting…" -ForegroundColor Cyan; continue }   # approved update → swap & relaunch
  if ($code -eq 0) { Write-Host "Server stopped."; break }
  # A crash: start again after a short pause (pharmacies depend on it), but not in a tight loop.
  if (((Get-Date) - $started).TotalMinutes -gt 5) { $crashes = 0 }
  $crashes++
  Write-Host "Server stopped unexpectedly (exit $code) - restarting ($crashes)." -ForegroundColor Yellow
  if ($crashes -ge 5) { Write-Host "It keeps stopping; see $Logs\server.err.log" -ForegroundColor Red; break }
  Start-Sleep -Seconds 10
}
