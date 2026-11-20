@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo   NOVA HBYS — HIZLI DEMONSTRASYON & TEST SUNUCUSU
echo   MEDULA - MHRS - ULAK 112 - USS e-Nabiz - ITS - LIS - PACS
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [HATA] Node.js 22+ sistemde bulunamadi.
  echo Lutfen https://nodejs.org adresinden Node.js LTS surumunu kurup
  echo bu dosyayi tekrar calistirin.
  echo.
  echo Tam Docker kurulumu icin Docker Desktop yukleyip start-windows.bat calistirabilirsiniz.
  pause
  exit /b 1
)
echo Sunucu baslatiliyor: http://localhost:8088
echo Kapatmak icin bu pencereyi kapatin veya CTRL+C tuslarina basin.
echo.
start "" http://localhost:8088
node server.js
pause
