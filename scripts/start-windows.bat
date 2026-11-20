@echo off
setlocal
cd /d "%~dp0.."
echo ============================================================
echo   NOVA HBYS - STAGE 4 KURUMSAL KURULUM (WINDOWS)
echo ============================================================
where docker >nul 2>nul
if errorlevel 1 (
  echo.
  echo [BILGI] Docker Desktop bulunamadi veya calismiyor.
  echo Veritabanisiz Hizli Demonstrasyon Motoru baslatiliyor...
  echo (Tum ekranlar, Patient 360, CDS, HL7 LIS, PACS DICOM ve simulasyonlar hazir)
  echo.
  call "%~dp0..\start-demo.bat"
  exit /b %ERRORLEVEL%
)
docker compose version >nul 2>nul
if errorlevel 1 (
  echo [HATA] Docker Compose V2 bulunamadi.
  echo Hizli Demonstrasyon Motoru baslatiliyor...
  call "%~dp0..\start-demo.bat"
  exit /b %ERRORLEVEL%
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0initialize-env.ps1"
if errorlevel 1 (
  echo [HATA] Guvenli .env dosyasi olusturulamadi.
  pause
  exit /b 1
)
echo [1/3] PostgreSQL 18 veritabani baslatiliyor...
docker compose up -d postgres
if errorlevel 1 goto :compose_error

echo [2/3] Veritabani migration'lari (V001..V016) uygulaniyor...
docker compose run --rm db-migrate
if errorlevel 1 goto :compose_error

echo [3/3] .NET 10 servisleri, Keycloak 26 ve Nginx gateway derleniyor/baslatiliyor...
docker compose --parallel 2 up -d --build
if errorlevel 1 goto :compose_error

echo API servisleri, ConnectorSvc, Worker ve Keycloak hazirligi kontrol ediliyor...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wait-and-open.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%

:compose_error
echo [HATA] Docker Compose veya migration adimi basarisiz oldu.
echo Ayrıntilar icin 'docker compose logs' komutunu inceleyebilirsiniz.
echo Yedek olarak Hizli Demonstrasyon Motoru baslatiliyor...
call "%~dp0..\start-demo.bat"
exit /b 1
