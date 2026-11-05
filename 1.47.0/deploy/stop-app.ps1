<#  Stops the Hospital Pharmacy app of this install (before an upgrade, or on uninstall). -Remove also removes its
    startup task and firewall rule. The data folder (server\data) is never touched.  #>
[CmdletBinding()] param([switch]$Remove)
$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path
foreach ($t in Get-ScheduledTask -TaskName 'HospitalPharmacy*' -ErrorAction SilentlyContinue) {
  if ($t.Actions | Where-Object { $_.Arguments -like "*$Root\deploy\launch.ps1*" }) {
    Stop-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue
    if ($Remove) {
      Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction SilentlyContinue
      if ($t.TaskName -match '-(\d+)$') { $port = $Matches[1] } else { $port = 8080 }
      Get-NetFirewallRule -DisplayName "Hospital Pharmacy (port $port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }
  }
}
# the launcher, the server it started and the app's windows (all run from this install folder; a window's files
# would otherwise be locked during an upgrade)
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { (($_.Name -eq 'node.exe' -or $_.Name -eq 'HospitalPharmacy.exe') -and $_.ExecutablePath -like "$Root\*") -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*$Root\deploy\launch.ps1*") } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
