@echo off
rem Remove the app from this PC (keeps the encrypted database unless you add -DeleteData).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1" %*
if errorlevel 1 pause
