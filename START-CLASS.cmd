@echo off
rem ============================================================
rem  PAST & PERIL
rem
rem  Double-click this. That is the whole procedure.
rem
rem  There is nothing to install. A copy of Node.js is inside the
rem  runtime folder next to this file, so this works on a machine
rem  where you are not allowed to install software.
rem
rem  Leave the black window OPEN for the whole lesson. Closing it
rem  stops the server. The period is saved continuously, so that
rem  loses nothing: start it again and the class picks up where it
rem  was, paused.
rem
rem  This file is deliberately thin. Everything it decides lives in
rem  tools\start.mjs, which is written in JavaScript and can be
rem  read. All this does is find a Node and hand over.
rem ============================================================
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Past and Peril  -  leave this window open

pushd "%~dp0" 2>nul
if errorlevel 1 goto :nofolder

rem ---- still inside a zip? -------------------------------------------
rem  Windows will happily run a .cmd from inside a compressed folder by
rem  unpacking it alone into a temporary directory. Everything else it
rem  needs is then missing, and the errors make no sense at all.
echo "%~dp0" | findstr /i /c:".zip" >nul
if not errorlevel 1 goto :inzip

rem ---- find a Node ----------------------------------------------------
set "NODE="
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not defined NODE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE=node"
)
if not defined NODE goto :nonode

rem ---- and can it actually run here? ----------------------------------
rem  On a managed machine, antivirus or AppLocker can refuse to run it.
rem  Better to say so plainly than to fail later with a stack trace.
"%NODE%" --version >nul 2>nul
if errorlevel 1 goto :blocked

"%NODE%" "%~dp0tools\start.mjs" %*
popd
exit /b 0

rem ====================================================================
:nofolder
echo.
echo   Could not open the folder this file is in.
echo.
echo   If you are running it from a network drive, copy the whole folder
echo   to your Desktop first and run it from there.
echo.
pause
exit /b 1

:inzip
echo.
echo   This is still inside a zip file.
echo.
echo   Right-click the zip, choose "Extract All...", and then run
echo   START-CLASS from the folder that comes out.
echo.
echo   (Windows will let you open files inside a zip, but the program
echo    cannot find the rest of itself, and the errors are baffling.)
echo.
pause
exit /b 1

:nonode
echo.
echo   Something is missing from this copy.
echo.
echo   There should be a folder called "runtime" next to this file, with
echo   node.exe inside it. If it is not there, the copy was incomplete —
echo   copy the folder again, all of it.
echo.
echo   If you would rather install Node.js yourself, get the LTS from
echo   https://nodejs.org and accept every default. Then run this again.
echo.
pause
exit /b 1

:blocked
echo.
echo   This computer will not let that program run.
echo.
echo   That is a security policy, not a fault in the software. Two things
echo   usually fix it:
echo.
echo     1. Copy the whole folder to your Desktop or Documents and run it
echo        from there, rather than from a USB stick or a network drive.
echo.
echo     2. If it still refuses, your technology department has to allow
echo        it. Show them this: it is node.exe, the official Node.js
echo        runtime, signed by the OpenJS Foundation. The signature is in
echo        the file's Properties, under Digital Signatures.
echo.
pause
exit /b 1
