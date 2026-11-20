# NOVA HBYS — Stage 3 hardening

## Security and data integrity
- Replaced the single PostgreSQL superuser-like application login with a DB owner, migration identity, Keycloak identity, and nine separate non-superuser service roles.
- Added schema/table/sequence least-privilege grants and default privileges for future migrations.
- Runtime services cannot update/delete/truncate the append-only audit table.
- Added authenticated API read-access auditing; requests are blocked if audit append fails.
- Generated independent random local secrets in Windows startup instead of copying weak defaults.
- Hardened correlation-ID validation and exception handling for client disconnects / started responses.

## Clinical workflow
- Enforced department + order-type state transitions on the server and UI.
- Added bed transfer transactions, transfer history, automatic cleaning status, and cleaning-complete workflow.
- Prevented vaccination dates earlier than the patient's birth date.
- Prevented duplicate stock receipts for the same drug and delivery reference.
- Coalesced parallel OIDC refresh-token calls to avoid refresh-token rotation races.

## Validation
- Added DB-role security verification script and expanded CI smoke tests for anonymous API access.
- Updated CI to create disposable credentials and to validate the complete Compose stack.
- Runtime build/container tests still need execution on a machine with .NET 10 SDK and Docker Engine.


## Stage 3.1 integrity fixes
- Outbox idempotency no longer needs UPDATE permission for producer services and supports repeated events for the same aggregate.
- Stock receipt retries are idempotent; a different quantity for an already-used reference is rejected.
- Discharge now moves the bed to Cleaning; reuse requires a separately audited cleaning-complete action.
- Added DB constraints for bed/encounter state, admission discharge timestamp, prescription dispense timestamp, invoice payment timestamp, and stock movement signs.
- Added service-specific schema readiness probes and role-claim unit tests.
- Updated pinned .NET 10 JWT bearer and Npgsql packages to current patches.


## Stage 3.2 — veri güvenliği ve uçtan uca kontroller

- Migration runner her migration SQL'i ile `schema_migrations` ledger kaydını tek PostgreSQL transaction'ında uygular.
- V012 ile audit zinciri bütünlüğü veritabanı `BEFORE INSERT` trigger'ında da doğrulanır.
- Yerel servis bağlantı havuzları, dokuz API'nin toplam bağlantı bütçesi gözetilerek servis başına 8'e indirildi.
- API container'larında `no-new-privileges` ve tüm Linux capability'lerinin kaldırılması etkinleştirildi.
- Aşı doğum tarihi kontrolü, ISO-8601 offset dönüşümünden kaynaklı bir takvim günü kaymasını önleyecek şekilde yerel tarih bileşeni üzerinden yapılır.
- Hekimlerin sonuçlanmış istemi onaylama eylemi UI'da API rol kurallarıyla eşitlendi.
- Windows ilk build işlemi sınırlı paralellikle yürütülür; düşük bellekli makinelerde ani kaynak tüketimi azaltılır.


## Stage 3.2 — Hardening and regression suite (2026-11-05)

- OIDC callback `state` doğrulaması başarılı/hata dönüşlerinin tamamına uygulandı; eksik verifier/nonce veya eksik token seti kabul edilmiyor ve callback URL parametreleri her zaman temizleniyor.
- Refresh-token rotation için tek uçuş (single-flight) kilidi korunup callback cleanup akışı deterministik hale getirildi.
- PostgreSQL audit zincirine DB seviyesinde `BEFORE INSERT` doğrulaması eklendi: önceki hash, canonical JSON, satır alanları, timestamp ve SHA-256 digest kontrol ediliyor.
- DB güvenlik doğrulaması runtime rollerin süper kullanıcı/DDL ayrıcalıklarını, tablo sahipliğini, şema izolasyonunu, audit append-only izinlerini, outbox kolon izinlerini ve sahte audit insert reddini denetliyor.
- Hasta servisinin outbox dashboard görünürlüğü `status` ve `created_at` kolonlarına daraltıldı; payload içeriğine erişim kaldırıldı.
- Playwright Chromium E2E testleri eklendi: admin/audit/integration akışı, laboratuvar rolü ve finans rolü ekran izolasyonu. CI içinde Docker yığını readiness ve anonim 401 kontrollerinden sonra çalıştırılır.
- CI tarayıcı bağımlılığını `@playwright/test` 1.64.1 doğrudan sürümüne sabitler; ortamda npm kayıt sunucusuna erişim olmadığı için lockfile burada üretilemedi, GitHub Actions kurulum adımında bağımlılık indirilir.
- `patient_svc` dashboard outbox izni yalnız gerekli iki kolona daraltıldı.

