@echo off
rem ============================================================
rem  SOMETHING WENT WRONG AND YOU WANT TO TELL SOMEBODY
rem
rem  This gathers what the program was doing, removes anything
rem  that identifies you or your school, and opens a page with it
rem  already filled in. You read it, then you press Submit.
rem
rem  Nothing is sent until you press that button.
rem ============================================================
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Report a problem
pushd "%~dp0" 2>nul

set "NODE="
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not defined NODE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE=node"
)
if not defined NODE (
  echo.
  echo   Cannot find node.exe, so a report cannot be gathered.
  echo.
  pause
  exit /b 1
)

echo.
echo   In one sentence: what went wrong?
echo   ^(For example: the map went blank when I pressed START^)
echo.
set "WHAT="
set /p "WHAT=  > "

echo.
"%NODE%" "%~dp0tools\report.mjs" %WHAT%
popd
pause
exit /b 0
