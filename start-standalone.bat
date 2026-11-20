@echo off
setlocal DisableDelayedExpansion

if not exist "%~dp0server\node_modules\.bin\tsx.cmd" (
    echo Missing dependencies. Run npm ci and npm ci --prefix server from the repository root.
    pause
    exit /b 1
)

echo Shared Perspective standalone server
echo.
set "SERVER_NAME="
set "PORT="
set /p "SERVER_NAME=Session name [Shared Perspective Standalone]: "
set /p "PORT=Port [8090]: "
echo.
call npm.cmd --prefix "%~dp0server" run --silent standalone
set "launch_status=%errorlevel%"
if not "%launch_status%"=="0" pause
exit /b %launch_status%
