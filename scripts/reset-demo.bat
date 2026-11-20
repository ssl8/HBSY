@echo off
setlocal
cd /d "%~dp0.."
echo DIKKAT: PostgreSQL volume'u ve tum yerel demo kayitlari kalici olarak silinecek.
choice /C EN /M "Devam etmek icin E, iptal icin N"
if errorlevel 2 exit /b 0
docker compose down -v
if errorlevel 1 exit /b 1
call start-windows.bat
