@echo off
cd /d "%~dp0browser"
node launch.mjs
if errorlevel 1 pause
