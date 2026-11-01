<#  Removes the Hospital Pharmacy app from this PC. By default it KEEPS the database (it stays encrypted and unreadable
    without this PC's key or the recovery key). Add -DeleteData to also delete the data folder.  #>
[CmdletBinding()] param([string]$InstallDir = 'C:\HospitalPharmacy', [switch]$DeleteData, [switch]$NoElevate)
$ErrorActionPreference = 'Stop'
function Admin { (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
if (-not (Admin) -and -not $NoElevate) {
  $a=@('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$($MyInvocation.MyCommand.Path)`"",'-NoElevate','-InstallDir',"`"$InstallDir`""); if($DeleteData){$a+='-DeleteData'}
  Start-Process powershell.exe -ArgumentList $a -Verb RunAs; exit 0
}
Write-Host "Stopping the app…"
schtasks.exe /End /TN 'HospitalPharmacy' 2>$null | Out-Null
schtasks.exe /Delete /TN 'HospitalPharmacy' /F 2>$null | Out-Null
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'HospitalPharmacy|dist\\main.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$data = Join-Path $InstallDir 'server\data'
if (-not $DeleteData -and (Test-Path $data)) {
  $keep = Join-Path ([Environment]::GetFolderPath('CommonDocuments')) ("HospitalPharmacy-data-" + (Get-Date -Format 'yyyyMMdd_HHmmss'))
  Copy-Item -LiteralPath $data -Destination $keep -Recurse -Force
  Write-Host "Your encrypted database was kept at:`n  $keep" -ForegroundColor Green
  Write-Host "It cannot be opened without this PC's key file or the recovery key." -ForegroundColor Green
}
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Hospital Pharmacy.lnk') -Force -ErrorAction SilentlyContinue
if (Test-Path $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
Write-Host "`nUninstalled." -ForegroundColor Green
if ($DeleteData) { Write-Host "The data folder was deleted." -ForegroundColor Yellow }
Read-Host "Press Enter to close"
