@echo off
setlocal DisableDelayedExpansion
rem Copy this file to a new .bat in the repository root and edit these values.
set "SERVER_NAME=Team Standalone"
set "PORT=8090"
rem Set SERVER_PASSWORD or SHARED_PERSPECTIVE_SCOPES_FILE in the launch environment if needed.

if not exist "%~dp0server\node_modules\.bin\tsx.cmd" (
    echo Missing dependencies. Run npm ci and npm ci --prefix server from the repository root.
    exit /b 1
)

call npm.cmd --prefix "%~dp0server" run --silent standalone
exit /b %errorlevel%
