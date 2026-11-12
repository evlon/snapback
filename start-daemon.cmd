@echo off
REM snapback daemon autostart (no admin required).
REM Place a shortcut to this file in shell:startup, or run it directly.
setlocal
set NODE_EXE=C:\nvm4w\nodejs\node.exe
set SCRIPT=E:\ai-works\dsh-undo\src\daemon.mjs
set DSH_UNDO_STORE=E:\dsh-undo-store

if not exist "%DSH_UNDO_STORE%\logs" mkdir "%DSH_UNDO_STORE%\logs"

REM Avoid duplicate daemons: if daemon.json reports a live pid, exit.
for /f "tokens=2 delims=:, " %%a in ('findstr /i "\"pid\"" "%DSH_UNDO_STORE%\daemon.json" 2^>nul') do set DPID=%%a
if defined DPID (
  tasklist /fi "PID eq %DPID%" 2>nul | find /i "%DPID%" >nul && (
    echo snapback daemon already running ^(pid %DPID%^)
    exit /b 0
  )
)

start "" /min "%NODE_EXE%" "%SCRIPT%" --store "%DSH_UNDO_STORE%"
exit /b 0
