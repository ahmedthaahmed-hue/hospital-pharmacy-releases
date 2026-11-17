<#  One-time installer for a hospital PC. Connects to the internet once to download the app, then sets it up to run on
    the local network. After this, the PC does not need the internet (except when you choose to install an update).

    What it does:
      1. installs Node.js LTS if missing (winget)
      2. downloads the latest signed release from the public releases repo and verifies every file
      3. installs it to a folder (default C:\HospitalPharmacy), runs `npm ci`
      4. asks what this PC is — the MAIN SERVER or a PHARMACY PC — and sets it up (the browser wizard can also do this)
      5. installs a Windows service (or a startup task) so the app starts with Windows, and makes a Desktop shortcut
      6. opens the app

    Run it once per PC. Re-running repairs/updates the install (your data in <install>\server\data is kept).  #>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\HospitalPharmacy',
  [string]$ReleasesBase = 'https://raw.githubusercontent.com/ahmedthaahmed-hue/hospital-pharmacy-releases/main',
  [int]$Port = 8080,
  [switch]$NoService,
  [switch]$NoElevate
)
$ErrorActionPreference = 'Stop'
function Admin { (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
if (-not (Admin) -and -not $NoElevate) {
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$($MyInvocation.MyCommand.Path)`"",'-NoElevate','-InstallDir',"`"$InstallDir`"",'-ReleasesBase',"`"$ReleasesBase`"",'-Port',"$Port")
  if ($NoService) { $a += '-NoService' }
  Start-Process powershell.exe -ArgumentList $a -Verb RunAs; exit 0
}
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
function Say($t,$c='Cyan'){ Write-Host $t -ForegroundColor $c }
function Refresh { $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User') }
$ReleasesBase = $ReleasesBase.TrimEnd('/')

Say "Hospital Pharmacy installer`nInstall folder: $InstallDir`nReleases: $ReleasesBase" 'Green'

Say "`n==> Node.js"
Refresh
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Install Node.js LTS from https://nodejs.org and run this again.' }
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Refresh
}
$nv = (node --version); Say "   $nv" 'Gray'

Say "`n==> Download the latest signed release"
Add-Type -AssemblyName System.Security
$tmp = Join-Path $env:TEMP ("hps-dl-" + [Guid]::NewGuid()); New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$meta = Join-Path $env:TEMP ("hps-meta-" + [Guid]::NewGuid()); New-Item -ItemType Directory -Force -Path $meta | Out-Null
# The release signing public key (the same one built into the app, server/src/platform/releases.ts). The control file
# and the manifest are installed only when their signature verifies: the per-file checksums come from the manifest,
# so without this check anyone able to change the download could install their own code.
$PublicKey = 'MCowBQYDK2VwAyEAIbNP38wkYBwniivmxSHCsgIgen334969+63vlzB/elM='
function Get-Signed($u, $what) {
  $file = Join-Path $meta ($u -replace '[\\/]', '_'); $sig = "$file.sig"
  Invoke-WebRequest -UseBasicParsing "$ReleasesBase/$u" -OutFile $file
  Invoke-WebRequest -UseBasicParsing "$ReleasesBase/$u.sig" -OutFile $sig
  $js = "const c=require('crypto'),f=require('fs');const k=c.createPublicKey({key:Buffer.from('$PublicKey','base64'),format:'der',type:'spki'});process.exit(c.verify(null,f.readFileSync(process.argv[1]),k,Buffer.from(f.readFileSync(process.argv[2],'utf8').trim(),'base64'))?0:1)"
  & node -e $js $file $sig
  if ($LASTEXITCODE -ne 0) { throw "The $what is not signed by the system owner — the download is corrupt or tampered. Stopped." }
  Get-Content -Raw -Encoding UTF8 -LiteralPath $file | ConvertFrom-Json
}
$control = Get-Signed 'control.json' 'update control file'
$version = $control.latestVersion
if ($control.killed) { throw "The system owner has turned the app off. Installation stopped." }
Say "   latest version: $version" 'Gray'
$manifest = Get-Signed "$version/manifest.json" 'release manifest'
if ($manifest.version -ne $version) { throw "The release manifest is for version $($manifest.version), not $version. Stopped." }
Remove-Item -LiteralPath $meta -Recurse -Force
Say "   downloading $($manifest.files.Count) files…"
$sha = [System.Security.Cryptography.SHA256]::Create()
foreach ($f in $manifest.files) {
  $dest = Join-Path $tmp $f.path; New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  Invoke-WebRequest -UseBasicParsing "$ReleasesBase/$version/$($f.path)" -OutFile $dest
  $got = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($dest))) -replace '-').ToLower()
  if ($got -ne $f.sha256) { throw "Checksum mismatch for $($f.path) — the download is corrupt or tampered. Stopped." }
}
Say "   all files verified" 'Green'

