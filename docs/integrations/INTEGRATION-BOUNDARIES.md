# NOVA HBYS — Entegrasyon Omurgası & Kurumsal Gateway Mimarisi

NOVA HBYS Stage 3.5, Türk Sağlık Bilişimi standartlarında kamu ve özel sağlık kurumlarının zorunlu entegrasyonlarını kapsayan tam teşekküllü bir simülasyon ve demonstrasyon motoruna sahiptir.

## 1. Entegrasyon Gateway Matrisi

| Gateway | Kurum / Protokol | HBYS Modülü | Sağlanan Yetenekler | Test / Simülasyon Durumu |
|---|---|---|---|---|
| **SGK MEDULA** | T.C. Sosyal Güvenlik Kurumu (SOAP 3.2 / WSDL & REST GSS) | Faturalama, Poliklinik, Eczane | GSS Müstehaklık Sorgulama, 12 haneli Takip No Alma, e-Reçete, e-Rapor, SUT Fatura İletimi, Katılım Payı Hesabı | **Aktif Simülasyon**: Anlık müstehaklık ve takip no üretimi, katılım payı muafiyet denetimi |
| **MHRS** | T.C. Sağlık Bakanlığı (REST v2 & HL7 FHIR Bridge) | Poliklinik, Hasta Kabul | Hekim Çalışma Cetveli, Randevu Senkronizasyonu, Randevudan 1-Tıkla Kabul Etme & Provizyon Alma | **Aktif Simülasyon**: Poliklinik randevu akışı, hekim doluluk slotları |
| **ULAK 112 Acil** | T.C. Sağlık Bakanlığı Acil Sağlık Hizmetleri (ASOS / WebSockets v4) | Acil Servis, Triyaj | 112 Ambulans Vaka Nakli, Kırmızı/Sarı/Yeşil Alan Triyajı, Vital Bulgular (TA, Nabız, SpO2, GKS), Acil Kabul | **Aktif Simülasyon**: Canlı ambulans akışı, tek tıkla vaka simülatörü |
| **USS / e-Nabız** | T.C. Sağlık Bakanlığı Ulusal Sağlık Sistemi (SOAP / XML & REST) | Tüm Klinik Süreçler | Paket 101 (Hasta Kayıt), Paket 102 (Hizmet/Muayene), Paket 201 (Laboratuvar), Paket 204 (Radyoloji), Paket 401 (Aşı), SYS Takip No | **Aktif Simülasyon**: Outbox kuyruğu, SYS Takip No üretimi, telemetri inceleme |
| **TİTCK ÜTS** | Türkiye İlaç ve Tıbbi Cihaz Kurumu (DataMatrix GS1-128 REST) | Eczane, Depo, Sarf | İlaç ve Tıbbi Cihaz Karekod Çözümleme, Lot ve SKT Doğrulama, Tekil Tüketim Bildirimi | **Aktif Simülasyon**: Barkod/karekod okuyucu ve sahtecilik kontrolü |
| **LIS / HL7 v2** | Laboratuvar Cihaz Üreticileri (HL7 v2.5.1 ORU^R01 / MLLP & HTTP) | Laboratuvar | Sysmex, Cobas vb. otoanalizörlerden Tam Kan Sayımı ve Biyokimya Sonuç Alımı, ACK (AA/AE) | **Aktif Simülasyon**: HTTP bridge ve tek tıkla analizör sonucu enjeksiyonu |
| **PACS / DICOM** | Radyoloji Arşivleme (DICOM PS3.18 WADO-RS & DICOMweb) | Radyoloji | Dijital Röntgen (CR), Tomografi (CT), Manyetik Rezonans (MR) DICOM görüntüleme | **Aktif Simülasyon**: İnteraktif HTML5 canvas DICOM görüntüleyici, parlaklık/kontrast/invert |

---

## 2. Demonstrasyon ve Test Endpoint'leri

Aşağıdaki API uçları `server.js` ve Nginx gateway üzerinden canlı olarak çağrılabilir:

- `GET /api/connectors/status`: Tüm 7 gateway'in ping süresi, uptime oranı ve günlük işlem telemetrisi.
- `GET /api/connectors/mhrs/appointments`: MHRS randevularını listeler ve arar.
- `POST /api/connectors/mhrs/admit`: Randevudan hastayı kabul eder, encounter açar ve MEDULA provizyonu alır.
- `GET /api/connectors/ulak/cases`: 112 ambulans vakalarının canlı akışını ve vital değerlerini getirir.
- `POST /api/connectors/ulak/admit`: 112 vakasını acil triyaj masasına kabul eder ve yatak atar.
- `POST /api/connectors/medula/provision`: TC Kimlik No, branş ve provizyon tipine göre SGK Müstehaklık sorgusu yapar ve Takip No üretir.
- `POST /api/connectors/uts/verify`: İlaç veya tıbbi cihaz karekodunu ÜTS nezdinde doğrular.
- `POST /api/connectors/simulate`: Canlı simülasyon olayları (112 ambulansı, HL7 cihaz sonucu vb.) enjekte eder.
- `POST /api/demo/reset`: Tüm simülasyon verilerini fabrika ayarlarına döndürür.

---

## 3. Canlı Kurum Bağlantısına Geçiş Kılavuzu

Sistemi Sağlık Bakanlığı veya SGK canlı prod/test ortamlarına bağlamak için gereken adımlar:
1. **SGK MEDULA**: Kurum IP allowlist kaydı, MEDULA Hastane Sözleşmesi, Tesis Kodu (`11340001`), Test/Prod WSDL uçları ve e-İmza (TÜRKTRUST/KamuSM) sürücüleri.
2. **Sağlık Bakanlığı MHRS**: Bakanlık Entegrasyon Protokolü, Kurum Kodu, Kullanıcı Adı/Şifre ve IP kısıtlaması.
3. **Sağlık Bakanlığı ULAK / 112 ASOS**: İl Sağlık Müdürlüğü 112 Başhekimliği VPN erişimi, ASOS Entegrasyon Yetkisi.
4. **USS / e-Nabız**: ÇKYS / SKRS Kurum Kodu, USS Firma Kodu, Sağlık Net 2 / USS Güvenlik Anahtarı, SSL İstemci Sertifikası.
5. **TİTCK ÜTS**: Kurum MERSİS/Vergi No, ÜTS Firma Token'ı ve Sistem Yetkilisi e-İmzası.
