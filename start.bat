@echo off
rem Starts the telemetry backend in its own window, then the overlay window.
cd /d "%~dp0"
start "overlay-backend" cmd /k uv run overlay
cd electron
if not exist node_modules call npm install
call npm start