Say "`n==> Install to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# Keep existing data; replace app files. File by file: Copy-Item of a folder onto an existing one (a re-install) would
# nest it (server\server) instead of replacing it.
$tmpFull = (Resolve-Path -LiteralPath $tmp).Path.TrimEnd('\')
Get-ChildItem -LiteralPath $tmp -Recurse -File | ForEach-Object {
  $dest = Join-Path $InstallDir $_.FullName.Substring($tmpFull.Length + 1)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
}
Remove-Item -LiteralPath $tmp -Recurse -Force
Push-Location (Join-Path $InstallDir 'server')
# npm ci needs a lock file, which a release does not ship.
$npmVerb = if (Test-Path 'package-lock.json') { 'ci' } else { 'install' }
try {
  Say "   installing dependencies (npm $npmVerb)…"
  & npm.cmd $npmVerb --omit=dev --no-audit --no-fund --ignore-scripts | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm $npmVerb failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

Say "`n==> What is this PC?"
$role = $null
if (-not $env:HPS_ROLE) {
  Write-Host "   [1] Main server  (holds the hospital database; one per hospital)"
  Write-Host "   [2] Pharmacy PC  (works through the main server; keeps a local copy to work offline)"
  Write-Host "   [Enter] decide later in the browser"
  $pick = Read-Host "   Choose 1, 2 or Enter"
  $role = @{ '1'='server'; '2'='pharmacy' }[$pick]
} else { $role = $env:HPS_ROLE }

# Launcher + service
$launcher = Join-Path $InstallDir 'deploy\launch.ps1'
$svcName = 'HospitalPharmacy'
if (-not $NoService) {
  Say "`n==> Start with Windows"
  $action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Port $Port"
  schtasks.exe /Create /TN $svcName /TR $action /SC ONSTART /RU SYSTEM /RL HIGHEST /F | Out-Null
  Say "   scheduled task '$svcName' created (runs at startup). Starting it now…" 'Gray'
  Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$launcher,'-Port',"$Port") -WindowStyle Minimized
}

# Desktop shortcut
try {
  $lnk = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Hospital Pharmacy.lnk'
  $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $sc.TargetPath = "http://localhost:$Port/"; $sc.Save()
} catch {}

Say "`n==> Waiting for the server…"
$ok=$false; for($i=0;$i -lt 60 -and -not $ok;$i++){ Start-Sleep -Milliseconds 500; try { $ok=(Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/local/info" -TimeoutSec 2).StatusCode -eq 200 } catch {} }
if ($ok) { Start-Process "http://localhost:$Port/"; Say "`nInstalled. Open http://localhost:$Port on this and other PCs." 'Green' }
else { Say "`nInstalled, but the server did not answer yet. Start it from the Desktop shortcut or reboot." 'Yellow' }
if ($role) { Say "Finish setup in the browser: choose '$role' and follow the steps." 'Green' }
Read-Host "`nPress Enter to close"
