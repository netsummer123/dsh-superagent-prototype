@echo off
REM Standalone superagent control on Windows. Usage: superagent.cmd <start|stop|restart|status>
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0superagent.ps1" %*
exit /b %errorlevel%
