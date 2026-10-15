@echo off
rem Starts the HUDsplay telemetry backend in its own window, then the overlay window.
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

cd electron
rem check the actual binary: an interrupted download leaves node_modules behind without it
if not exist node_modules\electron\dist\electron.exe (
  echo.
  echo  Downloading the overlay window runtime ^(Electron, ~110 MB^).
  echo  There is no progress bar: this can take a few minutes, it is not frozen.
  echo.
  if exist node_modules\electron\install.js (
    call node node_modules\electron\install.js
  ) else (
    call npm install
  )
)
if not exist node_modules\electron\dist\electron.exe (
  echo.
  echo  Electron download failed ^(network, antivirus or firewall^).
  echo  Retry from a mirror in PowerShell, inside the hudsplay\electron folder:
  echo.
  echo    $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules\electron\install.js
  echo.
  echo  Then run start.bat again.
  echo.
  pause
  exit /b 1
)
cd ..

start "hudsplay-backend" cmd /k uv run hudsplay
cd electron
call npm start
