@echo off
setlocal
cd /d "%~dp0"
node configure-google.cjs %*
pause
