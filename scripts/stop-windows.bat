@echo off
setlocal
cd /d "%~dp0.."
docker compose down
if errorlevel 1 exit /b 1
echo Servisler durduruldu. PostgreSQL demo volume'u korunmustur.
