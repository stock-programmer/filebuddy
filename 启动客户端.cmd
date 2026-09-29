@echo off
cd /d "%~dp0"
node scripts\start-client.mjs
if errorlevel 1 (
  echo Startup failed. Check .my-agent\launcher.log and .my-agent\build.log
  pause
)
