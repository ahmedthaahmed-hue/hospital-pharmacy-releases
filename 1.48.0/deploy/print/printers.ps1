<#  Hospital Pharmacy - the printers of this PC (release 1.20), for the Printers screen: name, whether it is the
    Windows default, offline. Run by the app's server (platform/printing.ts); prints JSON.  #>
$ErrorActionPreference = 'Stop'
$list = @(Get-CimInstance Win32_Printer | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; isDefault = [bool]$_.Default; offline = [bool]$_.WorkOffline; driver = $_.DriverName; port = $_.PortName }
})
ConvertTo-Json -InputObject $list -Compress -Depth 2