Doğrulama notu: Bash/JavaScript/configuration statik kontrolleri bu paket üzerinde çalıştırılabilir. Bu oturumda .NET SDK, Docker Engine ve PostgreSQL runtime mevcut olmadığından gerçek derleme, migration uygulama ve Playwright tarayıcı çalıştırması burada yürütülmedi; CI bu kontrollerin gerçek ortamda çalıştırılması için yapılandırılmıştır.


## Stage 3.3 — 2026-11-05

- `integration_svc` outbox tablosu için tam SELECT/UPDATE yetkisinden sütun düzeyinde metadata okuma ve sınırlı durum güncelleme yetkisine indirildi. `payload` alanı API kimliğine kapatıldı; integration şemasında geniş varsayılan yetki kaldırıldı.
- DB güvenlik denetimi, integration API rolünün payload okuma/yazma yetkisi olmadığını ve retry için gerekli metadata izinlerinin mevcut olduğunu doğrular.
- OIDC E2E dönüş testi, callback query parametreleri uygulama tarafından temizlense de güvenilir biçimde çalışacak şekilde yönlendirme kontrolünü düzenler.
- Güvenlik dokümantasyonu; ID token JWKS imza/claim doğrulaması, audit trigger sınırları ve ayrı entegrasyon gönderici worker gereksinimiyle güncellendi.

- Geriye dönük kurulumlar için outbox payload erişim daraltması ayrı `V013` migration dosyasına taşındı; önceki migration geçmişi değiştirilmedi.


## Stage 3.4 — 2026-11-05

- Önceden yayımlanmış V008 migration geçmişi korunup outbox en az ayrıcalık düzeltmesi artımlı V013 migration’ına taşındı.
- Integration API yalnız outbox metadata alanlarını okur/günceller; payload’a erişemez. Producer servisleri idempotent enqueue için sadece `id` ve `idempotency_key` sütunlarına erişir; hasta dashboard yalnız `status` alanını da okuyabilir.
- Audit zinciri okuma doğrulaması, hash ve previous-hash kontrolüne ek olarak kanonik payload ile DB satır sütunları arasındaki tutarlılığı kontrol eder.
- Audit payload doğrulayıcı için pozitif, kolon-tamper, detay-tamper ve bozuk JSON testleri eklendi.
- DB güvenlik denetimi tüm outbox producer rollerinde gerekli minimal idempotency kolon izinlerini doğrular.


## Stage 3.5 — 2026-11-05

- Yeni V014 migration, hasta ve başvuru tablolarındaki servisler arası erişimi sütun bazında daraltır. Finans, klinik, ADT, eczane, halk sağlığı ve LIS artık yalnızca iş akışı için gereken hasta alanlarını okuyabilir.
- ADT rolünün başvuru güncelleme yetkisi `status` ve `closed_at` alanlarıyla sınırlandı.
- PatientSvc `/api/encounters` yanıtı başvuru şikâyeti ve ayrıntılı zaman alanlarını dışarıda bırakacak şekilde küçültüldü.
- Güvenlik denetimi V014 migration'ını, role özel izinleri ve geniş tablo ayrıcalıklarının kaldırıldığını kontrol eder.

- Halk sağlığı aşılama uç noktasındaki `FOR UPDATE` kilidi kaldırıldı; servis hasta tablosunda yalnızca SELECT yetkisine sahip olduğundan bu kilit PostgreSQL UPDATE ayrıcalığı gerektirerek işlemi başarısız kılacaktı. Yetki daraltması korunurken salt-okunur hasta doğrulaması kullanılıyor.
- Faturalama başvuru seçicisinde durum filtresi kullandığı için `billing_svc` rolüne `patient.encounters.status` sütunu ayrıca verildi; hassas başvuru açıklaması/tarih sütunları kapalı kaldı.
- Keycloak JDBC bağlantı havuzu 12 bağlantı ile sınırlandırıldı; dokuz API havuzunun toplam üst sınırıyla birlikte PostgreSQL bağlantı bütçesi belgelendi.


### Stage 3.5 packaging hardening

- Migration runner now uses explicit SQL `SET ROLE hbys_owner` and `SET LOCAL ROLE hbys_owner` instead of relying on `PGOPTIONS` role startup behavior.
- Added a refreshed verification report distinguishing static checks from runtime checks unavailable in the packaging environment.
- Migration ledger lookup now uses psql stdin so `:'version'` is safely interpolated by psql; `-c` is kept free of psql-only substitution syntax.
