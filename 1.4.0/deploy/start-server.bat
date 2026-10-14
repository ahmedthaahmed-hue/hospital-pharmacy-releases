@echo off
REM Hospital Pharmacy System - start the server on this PC (all pharmacies open http://<this-pc-ip>:8080)
cd /d "%~dp0\..\server"
set TZ=Africa/Cairo
set PORT=8080
set DB_FILE=data\pharmacy.sqlite
node --no-warnings=ExperimentalWarning dist\main.js
pause
