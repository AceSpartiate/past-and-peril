@echo off
rem ============================================================
rem  PAST & PERIL — force an update, then start
rem
rem  FOR A PLAYTEST MACHINE. Not for a machine a class uses.
rem
rem  START-CLASS.cmd will not update while a period has been saved
rem  in the last six hours, because that normally means a class is
rem  part-way through a unit and the code underneath it must not
rem  change. The guard cannot tell a class's real progress from a
rem  test save, so on a machine you are playtesting on, every
rem  session you run defers the next update by another six hours.
rem
rem  This file says "those saves are mine, go anyway". It overrides
rem  that one rule and nothing else:
rem
rem    · saved periods, the console key, logs and the bundled
rem      runtime are still never replaced
rem    · the version being replaced is still kept in .backup, and
rem      ROLLBACK.cmd still puts it back
rem    · a blocked or missing network still starts the class anyway
rem
rem  If you are not sure whether this machine is a playtest machine,
rem  it is not. Use START-CLASS.cmd.
rem ============================================================
setlocal EnableExtensions
pushd "%~dp0"
call "%~dp0START-CLASS.cmd" --force
popd
