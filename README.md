# NOVA HBYS — Açık Kaynak, Sıfır Lisans Maliyetli Kurumsal Hastane Bilgi Yönetim Sistemi

**Kamu hastanelerinin ve EKAP kaynaklarının eski, kapalı kaynak ve yüksek lisans/bakım faturalı yazılımlara gereksiz yere harcanmaması için** sıfırdan açık kaynaklı (MIT Lisansı) olarak hazırlanmış; herhangi bir hastanenin Bilgi İşlem teknisyeninin ek ücret ödemeden indirip kurabileceği, inceleyebileceği, uyarlayabileceği ve çalıştırabileceği modern HBYS platformudur.

> **Kapsam ve Şeffaflık Notu:** Bu depo; tam çalışan `.NET 10` mikroservis çekirdeğini, en az ayrıcalıklı (`least-privilege`) **PostgreSQL 18 (`V001`–`V016`)** veritabanı mimarisini, **Keycloak 26 OIDC** kimlik yönetimini, **Nginx** güvenlik geçidini, bağımlılıksız modüler web arayüzünü ve harici kurulum gerektirmeyen anlık demonstrasyon/eğitim sunucusunu içerir.
> MHRS, ULAK 112, MEDULA, e-Nabız/USS ve TİTCK İTS ağ geçitleri hazır arayüz ve sandbox/outbox mimarisiyle gelir; **gerçek hasta verisiyle canlıya geçiş** öncesinde bakanlık/SGK resmi sertifikalarının (mTLS), güncel SKRS/SUT kod listelerinin, hastane içi HTTPS sertifikalarının ve KVKK onaylarının kurum bilgi işlem ekibince tamamlanması gerekir ([Güvenlik ve Canlıya Geçiş Kontrol Listesi](docs/runbooks/GO-LIVE-CHECKLIST.md)).

---

