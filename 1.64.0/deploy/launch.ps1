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

# (1.64) An update that does not take leaves this PC as it was. The swap below keeps, in rollback-<time>\, every file it
# replaces, the list of the files it adds (added.json) and the database as it was (db\, before the new version first
# opens it: its changes to the tables only go forward). If the swap itself fails, everything is put back at once. If
# the new version then never starts serving (it writes <data>\serving.json once it answers, main.ts) and stops twice,
# the files AND the database are put back: nothing was done in it, so nothing is lost. Once it serves, the database
# copy is dropped (going back after work was done in it would lose that work). Either way <data>\update-failed.json
# says why, and the screens show it (update-progress.ts noteLauncherFailure). If going back itself cannot be finished,
# the app is not started on what is left: the rollback folder (database copy included) stays for whoever reinstalls.
$script:Watch = $null
$script:Halt = $false

function Write-UpdateFailed([string]$version, [string]$kind, [string]$detail, [bool]$complete) {
  try {
    $json = @{ to = "$version"; kind = $kind; detail = $detail; complete = $complete; at = (Get-Date).ToString('o') } | ConvertTo-Json
    # (no byte-order mark: the server reads it as JSON)
    [IO.File]::WriteAllText((Join-Path $Data 'update-failed.json'), $json, (New-Object System.Text.UTF8Encoding $false))
  } catch { }
}

# Puts back what the update replaced; with $database also the database as it was before the new version opened it.
# Returns whether everything went back: if not, the app must not be started on what is left.
function Restore-Rollback([string]$backup, [string]$version, [string]$kind, [string]$detail, [bool]$database) {
  Write-Host "Putting back the version from before the update ($kind`: $detail)" -ForegroundColor Yellow
  try {
    $backupFull = (Resolve-Path -LiteralPath $backup).Path.TrimEnd('\')
    $added = @()
    $addedFile = Join-Path $backup 'added.json'
    # (Windows PowerShell hands a JSON list over as one item: unrolled here)
    if (Test-Path -LiteralPath $addedFile) { $added = @(Get-Content -Raw -LiteralPath $addedFile | ConvertFrom-Json | ForEach-Object { $_ }) }
    # the server's libraries: the new ones out, the old ones back (they were moved aside whole)
    $oldLibs = Join-Path $Server 'node_modules'
    $keptLibs = Join-Path $backup 'server\node_modules'
    if (Test-Path -LiteralPath $keptLibs) {
      if (Test-Path -LiteralPath $oldLibs) { Remove-Item -LiteralPath $oldLibs -Recurse -Force }
      Move-Item -LiteralPath $keptLibs -Destination $oldLibs -Force
    }
    # the files the update added go; the ones it replaced come back
    foreach ($rel in $added) { if ($rel) { Remove-Item -LiteralPath (Join-Path $Root $rel) -Force -ErrorAction SilentlyContinue } }
    Get-ChildItem -LiteralPath $backup -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($backupFull.Length + 1)
      if ($rel -eq 'added.json' -or $rel -like 'db\*') { return }
      $dest = Join-Path $Root $rel
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
    $keptDb = Join-Path $backup 'db'
    if ($database -and (Test-Path -LiteralPath $keptDb)) {
      # copied next to the live files first; only once every copy is whole do they replace them, and only then go the
      # files the new version made (its journal, which must never be applied to the old database). The kept copy stays.
      $kept = @(Get-ChildItem -LiteralPath $keptDb -File)
      if (-not ($kept | Where-Object { $_.Name -eq 'pharmacy.sqlite' })) { throw 'the kept database copy is missing' }
      foreach ($f in $kept) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $Data "$($f.Name).restoring") -Force }
      foreach ($f in $kept) { Move-Item -LiteralPath (Join-Path $Data "$($f.Name).restoring") -Destination (Join-Path $Data $f.Name) -Force }
      $names = @($kept | ForEach-Object { $_.Name })
      Get-ChildItem -LiteralPath $Data -File -Filter 'pharmacy.sqlite*' | Where-Object { $names -notcontains $_.Name } | Remove-Item -Force
    }
    Write-UpdateFailed $version $kind $detail $true
    return $true
  } catch {
    Write-UpdateFailed $version $kind "$detail; going back was not complete: $($_.Exception.Message)" $false
    Write-Host "Going back was not complete: $($_.Exception.Message). Not starting: reinstall this PC with its installer (the data folder is kept; $backup holds the files and the database from before the update)." -ForegroundColor Red
    return $false
  }
}

