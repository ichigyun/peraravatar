@echo off
setlocal
pushd "%~dp0"

set "PORT=8765"

echo ============================================
echo   Peraravatar - Local server (Python)
echo ============================================
echo URL: http://localhost:%PORT%/
echo Press Ctrl+C to stop the server.
echo.

where py >nul 2>&1
if %ERRORLEVEL% == 0 (
  echo Using: py -m http.server %PORT%
  py -m http.server %PORT%
  goto end
)

where python >nul 2>&1
if %ERRORLEVEL% == 0 (
  echo Using: python -m http.server %PORT%
  python -m http.server %PORT%
  goto end
)

echo.
echo [ERROR] Python was not found on this system.
echo.
echo  See README.md for installation instructions, or use server-node.bat
echo  if you have Node.js installed instead.
echo.
pause

:end
popd
endlocal