## İçindekiler
- [Sistem Neler Sunar?](#sistem-neler-sunar)
- [Kurulum Öncesi Gereksinimler](#kurulum-öncesi-gereksinimler)
- [1. Adım: Git Kurulumu ve Projeyi İndirme](#1-adım-git-kurulumu-ve-projeyi-indirme)
- [Yöntem A: 1 Dakikada Kurulumsuz Hızlı Test ve Eğitim (Sadece Node.js)](#yöntem-a-1-dakikada-kurulumsuz-hızlı-test-ve-eğitim-sadece-nodejs)
- [Yöntem B: Tam Kurumsal Kurulum (.NET 10 + PostgreSQL 18 + Keycloak + Nginx)](#yöntem-b-tam-kurumsal-kurulum-net-10--postgresql-18--keycloak--nginx)
  - [Windows Bilgisayarda / Sunucuda Kurulum](#windows-bilgisayarda--sunucuda-kurulum)
  - [Linux / Pardus / Ubuntu Hastane Sunucusunda Kurulum](#linux--pardus--ubuntu-hastane-sunucusunda-kurulum)
- [Hazır Kullanıcı Hesapları ve Roller](#hazır-kullanıcı-hesapları-ve-roller)
- [Hastane Yerel Ağına (LAN) Açma ve Güvenlik Ayarları](#hastane-yerel-ağına-lan-açma-ve-güvenlik-ayarları)
- [Sık Karşılaşılan Sorunlar ve Çözümleri](#sık-karşılaşılan-sorunlar-ve-çözümleri)
- [Teknik Doğrulama ve Testler](#teknik-doğrulama-ve-testler)

---

## Sistem Neler Sunar?

- **Hasta 360° Elektronik Tıbbi Kayıt (EMR)**: Demografik bilgiler, kronik hastalık ve alerji uyarı etiketleri, vital bulgu grafik özeti, SOAP klinik notları, aktif istemler, lab/radyoloji ve reçete geçmişi tek çekmecede.
- **Klinik Karar Destek (CDS) ve Hasta Güvenliği**:
  - **İlaç–Alerji Çakışma Kontrolü**: Alerjili hastaya riskli etken madde yazıldığında sistem `409 ALLERGY_CONFLICT` uyarısı vererek engeller; yalnızca hekimin gerekçeli klinik onayıyla (`ALLERGY_OVERRIDE`) kaydedilir ve denetim zincirine işlenir.
  - **Kritik Laboratuvar Sonucu Geri Bildirim Onayı (Read-Back)**: Panik değerlerde (`CriticalLabEvaluator`) hekim okuma/iletme onayı zorunlu tutulur.
  - **Hemşirelik Vital Bulguları ve NEWS2 Skoru**: Solunum, SpO2, tansiyon, nabız, ateş ve bilinç (`A/V/P/U`) üzerinden deterministik NEWS2 risk skoru.
- **LİS HL7 v2.5.1 ORU^R01 + PACS DICOM Görüntüleyici**: Gerçek HL7 segment ayrıştırıcı, `MSH-10` tekrar önleme (`deduplication`) ve `CR`/`CT`/`MR`/`US` modaliteleri destekleyen pencereleme, kesit, yakınlaştırma ve milimetrik cetvel özellikli tarayıcı DICOM görüntüleyici.
- **ADT Yatak / Transfer Yönetimi, Çoklu e-Reçete & Otomatik SUT Faturalama**: Yatak devir tarihçesi, atomik eczane stok düşümü, idempotent stok girişi ve karşılaşma bazlı otomatik SUT fatura kalemi oluşturma.
- **7 Dış Entegrasyon Ağ Geçidi + Arka Plan Outbox İşçisi (`ConnectorSvc` & `IntegrationWorker`)**: MHRS, ULAK 112, MEDULA, e-Nabız/USS, TİTCK İTS, HL7/LİS ve PACS.
- **Değiştirilemez SHA-256 Denetim İzi ve Katı Yetki İzolasyonu**: Tüm kritik işlemler birbirine zincirli SHA-256 hash ile kaydedilir; her mikroservis veritabanına en düşük yetkili kendi rolüyle bağlanır (`V008`, `V013`, `V014`, `V015`, `V016`).

---

## Kurulum Öncesi Gereksinimler

İhtiyacınıza göre iki çalıştırma yöntemi vardır:

| Özellik | Yöntem A — Hızlı İnceleme / Eğitim (Demo) | Yöntem B — Tam Kurumsal Sistem (Docker Stack) |
|---|---|---|
| **Kurulacak Programlar** | Yalnızca **Node.js 22+** | **Docker Desktop** (Windows) veya **Docker Engine + Compose v2** (Linux/Pardus) |
| **Donanım** | 2 Çekirdek CPU, 1 GB RAM | En az 4 Çekirdek CPU, 8 GB RAM, 20 GB boş disk |
| **Açık Portlar** | `8088` | `8088` (Web & API), `8080` (Keycloak Kimlik), `5432` (Yerel DB) |
| **Kimlik Doğrulama** | Anlık Oturum + 9 Rol Hızlı Geçiş | Gerçek Keycloak 26 OIDC + PKCE (`S256`) + JWKS |
| **Veritabanı** | Bellek içi (yeniden başlatınca sıfırlanır) | Kalıcı PostgreSQL 18 (`V001`–`V016` migration) |

---

## 1. Adım: Git Kurulumu ve Projeyi İndirme

Bilgisayarınızda veya sunucunuzda henüz Git yoksa önce kurun:

- **Windows (PowerShell — Yönetici şifresi gerektirmeyen sürüm):**
  ```powershell
  winget install --id Git.MinGit -e --accept-package-agreements --accept-source-agreements
  ```
  *(Alternatif olarak yönetici yetkili PC'lerde [git-scm.com](https://git-scm.com/downloads/win) veya `winget install --id Git.Git -e` kullanabilirsiniz; kurulum sonrası yeni bir terminal açın.)*
- **Ubuntu / Debian / Pardus Linux:**
  ```bash
  sudo apt-get update && sudo apt-get install -y git
  ```

Ardından projeyi klonlayın (veya Git kullanmadan GitHub sayfasındaki **`<> Code` -> `Download ZIP`** ile indirin):

```bash
git clone https://github.com/ssl8/HBSY.git hbys
cd hbys
```

> **Güncelleme Almak İçin:** İleride yeni iyileştirmeler yayınlandığında klasör içinde `git pull` komutunu çalıştırmanız ve Docker kullanıyorsanız `docker compose up -d --build` demeniz yeterlidir.
> **Not:** Windows kullanıcıları dosyaları doğrudan Masaüstü yerine `C:\hbys` gibi kısa ve Türkçe karakter/boşluk içermeyen bir klasöre açarsa Docker derleme sorunları yaşamaz.

---

## Yöntem A: 1 Dakikada Kurulumsuz Hızlı Test ve Eğitim (Sadece Node.js)

Sistemi hekimlere, hemşirelere veya yönetime hızla göstermek için Docker veya veritabanı kurmadan çalıştırabilirsiniz:

1. [https://nodejs.org](https://nodejs.org) adresinden **Node.js 22 LTS** sürümünü kurun.
2. **Windows:** Klasördeki [`start-demo.bat`](start-demo.bat) dosyasına çift tıklayın.
   **Linux / macOS / Terminal:**
   ```bash
   node server.js
   ```
3. Tarayıcı otomatik açılmazsa **`http://localhost:8088`** adresine gidin.
4. Giriş ekranından istediğiniz hastane rolünü (`Hekim`, `Hemşire`, `Eczacı`, `Laboratuvar`, `Hasta Kayıt`, `Faturalama`, `Yönetici` vb.) seçerek tek tıkla girin; üst çubuktan **12 Adımlı Hastane Turu**nu başlatarak gerçek bir acil/poliklinik senaryosunu adım adım izleyebilirsiniz.

---

## Yöntem B: Tam Kurumsal Kurulum (.NET 10 + PostgreSQL 18 + Keycloak + Nginx)

Tüm veritabanı şemalarının, 10 `.NET 10` mikroservisinin, arka plan outbox işçisinin (`IntegrationWorker`) ve gerçek Keycloak kimlik doğrulamasının ayağa kalkması için aşağıdaki adımları izleyin.

### Windows Bilgisayarda / Sunucuda Kurulum

1. **Docker Desktop**'ı kurun ve açın (kurulum sırasında WSL 2 varsayılan olarak açık kalmalıdır; sağ altta balina simgesinin "Engine running" olmasını bekleyin).
2. Klasör içindeki [`start-windows.bat`](start-windows.bat) dosyasına **çift tıklayın**.
   - Bu betik otomatik olarak [`initialize-env.ps1`](scripts/initialize-env.ps1) ile tüm veritabanı rolleri ve Keycloak için benzersiz rastgele parolalar içeren `.env` dosyasını oluşturur.
   - PostgreSQL 18'i başlatır ve `V001`–`V016` veritabanı tablolarını/yetkilerini kurar.
   - Tüm `.NET 10` mikroservislerini derler, Keycloak ve Nginx ağ geçidini başlatır.
   - İlk derleme internet hızına göre **3–8 dakika** sürebilir; hazır olduğunda tarayıcınızda `http://localhost:8088` otomatik açılır.
3. **Kapatmak için:** [`stop-windows.bat`](stop-windows.bat) (verileriniz korunur).
4. **Demo veritabanını sıfırlamak için:** [`reset-demo.bat`](reset-demo.bat).

### Linux / Pardus / Ubuntu Hastane Sunucusunda Kurulum

1. Sunucuda Docker Engine ve Docker Compose v2 yüklü olmalıdır (henüz kurulu değilse detaylı komutlar [Teknisyen Kurulum Rehberi](docs/runbooks/TEKNISYEN-KURULUM-REHBERI.md) içindedir).
2. Tek komutla kurulum betiğini çalıştırın:
   ```bash
   bash scripts/start-linux.sh
   ```
   Bu betik otomatik olarak `scripts/init-env.sh` ile `chmod 600` korumalı güçlü `.env` dosyasını üretir, `V001`–`V016` migration'larını uygular, konteynerleri derleyip başlatır ve tüm sağlık kontrolleri (`200 OK`) gelene kadar bekler.
3. Durdurmak için:
   ```bash
   bash scripts/stop-linux.sh
   ```
4. Veritabanı güvenlik sınırlarını doğrulamak için:
   ```bash
   bash scripts/check-db-security.sh
   ```

---

## Hazır Kullanıcı Hesapları ve Roller

Hem Keycloak OIDC kurulumunda (`infra/keycloak/hbys-realm.json`) hem de Demo modunda aynı 9 hastane rolü tanımlıdır:

| Rol (`#user-role`) | Keycloak Kullanıcı Adı | Varsayılan Parola | Erişim Yetkisi Özeti |
|---|---|---|---|
| **Sistem Yöneticisi** (`admin`) | `admin` | `Admin123!` | Tüm ekranlar, SHA-256 Denetim İzi, Outbox/Entegrasyonlar |
| **Hekim** (`doctor`) | `doctor` | `Doctor123!` | Hasta 360°, Muayene/SOAP, İstemler, Reçete/CDS Onayı, Kritik Lab Okuma |
| **Hemşire** (`nurse`) | `nurse` | `Nurse123!` | Hasta, Yatak/ADT, Vital Bulgular + NEWS2, Aşılama, İlaç Listesi |
| **Hasta Kayıt Görevlisi** (`registrar`) | `registrar` | `Registrar123!` | Hasta Kayıt, Başvuru Açma, Yatak Kabul, MHRS Randevu |
| **Laboratuvar Teknisyeni** (`lab`) | `lab` | `Lab123!` | Klinik LİS İstemleri, Lab Sonucu Girişi, HL7 ORU İşleme *(Hasta listesine kapalı)* |
| **Radyoloji Teknisyeni** (`radiology`) | `radiology` | `Radiology123!` | Radyoloji İstemleri, DICOM/Rapor Girişi *(Lab sonuçlarına ve hasta listesine kapalı)* |
| **Eczacı** (`pharmacist`) | `pharmacy` | `Pharmacy123!` | Stok Girişi/Hareket Defteri, Reçete Karşılama *(Hasta listesine ve klinik istemlere kapalı)* |
| **Faturalama Uzmanı** (`billing`) | `billing` | `Billing123!` | Başvuru Bazlı SUT Fatura Önizleme, Fatura Kesme, MEDULA Provizyon *(Hasta listesine ve klinik istemlere kapalı)* |
| **Entegrasyon Operatörü** (`integration`) | `integration` | `Integration123!` | Outbox / Entegrasyon Kayıtları (payload gizli), Konektörler, HL7 *(Klinik/hasta verisine kapalı)* |

> **ÖNEMLİ UYARI:** Yerel test sonrası kurumsal sunucuda kullanmadan önce Keycloak Yönetim Panelinden (`http://localhost:8080`) veya yeni realm tanımınızdan tüm bu örnek parolaları mutlaka değiştirin.

---

## Hastane Yerel Ağına (LAN) Açma ve Güvenlik Ayarları

Güvenlik gereği kurulum varsayılan olarak sadece kendi bilgisayarınızdan (`127.0.0.1:8088`) erişime izin verir. Hastane içi yerel ağdaki poliklinik/servis bilgisayarlarından erişim açmak için:

1. Sunucuya sabit bir dahili IP veya kurum içi alan adı tanımlayın (ör. `https://hbys.hastane.local`).
2. **`.env`** dosyasında `HBYS_PUBLIC_ISSUER` ve `HBYS_WEB_ORIGIN` değerlerini bu adrese göre güncelleyin.
3. **[`infra/keycloak/hbys-realm.json`](infra/keycloak/hbys-realm.json)** içinde `hbys-web` istemcisinin `redirectUris` ve `webOrigins` listesine yeni adresinizi ekleyin.
4. **[`infra/nginx/nginx.conf`](infra/nginx/nginx.conf)** içindeki CSP `connect-src` / `form-action` satırlarını Keycloak adresinizle eşleyin.
5. Tarayıcı WebCrypto ve OIDC standartları gereği LAN üzerinde düz HTTP yerine önüne **Nginx/Caddy TLS (HTTPS)** koyun.

Adım adım komutlar için: [Teknisyen Kurulum ve İşletme Rehberi](docs/runbooks/TEKNISYEN-KURULUM-REHBERI.md).

---

## Sık Karşılaşılan Sorunlar ve Çözümleri

| Sorun | Nedeni | Çözümü |
|---|---|---|
| `8088` veya `8080` portu dolu hatası | Bilgisayarda başka bir web sunucusu veya IIS/Apache çalışıyor | Portu kullanan servisi durdurun veya `docker-compose.yml` içinde sol taraf portunu (`8098:80`) değiştirin |
| Windows'ta `docker compose` hatası | Docker Desktop kapalı veya WSL2 başlatılmamış | Docker Desktop'ı açıp 30 sn bekleyin; acil tanıtım gerekiyorsa `start-demo.bat` çalıştırın |
| Keycloak giriş ekranına dönüyor / `401` | `.env` içindeki `HBYS_PUBLIC_ISSUER` ile tarayıcıdaki Keycloak adresi farklı | `.env` dosyasını kontrol edin, ardından `docker compose up -d --force-recreate` çalıştırın |
| Migration hatası (`V001..V016`) | Önceki sürümden kalma bozuk PostgreSQL volume'u | Test ortamındaysanız `docker compose down -v` yapıp temiz kurulum başlatın |
| GitHub'a atarken gizli şifre sızar mı? | `.env` dosyasında yerel şifreler üretilir | [`.gitignore`](.gitignore) dosyası `.env`, `node_modules/` ve `bin/`/`obj/` klasörlerini otomatik olarak hariç tutar; yine de `git status` ile kontrol edin |

---

## Teknik Doğrulama ve Testler

```bash
# Node.js parity ve güvenlik testleri (Docker gerektirmez)
npm run test:api     # 9 rol RBAC, CDS alerji, NEWS2, HL7 MSH-10 dedup, SUT fatura, SHA-256 audit
npm run test:tour    # 12 adımlı uçtan uca simülasyon turu

# Tüm sistem doğrulaması (Windows PowerShell)
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1

# .NET 10 domain birim testleri (.NET SDK kurulu ise)
dotnet test tests/DomainTests/DomainTests.csproj --configuration Release

# Tam Docker + Keycloak tarayıcı E2E testleri
npm run e2e
```

---

## Kurum İçi Özelleştirme ve GitHub'a Yayınlama (Geliştiriciler İçin)

Bu projeyi kendi GitHub hesabınıza yüklemek veya hastane içi Git sunucunuzda özelleştirmek için:

```bash
git init -b main
git config user.name "Adiniz Soyadiniz"
git config user.email "eposta@kurum.gov.tr"
git add .
git status     # .env dosyasinin listelenmediginden emin olun!
git commit -m "Acik kaynak NOVA HBYS ilk surum"
git remote add origin https://github.com/<KULLANICI-ADINIZ>/<REPO-ADINIZ>.git
git push -u origin main
```

---

## Ek Teknik Dokümantasyon
- [Teknisyen Kurulum ve Hastane İçi Yayınlama Rehberi (TR)](docs/runbooks/TEKNISYEN-KURULUM-REHBERI.md)
- [Yerel Operasyonlar ve Arıza Giderme (TR)](docs/runbooks/LOCAL-OPERATIONS.md)
- [Birleşik API ve Domain Sözleşmesi](docs/architecture/UNIFIED-CONTRACT.md)
- [Sistem Mimarisi](docs/architecture/ARCHITECTURE.md) · [API Özeti](docs/api/API.md) · [Güvenlik Kontrolleri](docs/security/SECURITY-AND-GO-LIVE.md) · [Doğrulama Raporu](VERIFICATION-REPORT.md)

**Lisans:** [MIT License](LICENSE) — Kamu ve özel tüm sağlık kurumlarının ücretsiz kullanımına, incelemesine ve geliştirmesine açıktır.
