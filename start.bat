@echo off
rem Starts the racehud telemetry backend in its own window, then the overlay window.
cd /d "%~dp0"

where uv >nul 2>nul
if errorlevel 1 (
  echo.
  echo  uv is not installed ^(it runs the Python backend^).
  echo  Install it in PowerShell:
  echo.
  echo    powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  echo.
  echo  Then close this window and run start.bat again.
  echo  If it still says uv is not found, sign out of Windows and back in.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed ^(it runs the overlay window^).
  echo  Install it in PowerShell:
  echo.
  echo    winget install OpenJS.NodeJS.LTS
  echo.
  echo  or download the LTS installer from https://nodejs.org
  echo  Then close this window and run start.bat again.
  echo.
  pause
  exit /b 1
)

start "racehud-backend" cmd /k uv run racehud
cd electron
if not exist node_modules (
  echo Installing overlay window dependencies, first run only...
  call npm install
)
call npm start
