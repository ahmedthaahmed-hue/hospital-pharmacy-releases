@echo off
REM Imports the legacy Access backend (DataBE.accdb) into the new system database.
REM WARNING: replaces all clinical data in data\pharmacy.sqlite (users and settings are kept).
cd /d "%~dp0\..\server"
set /p ACCDB=Full path to DataBE.accdb: 
set /p ACCDB_PASSWORD=Access database password: 
set TZ=Africa/Cairo
call npx tsx --no-warnings=ExperimentalWarning src\db\import-legacy.ts --accdb "%ACCDB%" --db data\pharmacy.sqlite
set ACCDB_PASSWORD=
pause
