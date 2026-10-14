@echo off
rem Builds the Windows installer: packaging\installer\racehud-setup-<version>.exe
rem   1. Python backend -> packaging\dist\racehud-backend\racehud-backend.exe (PyInstaller via uv)
rem   2. Electron overlay + backend -> NSIS installer (electron-builder)
cd /d "%~dp0"

where uv >nul 2>nul || (echo uv is not installed, see README. & exit /b 1)
where npm >nul 2>nul || (echo Node.js is not installed, see README. & exit /b 1)

echo.
echo  [1/2] backend exe
call uv sync || exit /b 1
call uv run pyinstaller --noconfirm --clean --onedir --windowed --name racehud-backend ^
  --distpath packaging\dist --workpath packaging\build --specpath packaging ^
  --paths src --add-data "../frontend;frontend" --collect-data pycountry ^
  --icon ..\electron\assets\icon.ico packaging\backend.py || exit /b 1

echo.
echo  [2/2] installer
cd electron
if not exist node_modules\electron-builder call npm install || exit /b 1
call npm run dist || exit /b 1
cd ..

echo.
echo  done: packaging\installer\
dir /b packaging\installer\*.exe
