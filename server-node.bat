@echo off
setlocal
pushd "%~dp0"

set "PORT=8765"

echo ============================================
echo   Peraravatar - Local server (Node.js)
echo ============================================
echo URL: http://localhost:%PORT%/
echo Press Ctrl+C to stop the server.
echo.

where npx >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [ERROR] Node.js (npx) was not found on this system.
  echo.
  echo  See README.md for installation instructions, or use server-python.bat
  echo  if you have Python installed instead.
  echo.
  pause
  goto end
)

echo Using: npx --yes http-server -p %PORT% -c-1 .
echo (First run will download http-server, subsequent runs use the cache.)
echo.
npx --yes http-server -p %PORT% -c-1 .

:end
popd
endlocal
