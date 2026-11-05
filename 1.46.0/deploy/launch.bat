@echo off
rem Start the Hospital Pharmacy server (through the launcher, so updates can restart it).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
pause
