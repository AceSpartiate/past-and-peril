@echo off
rem ============================================================
rem  PUT THE PREVIOUS VERSION BACK
rem
rem  An update keeps the version it replaced. If today's update
rem  broke something, run this and you are back where you were.
rem
rem  Your saved lessons are never touched by either direction.
rem ============================================================
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Roll back to the previous version
pushd "%~dp0" 2>nul

set "NODE="
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not defined NODE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE=node"
)
if not defined NODE (
  echo.
  echo   Cannot find node.exe.
  echo.
  pause
  exit /b 1
)

"%NODE%" "%~dp0tools\rollback.mjs"
popd
pause
exit /b 0
