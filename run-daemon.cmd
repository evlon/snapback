@echo off
REM snapback 守护进程启动器（隐藏窗口由计划任务配置负责）
setlocal
set NODE_EXE=C:\nvm4w\nodejs\node.exe
set SCRIPT=E:\ai-works\dsh-undo\src\daemon.mjs
set DSH_UNDO_STORE=E:\dsh-undo-store

"%NODE_EXE%" "%SCRIPT%" --store "%DSH_UNDO_STORE%" >> "%DSH_UNDO_STORE%\logs\daemon.out.log" 2>&1
