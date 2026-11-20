@echo off
setlocal
call "%~dp0scripts\stop-windows.bat"
exit /b %ERRORLEVEL%
