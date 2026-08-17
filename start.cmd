@echo off
REM Starts the AEM Baltic task board on this computer.
REM Double-click this file, or run it from a terminal.

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node serve.js
  goto :eof
)

REM No Node? Python's built-in server works just as well.
where py >nul 2>nul
if %errorlevel%==0 (
  echo Serving on http://localhost:8765/ - press Ctrl+C to stop.
  start "" http://localhost:8765/
  py -3 -m http.server 8765 --bind 127.0.0.1
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo Serving on http://localhost:8765/ - press Ctrl+C to stop.
  start "" http://localhost:8765/
  python -m http.server 8765 --bind 127.0.0.1
  goto :eof
)

echo.
echo Neither Node.js nor Python was found on this computer.
echo Install Node.js from https://nodejs.org and run this file again.
echo.
pause