function Swap-StagedUpdate {
  $ready = Join-Path $Data 'update-ready.json'
  $staging = Join-Path $Data 'update-staging'
  if (-not (Test-Path $ready) -or -not (Test-Path $staging)) { return }
  $version = '?'
  $backup = $null
  $added = New-Object System.Collections.Generic.List[string]
  try {
    $info = Get-Content -Raw $ready | ConvertFrom-Json
    $version = "$($info.version)"
    Write-Host "Applying update to $version…" -ForegroundColor Cyan
    # Copy file by file. (Copy-Item of a folder onto an existing folder nests it — server\server — instead of
    # replacing it, and backing up whole top-level folders would copy server\data, rollback folders included, into
    # itself.) Keep a rollback copy of exactly the files the update replaces.
    $backup = Join-Path $Data ("rollback-" + (Get-Date -Format 'yyyyMMdd_HHmmss'))
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    # the database as it is now, before the new version opens it
    $dbCopy = Join-Path $backup 'db'
    New-Item -ItemType Directory -Force -Path $dbCopy | Out-Null
    Get-ChildItem -LiteralPath $Data -File -Filter 'pharmacy.sqlite*' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $dbCopy $_.Name) -Force }
    $stagingFull = (Resolve-Path -LiteralPath $staging).Path.TrimEnd('\')
    # An update that carries the server's libraries replaces them whole: the old ones go aside into the rollback
    # folder first (a move, not a copy), so no file of an older library version stays mixed in with the new ones.
    $carriedLibs = Test-Path (Join-Path $staging 'server\node_modules')
    $oldLibs = Join-Path $Server 'node_modules'
    if ($carriedLibs -and (Test-Path -LiteralPath $oldLibs)) {
      New-Item -ItemType Directory -Force -Path (Join-Path $backup 'server') | Out-Null
      Move-Item -LiteralPath $oldLibs -Destination (Join-Path $backup 'server\node_modules') -Force
    }
    # ...and the new ones go in whole by a move too: one rename on the same disk, instead of copying some 7,300 files
    # one by one (release 1.22). On another disk the move is refused and the loop below copies them as before.
    if ($carriedLibs) {
      try { Move-Item -LiteralPath (Join-Path $staging 'server\node_modules') -Destination $oldLibs -Force -ErrorAction Stop } catch { }
    }
    Get-ChildItem -LiteralPath $staging -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($stagingFull.Length + 1)
      $dest = Join-Path $Root $rel
      if (Test-Path -LiteralPath $dest) {
        $b = Join-Path $backup $rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $b) | Out-Null
        Copy-Item -LiteralPath $dest -Destination $b -Force
      } elseif (-not ($carriedLibs -and $rel -like 'server\node_modules\*')) { $added.Add($rel) }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
    ConvertTo-Json -InputObject @($added) | Set-Content -LiteralPath (Join-Path $backup 'added.json') -Encoding UTF8
    # An update that carries the server's libraries (server\node_modules, signed with the rest) needs nothing more;
    # otherwise (an older package) refresh them with npm where there is one (a copy set up from source).
    if (-not $carriedLibs) {
    Push-Location $Server
    $npmVerb = if (Test-Path (Join-Path $Server 'package-lock.json')) { 'ci' } else { 'install' }
    $npmCli = Join-Path $Root 'runtime\npm-cli.js'
    try { if (Test-Path $npmCli) { & $NodeExe $npmCli $npmVerb --omit=dev --ignore-scripts 2>&1 | Out-Null } else { & npm.cmd $npmVerb --omit=dev --ignore-scripts 2>&1 | Out-Null } } catch {}
    Pop-Location
    }
    Remove-Item -LiteralPath $staging -Recurse -Force
    Remove-Item -LiteralPath $ready -Force
    # keep only the 3 newest rollback folders
    Get-ChildItem -LiteralPath $Data -Directory -Filter 'rollback-*' | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force
    Remove-Item -LiteralPath (Join-Path $Data 'serving.json') -Force -ErrorAction SilentlyContinue
    $script:Watch = @{ version = $version; backup = $backup; fails = 0 }
    Write-Host "Update applied." -ForegroundColor Green
  } catch {
    $err = $_.Exception.Message
    Write-Host "The update to $version could not be put in place ($err)" -ForegroundColor Yellow
    if ($backup -and (Test-Path -LiteralPath $backup)) {
      try { ConvertTo-Json -InputObject @($added) | Set-Content -LiteralPath (Join-Path $backup 'added.json') -Encoding UTF8 } catch { }
      if (-not (Restore-Rollback $backup $version 'swap' $err $false)) { $script:Halt = $true }
    } else { Write-UpdateFailed $version 'swap' $err $true }
    # never tried again from the same staged files (it would start on a mixed set): the next check fetches it again
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ready -Force -ErrorAction SilentlyContinue
  }
}

