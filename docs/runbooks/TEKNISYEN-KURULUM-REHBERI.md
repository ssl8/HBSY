# Hastane Bilgi İşlem Teknisyeni Kurulum ve İşletme Rehberi (Adım Adım)

Bu rehber, herhangi bir kamu veya özel hastanenin bilgi işlem teknisyeninin hiçbir ek yazılım lisansı veya dış danışmanlığa ihtiyaç duymadan **NOVA HBYS**'yi sıfırdan bir bilgisayara veya hastane sunucusuna kurabilmesi için hazırlanmıştır.

---

## 1. Hangi Sunucu / İşletim Sistemi Seçilmeli?

| Amaç | Önerilen Ortam | Gerekli Araç |
|---|---|---|
| **Hızlı İnceleme / Eğitim / Sunum** | Herhangi bir Windows/Linux PC | Yalnızca **Node.js 22+** |
| **Hastane Test / Pilot Sunucusu** | **Ubuntu 24.04 LTS**, **Debian 12**, **Pardus 23 Sunucu** veya **Windows 10/11 Pro (WSL2)** | **Docker Engine + Docker Compose V2** |

---

## 2. Sıfırdan Linux (Ubuntu / Debian / Pardus) Sunucu Hazırlığı

Temiz bir Linux sunucuya SSH ile bağlandıktan sonra aşağıdaki komutları sırayla uygulayın:

### 2.1. Docker Kurulumu (Ubuntu / Debian)
```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
docker compose version
```
*(Pardus kurumsal ortamında harici script yerine Debian/Docker resmi APT deposunu kurum paket politikanıza göre tanımlayabilirsiniz.)*

### 2.2. Güvenlik Duvarı (Test Ortamı)
Yalnızca ilgili arayüz portlarını açın:
```bash
sudo ufw allow 22/tcp     # SSH yönetiminiz için
sudo ufw allow 8088/tcp   # NOVA HBYS Web & API (HTTPS ters vekil varsa 443 açın)
sudo ufw allow 8080/tcp   # Keycloak giriş sayfası (ters vekil arkasında ise gizlenebilir)
```

### 2.3. Projeyi İndirme ve Başlatma
```bash
git clone https://github.com/ssl8/HBSY.git /opt/nova-hbys
cd /opt/nova-hbys
bash scripts/start-linux.sh
```
İlk kurulumda PostgreSQL 18 başlatılır, `db/migrations/V001`–`V016` şemaları ve en az ayrıcalıklı servis kullanıcıları kurulur, tüm `.NET 10` mikroservisleri derlenir ve hazır olduğunda ekrana `http://localhost:8088` çıktısı verilir.

---

## 3. Windows Bilgisayarda Kurulum

0. **Git yoksa önce terminalden tek komutla kurun** (ZIP indirdiyseniz zorunlu değildir):
   ```powershell
   winget install --id Git.MinGit -e --accept-package-agreements --accept-source-agreements
   ```
   *(Ardından yeni bir PowerShell penceresi açıp `git clone https://github.com/ssl8/HBSY.git C:\hbys` ile kısa bir dizine indirin.)*
