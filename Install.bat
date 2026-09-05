@echo off
rem Double-click this file to set the board up. Nothing else is needed first.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install.ps1"
echo.
pause