# A version just swapped in that stopped before it served: twice, and it is taken back out (see above).
function Test-NewVersion([int]$code) {
  $w = $script:Watch
  if (-not $w) { return $false }
  # (the swap removed serving.json: there again, it was written by the version just put in place)
  if (Test-Path -LiteralPath (Join-Path $Data 'serving.json')) {
    # it works: the database copy is no longer a way back (work has been done since)
    Remove-Item -LiteralPath (Join-Path $w.backup 'db') -Recurse -Force -ErrorAction SilentlyContinue
    $script:Watch = $null
    return $false
  }
  if ($code -eq 0 -or $code -eq 69) { return $false }
  $w['fails'] = $w['fails'] + 1
  if ($w['fails'] -lt 2) { return $false }
  $script:Watch = $null
  if (-not (Restore-Rollback $w.backup $w.version 'start' "it stopped with code $code" $true)) { $script:Halt = $true }
  return $true
}

# (1.64) A main server answers the pharmacy PCs' network search (UDP 41080, server/src/platform/discovery.ts), so its
# firewall must let the question in. setup-pc.ps1 opens it on new installs; one installed before 1.64 gets it here, at
# its next start (the startup task runs this as SYSTEM; started without that right, it is simply not added, and the
# PCs still find the main server by its port).
function Open-DiscoveryPort {
  try {
    $nodeFile = Join-Path $Data 'node.json'
    $role = if (Test-Path -LiteralPath $nodeFile) { (Get-Content -Raw -LiteralPath $nodeFile | ConvertFrom-Json).role } else { $null }
    $presetFile = Join-Path $Root 'install-role.txt'
    $preset = if (Test-Path -LiteralPath $presetFile) { (Get-Content -Raw -LiteralPath $presetFile).Trim() } else { '' }
    if (-not ($role -eq 'server' -or ((-not $role -or $role -eq 'unset') -and $preset -eq 'server'))) { return }
    $name = 'Hospital Pharmacy discovery (UDP 41080)'
    if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol UDP -LocalPort 41080 -Action Allow -Profile Domain,Private,Public -ErrorAction Stop | Out-Null
    }
  } catch { }
}

# The server's output goes to server\data\logs (the startup task has no window); the previous run's log is kept as .1.
$Logs = Join-Path $Data 'logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$crashes = 0
while ($true) {
  Swap-StagedUpdate
  if ($script:Halt) { Write-Host 'Not starting the app: see the message above.' -ForegroundColor Red; break }
  Open-DiscoveryPort
  foreach ($f in 'server.out.log', 'server.err.log') {
    $l = Join-Path $Logs $f; if (Test-Path -LiteralPath $l) { Move-Item -LiteralPath $l -Destination "$l.1" -Force }
  }
  $started = Get-Date
  $p = Start-Process -FilePath $NodeExe -ArgumentList @('--no-warnings=ExperimentalWarning', "`"$(Join-Path $Server 'dist\main.js')`"") `
    -WorkingDirectory $Server -NoNewWindow -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $Logs 'server.out.log') -RedirectStandardError (Join-Path $Logs 'server.err.log')
  $code = $p.ExitCode
  # (1.64) a version just installed that never started serving: put the one from before back, and start that
  if (Test-NewVersion $code) {
    if ($script:Halt) { Write-Host 'Not starting the app: see the message above.' -ForegroundColor Red; break }
    $crashes = 0; continue
  }
  if ($code -eq 69) { Write-Host "Restarting…" -ForegroundColor Cyan; continue }   # approved update → swap & relaunch
  if ($code -eq 0) { Write-Host "Server stopped."; break }
  # A crash: start again after a short pause (pharmacies depend on it), but not in a tight loop.
  if (((Get-Date) - $started).TotalMinutes -gt 5) { $crashes = 0 }
  $crashes++
  Write-Host "Server stopped unexpectedly (exit $code) - restarting ($crashes)." -ForegroundColor Yellow
  if ($crashes -ge 5) { Write-Host "It keeps stopping; see $Logs\server.err.log" -ForegroundColor Red; break }
  Start-Sleep -Seconds 10
}
