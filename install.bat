@echo off
setlocal
title usage-hud - install

set "SRC=%~dp0desktop\plugin.js"
set "DST=%LOCALAPPDATA%\hermes\desktop-plugins\token-meter"

if not exist "%SRC%" (
  echo [ERROR] desktop\plugin.js not found next to this script.
  pause
  exit /b 1
)

if not exist "%DST%" mkdir "%DST%"
copy /Y "%SRC%" "%DST%\plugin.js" >nul

if errorlevel 1 (
  echo [ERROR] copy failed. Check folder permissions.
  pause
  exit /b 1
)

echo.
echo [OK] Installed to:
echo   %DST%
echo.
echo Next steps:
echo   1. Open Hermes Desktop
echo   2. Press Ctrl+K, search "Reload desktop plugins"
echo   3. Look at the bottom-right status bar
echo.
pause