1. **Sadece Demo görmek istiyorsanız:**
   - [Node.js 22 LTS](https://nodejs.org) kurun.
   - Klasördeki [`start-demo.bat`](../../start-demo.bat) dosyasına çift tıklayın.
   - Tarayıcı `http://localhost:8088` açılır.
2. **Tam Kurumsal Docker Kurulumu (PostgreSQL + Keycloak + .NET 10):**
   - [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) kurup başlatın.
   - [`start-windows.bat`](../../start-windows.bat) dosyasına çift tıklayın.
   - Parolalar otomatik olarak [`.env`](../../.env.example) içinde üretilir; yaklaşık 3–8 dakika sonra sistem açılır.

---

## 4. Kurulum Sonrası Sağlık Kontrolü

Kurulum tamamlandıktan sonra tüm bileşenlerin ayakta olduğunu doğrulayın:

```bash
# Konteyner durumları
docker compose ps

# Veritabanı rol ve sütun izolasyonu (V008, V013, V014, V015, V016) güvenlik testi
bash scripts/check-db-security.sh

# Yapılandırma ve servis sağlık yanıtları
curl -fsS http://127.0.0.1:8088/api/config
curl -fsS http://127.0.0.1:8088/health/connector
curl -fsS http://127.0.0.1:8088/health/worker
```

Beklenen çıktılar:
- `/api/config` -> `"mode":"enterprise","auth":"oidc"` döndürmelidir.
- Yetkisiz API çağrısı (`curl -i http://127.0.0.1:8088/api/patients`) **`401 Unauthorized`** dönmelidir (dönmüyorsa güvenlik kontrolünü yeniden inceleyin).

---

## 5. Hastane Yerel Ağına (LAN / Poliklinik Bilgisayarlarına) Açma

Varsayılan yapılandırma güvenlik nedeniyle yalnızca `127.0.0.1` üzerinden dinler. Diğer odalardan / katlardan erişim vermek için:

1. **Sabit IP veya DNS belirleyin**: Örneğin sunucu IP'si `10.20.30.40` veya alan adı `hbys.hastane.local`.
2. **HTTPS (TLS) ekleyin**: Tarayıcıda Keycloak PKCE + WebCrypto (`crypto.subtle`) mekanizmaları güvenli köken (HTTPS veya `localhost`) ister. Sunucunun önünde bir Nginx / Caddy / HAProxy ile `https://hbys.hastane.local` -> `127.0.0.1:8088` ve `https://kimlik.hastane.local` -> `127.0.0.1:8080` yönlendirmesi yapın.
3. **`.env` dosyasını güncelleyin**:
   ```env
   HBYS_PUBLIC_ISSUER=https://kimlik.hastane.local/realms/hbys
   HBYS_WEB_ORIGIN=https://hbys.hastane.local
   ```
4. **Keycloak Realm dosyasını güncelleyin ([`infra/keycloak/hbys-realm.json`](../../infra/keycloak/hbys-realm.json))**:
   - `hbys-web` client altında `redirectUris`, `webOrigins` ve `post.logout.redirect.uris` satırlarına `https://hbys.hastane.local/*` ekleyin (veya Keycloak Admin arayüzünden değiştirin).
5. **Gateway CSP başlığını güncelleyin ([`infra/nginx/nginx.conf`](../../infra/nginx/nginx.conf))**:
   - `Content-Security-Policy` içinde `connect-src 'self' https://kimlik.hastane.local` ve `form-action 'self' https://kimlik.hastane.local` olacak şekilde düzenleyin.
6. **Değişiklikleri uygulayın**:
   ```bash
   docker compose up -d --force-recreate
   ```

---

## 6. Günlük Yedekleme ve Kurtarma

### Veritabanı Yedeği Alma
```bash
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "hbys-yedek-$(date +%F).dump"
```

### Yedekten Geri Yükleme Testi
Yedeğin sağlam olduğundan emin olmadan canlı ortama basmayın. Ayrı bir test veritabanında deneyin:
```bash
docker compose exec -T postgres pg_restore -U postgres -d hbys --clean --if-exists < hbys-yedek-YYYY-AA-GG.dump
```

---

## 7. Güncelleme ve GitHub / Kurum İçi Git Sunucusuna Yükleme

- **Mevcut kurulumu yeni sürüme güncelleme:**
  ```bash
  git pull origin main
  docker compose up -d --build
  docker compose run --rm db-migrate
  ```
- `.env` dosyasını **ASLA** Git deposuna eklemeyin (`.gitignore` otomatik korur, yine de `git status` çıktısında `.env` görünmediğinden emin olun).
- Üretim şifrelerini depoda değil yalnızca kurulu sunucudaki `chmod 600 .env` dosyasında tutun.
- Yeni bir Git deposuna göndermek için:
  ```bash
  git init -b main
  git config user.name "Adiniz Soyadiniz"
  git config user.email "eposta@kurum.gov.tr"
  git add .
  git status
  git commit -m "NOVA HBYS acik kaynak kurulum"
  git remote add origin <DEPO-ADRESI>
  git push -u origin main
  ```
- Canlı kullanıma geçmeden önce [Güvenlik ve Canlıya Geçiş Kontrol Listesi](GO-LIVE-CHECKLIST.md) maddelerini kurum bilgi güvenliği ve başhekimlik onayıyla tamamlayın.
