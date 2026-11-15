<#  Run by the Windows installer after it copies the app (as administrator). Makes the app start with Windows and
    starts it now. Safe to run again (repairs the setup).
      - copies the licensed label font from this PC's installed fonts into the app, if it is there
      - main server: opens the app's port in Windows Firewall so the pharmacy PCs can reach it
      - registers a startup task (runs the launcher as SYSTEM at boot, also when nobody is signed in) and starts it
      - waits until the app answers  #>
[CmdletBinding()] param([ValidateSet('server','pharmacy')][string]$Role = 'server', [int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path
$Data = Join-Path $Root 'server\data'
$log = Join-Path $Data 'logs\setup.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log($t) { $line = "$(Get-Date -Format s)  $t"; Add-Content -LiteralPath $log -Value $line -Encoding UTF8; Write-Host $line }
Log "Setting up Hospital Pharmacy ($Role) in $Root on port $Port"

Get-ChildItem -LiteralPath $Root -Recurse -File -Include *.ps1,*.bat -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

# The label font (Hacen Eltaroute Text) is licensed and not shipped: use this PC's installed copy if it has one.
$fontDest = Join-Path $Root 'web\dist\fonts\Hacen-Eltaroute-Text.ttf'
if (-not (Test-Path -LiteralPath $fontDest)) {
  $candidates = @(Get-ChildItem -LiteralPath "$env:WINDIR\Fonts" -Filter '*.ttf' -ErrorAction SilentlyContinue)
  foreach ($u in Get-ChildItem -LiteralPath (Join-Path $env:SystemDrive 'Users') -Directory -ErrorAction SilentlyContinue) {
    $candidates += @(Get-ChildItem -LiteralPath (Join-Path $u.FullName 'AppData\Local\Microsoft\Windows\Fonts') -Filter '*.ttf' -ErrorAction SilentlyContinue)
  }
  $font = $candidates | Where-Object { $_.Name -match 'hacen' -and $_.Name -match 'taroute' } | Select-Object -First 1
  if ($font) {
    New-Item -ItemType Directory -Force -Path (Split-Path $fontDest) | Out-Null
    Copy-Item -LiteralPath $font.FullName -Destination $fontDest -Force
    Log "Label font copied from $($font.FullName)"
  } else { Log "Label font not found on this PC (labels need it: copy Hacen-Eltaroute-Text.ttf to $(Split-Path $fontDest))" }
}

# Firewall: the main server must be reachable by the pharmacy PCs on the hospital network.
$ruleName = "Hospital Pharmacy (port $Port)"
try {
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  if ($Role -eq 'server') {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Domain,Private,Public | Out-Null
    Log "Firewall: inbound TCP $Port allowed"
  }
} catch { Log "Firewall rule not set: $($_.Exception.Message)" }

# Start with Windows: a startup task running the launcher as SYSTEM (no window, no sign-in needed).
$task = if ($Port -eq 8080) { 'HospitalPharmacy' } else { "HospitalPharmacy-$Port" }
$launcher = Join-Path $Root 'deploy\launch.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Log "Startup task '$task' registered"
Start-ScheduledTask -TaskName $task
Log "Started"

$ok = $false
for ($i = 0; $i -lt 120 -and -not $ok; $i++) {
  Start-Sleep -Milliseconds 750
  try { $ok = (Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/local/info" -TimeoutSec 3).StatusCode -eq 200 } catch {}
}
if ($ok) { Log "The app answers on http://localhost:$Port" } else { Log "The app did not answer yet - see $Data\logs\server.err.log" }
