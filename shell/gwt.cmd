@echo off
rem gwt - git-wt-pool wrapper for cmd.exe.
rem Copy this file into a directory on your PATH. Batch files run inside your cmd session,
rem so the cd below changes the directory of your prompt.
rem Then:  gwt assign <branch>   gwt path root   gwt path 2   (gwt list, gwt free ... stay where you are)
rem GIT_WT_POOL_WRAPPER=1 is scoped by setlocal; it tells git-wt-pool that it runs through the wrapper.
rem The last line is expanded before endlocal runs, so the cd survives setlocal.
setlocal
set "GIT_WT_POOL_WRAPPER=1"
set "CWD_FILE=%TEMP%\git-wt-pool-%RANDOM%%RANDOM%.cwd"
call git-wt-pool %* --cwd-file "%CWD_FILE%"
set "RC=%ERRORLEVEL%"
set "TARGET="
if exist "%CWD_FILE%" (
    for /f "usebackq delims=" %%p in ("%CWD_FILE%") do set "TARGET=%%p"
    del "%CWD_FILE%" 2>nul
)
if defined TARGET (
    endlocal & cd /d "%TARGET%" & exit /b %RC%
)
endlocal & exit /b %RC%
