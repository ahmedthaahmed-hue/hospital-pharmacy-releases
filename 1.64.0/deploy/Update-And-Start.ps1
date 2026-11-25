<#
.SYNOPSIS
  One click: get this copy of the system ready and start it. Works on a copy downloaded as a ZIP from GitHub
  (the usual case) and on a git clone.
    1. checks Node.js 22.13+ (installs the LTS with winget if it is missing)
    2. git clone only: pulls the latest main (unless there are local changes)
    3. stops the server if it is already running
    4. if this copy has no database yet, copies the database (and backups) from your previous copy of the system
       (the newest one found on the PC); the previous copy is left untouched
    5. copies the label font (Hacen-Eltaroute-Text.ttf) if this copy does not have it (installed fonts, Downloads,
       previous copy)
    6. npm install + npm run build (only when this copy was not built yet or the code changed)
    7. no database anywhere: creates a DEMO one (synthetic patients; users admin / pharm / view, password test1234)
    8. starts the server in its own window, opens http://localhost:8080, and puts a "Hospital Pharmacy" shortcut on the Desktop
#>
[CmdletBinding()]
param([string]$Branch = 'main', [switch]$NoUpdate, [int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path
Set-Location $Repo
$Server = Join-Path $Repo 'server'
$Db = Join-Path $Server 'data\pharmacy.sqlite'
$Font = Join-Path $Repo 'web\public\fonts\Hacen-Eltaroute-Text.ttf'
$Stamp = Join-Path $Repo 'server\dist\.build-stamp'
function Say([string]$t, [string]$c = 'Cyan') { Write-Host $t -ForegroundColor $c }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Run([string]$exe, [string[]]$argv) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $exe @argv 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { "   $($_.Exception.Message)" } else { "   $_" } } | Write-Host; return $LASTEXITCODE }
    finally { $ErrorActionPreference = $old }
}
function Text([string]$exe, [string[]]$argv) { $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { ((& $exe @argv 2>$null) -join "`n").Trim() } finally { $ErrorActionPreference = $old } }
function Same-Path([string]$a, [string]$b) { [IO.Path]::GetFullPath($a).TrimEnd('\') -ieq [IO.Path]::GetFullPath($b).TrimEnd('\') }

# Other copies of the system on this PC: folders named hospital-pharmacy-system* on the drives' top levels and in the
# user's Downloads / Desktop / Documents (a GitHub ZIP extracts to hospital-pharmacy-system-main\hospital-pharmacy-system-main).
function Find-OtherCopies {
    $roots = @()
    $roots += Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object { $_.DeviceID + '\' }
    $roots += @((Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'), $env:USERPROFILE)
    $found = @()
    foreach ($r in ($roots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)) {
        $found += Get-ChildItem -LiteralPath $r -Directory -Filter 'hospital-pharmacy-system*' -ErrorAction SilentlyContinue
        $found += Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory -Filter 'hospital-pharmacy-system*' -ErrorAction SilentlyContinue }
    }
    $found += $found | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory -Filter 'hospital-pharmacy-system*' -ErrorAction SilentlyContinue }
    $found | Where-Object { -not (Same-Path $_.FullName $Repo) } | Sort-Object FullName -Unique
}

try {
    Say "Hospital Pharmacy System - $Repo" 'Green'

    Say "`n==> Node.js"
    Refresh-Path
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Install Node.js LTS from https://nodejs.org, then run this again.' }
        [void](Run 'winget' @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'))
        Refresh-Path
    }
    $v = (Text 'node' @('--version')).TrimStart('v').Split('.')
    if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 13)) { throw "Node.js $($v -join '.') is too old: install the LTS from https://nodejs.org" }
    Say "   node $($v -join '.')" 'Gray'

    $version = 'zip'
    if ((Test-Path '.git') -and (Get-Command git -ErrorAction SilentlyContinue)) {
        if (-not $NoUpdate) {
            Say "`n==> Latest version ($Branch)"
            $dirty = Text 'git' @('status', '--porcelain', '--untracked-files=no')
            if ($dirty) { Say "   local changes present, so the code is left as it is" 'Yellow' }
            else {
                [void](Run 'git' @('fetch', 'origin', $Branch))
                if ((Text 'git' @('rev-parse', '--abbrev-ref', 'HEAD')) -ne $Branch) { [void](Run 'git' @('checkout', $Branch)) }
                if ((Run 'git' @('pull', '--ff-only', 'origin', $Branch)) -ne 0) { Say '   could not update; continuing with the current code' 'Yellow' }
            }
        }
        $version = Text 'git' @('rev-parse', 'HEAD')
    } else {
        # A ZIP copy: its version is the time it was extracted (the files never change afterwards).
        $version = 'zip ' + (Get-Item (Join-Path $Repo 'package.json')).LastWriteTimeUtc.ToString('o')
    }

    Say "`n==> Stop the server if it is running"
    $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    if (-not $pids.Count) { Say '   not running' 'Gray' }
    foreach ($p in $pids) {
        $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') { Say "   stopping it (pid $p)" 'Gray'; Stop-Process -Id $p -Force; Start-Sleep -Seconds 1 }
        elseif ($proc) { throw "port $Port is used by $($proc.ProcessName) (pid $p): close it and run again" }
    }

    $others = $null
    if (-not (Test-Path $Db)) {
        Say "`n==> Database"
        $others = @(Find-OtherCopies)
        $prev = $others | ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName 'server\data\pharmacy.sqlite') -ErrorAction SilentlyContinue } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($prev) {
            $fromServer = Split-Path (Split-Path $prev.FullName)
            Say "   copying your database from the previous copy: $($prev.FullName) ($($prev.LastWriteTime))" 'Gray'
            New-Item -ItemType Directory -Force -Path (Split-Path $Db) | Out-Null
            foreach ($ext in '', '-wal', '-shm') { if (Test-Path -LiteralPath ($prev.FullName + $ext)) { Copy-Item -LiteralPath ($prev.FullName + $ext) -Destination ($Db + $ext) -Force } }
            $bk = Join-Path $fromServer 'backups'
            if ((Test-Path $bk) -and -not (Test-Path (Join-Path $Server 'backups'))) { Copy-Item -LiteralPath $bk -Destination (Join-Path $Server 'backups') -Recurse }
            Say '   copied (the previous copy is unchanged; you can delete its folder once this one works)' 'Gray'
        } else { Say '   no previous copy found: a demo database will be created' 'Gray' }
    }

    Say "`n==> Label font"
    if (Test-Path $Font) { Say '   in place' 'Gray' }
    else {
        if ($null -eq $others) { $others = @(Find-OtherCopies) }
        $cands = @()
        $cands += $others | ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName 'web\public\fonts\Hacen-Eltaroute-Text.ttf') -ErrorAction SilentlyContinue }
        foreach ($d in @((Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'), (Join-Path $env:WINDIR 'Fonts'), (Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('Desktop'), 'C:\LabelDummy')) {
            if ($d -and (Test-Path -LiteralPath $d)) { $cands += Get-ChildItem -LiteralPath $d -Recurse -Depth 4 -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'hacen' -and $_.Name -match 'taroute' -and $_.Extension -match '^\.(ttf|otf)$' } }
        }
        $src = $cands | Where-Object { $_ } | Select-Object -First 1
        if ($src) { New-Item -ItemType Directory -Force -Path (Split-Path $Font) | Out-Null; Copy-Item -LiteralPath $src.FullName -Destination $Font; Say "   copied from $($src.FullName)" 'Gray' }
        else { Say '   NOT FOUND: the app works, but labels show an error until Hacen-Eltaroute-Text.ttf is in web\public\fonts (then run this again)' 'Yellow' }
    }

    # Build when this copy was never built, the code changed, or the font arrived after the last build.
    $fontStamp = if (Test-Path $Font) { 'font' } else { 'nofont' }
    $want = "$version $fontStamp"
    $built = (Test-Path (Join-Path $Repo 'web\dist\index.html')) -and (Test-Path (Join-Path $Server 'dist\main.js')) -and (Test-Path $Stamp) -and ((Get-Content -Raw $Stamp).Trim() -eq $want)
    if ($built -and (Test-Path (Join-Path $Repo 'node_modules\.package-lock.json'))) { Say "`n==> Already built" }
    else {
        Say "`n==> npm install (a few minutes the first time)"
        if ((Run 'npm.cmd' @('install', '--no-audit', '--no-fund', '--ignore-scripts')) -ne 0) { throw 'npm install failed (see above)' }
        Say "`n==> npm run build"
        if ((Run 'npm.cmd' @('run', 'build')) -ne 0) { throw 'build failed (see above)' }
        Set-Content -Path $Stamp -Value $want -Encoding ASCII
    }

    $env:TZ = 'Africa/Cairo'
    $demo = -not (Test-Path $Db)
    if ($demo) {
        Say "`n==> Demo database (synthetic patients)"
        New-Item -ItemType Directory -Force -Path (Split-Path $Db) | Out-Null
        Push-Location $Server
        try {
            if ((Run 'npx.cmd' @('tsx', '--no-warnings=ExperimentalWarning', 'src/db/import-legacy.ts', '--mirror', '../db/pharmacy_demo.sqlite', '--db', 'data/pharmacy.sqlite')) -ne 0) { throw 'demo database failed' }
            [void](Run 'npx.cmd' @('tsx', 'src/db/dev-users.ts'))
            [void](Run 'npx.cmd' @('tsx', 'src/db/dev-activity.ts', '--days', '120'))
        } finally { Pop-Location }
    }

    Say "`n==> Start"
    Start-Process -FilePath (Join-Path $Repo 'deploy\start-server.bat') -WorkingDirectory (Join-Path $Repo 'deploy')
    $ok = $false
    for ($i = 0; $i -lt 60 -and -not $ok; $i++) { Start-Sleep -Milliseconds 500; try { $ok = (Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/" -TimeoutSec 2).StatusCode -eq 200 } catch { } }
    if (-not $ok) { throw 'the server did not answer: look at the server window for the error' }
    Start-Process "http://localhost:$Port/"

    try {
        $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Hospital Pharmacy.lnk'
        $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
        $sc.TargetPath = Join-Path $Repo 'Start-Pharmacy.bat'; $sc.WorkingDirectory = $Repo; $sc.Description = 'Start the Hospital Pharmacy System'
        $sc.Save()
    } catch { }

    Say "`nRunning at http://localhost:$Port  (keep the server window open; closing it stops the app)." 'Green'
    if ($demo) { Say 'Demo database. Users: admin / pharm / view, password test1234.' 'Green' } else { Say "Database: $Db" 'Green' }
    Say 'Next time: double-click "Hospital Pharmacy" on the Desktop.' 'Green'
} catch {
    Say "`nFAILED: $($_.Exception.Message)" 'Red'
}
[void](Read-Host 'Press Enter to close this window')
