@echo off
set "ROOT=%~dp0"
set "WEB=%ROOT%web"

IF "%1"==""         GOTO start
IF "%1"=="start"    GOTO start
IF "%1"=="s"        GOTO start
IF "%1"=="dev"      GOTO dev
IF "%1"=="web"      GOTO web
IF "%1"=="w"        GOTO web
IF "%1"=="build"    GOTO build
IF "%1"=="b"        GOTO build
IF "%1"=="restart"  GOTO restart
IF "%1"=="r"        GOTO restart
IF "%1"=="kill"     GOTO kill
IF "%1"=="k"        GOTO kill
IF "%1"=="status"   GOTO status
IF "%1"=="st"       GOTO status
IF "%1"=="clean"    GOTO clean
IF "%1"=="version"  GOTO version
IF "%1"=="-v"       GOTO version
IF "%1"=="help"     GOTO help
IF "%1"=="-h"       GOTO help
GOTO help

:start
echo Starting Conductor desktop app...
cd /d "%WEB%"
call npx tauri dev
GOTO end

:dev
echo Starting Conductor in dev mode...
cd /d "%WEB%"
call npx tauri dev
GOTO end

:web
echo Starting Conductor Web server on port 56560...
cd /d "%ROOT%"
call node dist/index.js
GOTO end

:build
if "%2"=="web" (
    echo Building web frontend...
    cd /d "%WEB%"
    call npm run build
    echo Done.
    GOTO end
)
echo Building Conductor desktop app...
cd /d "%WEB%"
call npx tauri build
GOTO end

:restart
echo Restarting Conductor...
taskkill /f /im conductor.exe >nul 2>&1
timeout /t 2 /nobreak >nul
cd /d "%WEB%"
call npx tauri dev
GOTO end

:kill
echo Stopping all Conductor processes...
taskkill /f /im conductor.exe >nul 2>&1
echo Done.
GOTO end

:status
echo Conductor Process Status:
tasklist /fi "imagename eq conductor.exe" 2>nul | findstr /i "conductor.exe" >nul
if %errorlevel% equ 0 (
    tasklist /fi "imagename eq conductor.exe" /fo table 2>nul | findstr /i "conductor"
    echo Status: RUNNING
) else (
    echo Status: STOPPED
)
GOTO end

:clean
echo Cleaning build artifacts...
if exist "%WEB%\src-tauri\target" (
    rmdir /s /q "%WEB%\src-tauri\target" 2>nul
    echo Removed target/
)
if exist "%ROOT%dist" (
    rmdir /s /q "%ROOT%dist" 2>nul
    echo Removed dist/
)
echo Done.
GOTO end

:version
echo Conductor v0.1.0
GOTO end

:help
echo.
echo   Conductor v0.1.0 - Windows Agent Workbench
echo.
echo   Usage: conductor [command]
echo.
echo     start,   s    Launch desktop app (default)
echo     dev           Dev mode
echo     web,    w    Start web server (port 56560)
echo     build,  b    Build production .exe
echo             b web Build web frontend only
echo     restart,r    Kill all and relaunch
echo     kill,   k    Stop all processes
echo     status, st   Show running status
echo     clean        Remove build artifacts
echo     version,-v   Show version
echo     help,   -h   Show this help
echo.
echo   Examples:
echo     conductor          Launch desktop app
echo     conductor start    Launch desktop app
echo     conductor build    Build .exe
echo     conductor status   Check status
echo     conductor kill     Stop all
echo.
GOTO end

:end
