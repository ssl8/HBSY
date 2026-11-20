-- V015: Connectors and Extended Demo Seed
-- Supports MEDULA, MHRS, ULAK 112, USS e-Nabiz, and UTS integration tables and rich synthetic dataset
-- PII minimization: connector tables store tokenized patient_ref + nullable patient_id FK, never raw TCKN.

CREATE TABLE IF NOT EXISTS integration.mhrs_appointments (
    id VARCHAR(40) PRIMARY KEY,
    patient_id BIGINT REFERENCES patient.patients(id),
    patient_ref VARCHAR(40) NOT NULL,
    patient_name VARCHAR(120) NOT NULL,
    polyclinic VARCHAR(120) NOT NULL,
    doctor VARCHAR(120) NOT NULL,
    appointment_time VARCHAR(10) NOT NULL,
    appointment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(30) NOT NULL DEFAULT 'Booked',
    encounter_id BIGINT REFERENCES patient.encounters(id),
    medula_takip_no VARCHAR(40),
    note VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration.ulak_cases (
    id VARCHAR(40) PRIMARY KEY,
    patient_id BIGINT REFERENCES patient.patients(id),
    patient_name VARCHAR(120) NOT NULL,
    patient_ref VARCHAR(40) NOT NULL,
    team_code VARCHAR(30) NOT NULL,
    ambulance_plate VARCHAR(30) NOT NULL,
    triage_level VARCHAR(20) NOT NULL CHECK (triage_level IN ('RED','YELLOW','GREEN')),
    triage_title VARCHAR(120) NOT NULL,
    incident_summary VARCHAR(1000) NOT NULL,
    vitals JSONB NOT NULL DEFAULT '{}'::jsonb,
    eta_minutes INT NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'EnRoute',
    encounter_id BIGINT REFERENCES patient.encounters(id),
    bed_assigned VARCHAR(40),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    arrived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS integration.medula_provisions (
    takip_no VARCHAR(40) PRIMARY KEY,
    patient_id BIGINT REFERENCES patient.patients(id),
    encounter_id BIGINT REFERENCES patient.encounters(id),
    patient_ref VARCHAR(40) NOT NULL,
    sigortali_turu VARCHAR(80) NOT NULL,
    brans_kodu VARCHAR(20) NOT NULL,
    provizyon_tipi VARCHAR(40) NOT NULL,
    katilim_payi NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    sonuc_kodu VARCHAR(20) NOT NULL DEFAULT '0000',
    sonuc_mesaji VARCHAR(250) NOT NULL DEFAULT 'Onaylandı',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed additional 12 Turkish synthetic patients
INSERT INTO patient.patients(mrn,given_name,family_name,birth_date,sex,phone,blood_type,active)
VALUES
 ('HB-000104','Ahmet','Yılmaz',DATE '1962-11-18','M','0533 555 10 04','AB+',true),
 ('HB-000105','Zeynep','Çelik',DATE '1984-06-30','F','0544 555 10 05','A-',true),
 ('HB-000106','Caner','Öztürk',DATE '1997-03-14','M','0535 555 10 06','0-',true),
 ('HB-000107','Fatma','Arslan',DATE '1955-08-20','F','0546 555 10 07','B-',true),
 ('HB-000108','Burak','Koç',DATE '1979-12-03','M','0536 555 10 08','0+',true),
 ('HB-000109','Hatice','Doğan',DATE '1993-05-17','F','0552 555 10 09','A+',true),
 ('HB-000110','Mustafa','Şahin',DATE '1967-02-28','M','0538 555 10 10','AB-',true),
 ('HB-000111','Selin','Aydın',DATE '2007-09-12','F','0543 555 10 11','B+',true),
 ('HB-000112','Kerem','Polat',DATE '2018-07-04','M','0539 555 10 12','0+',true),
 ('HB-000113','Tolga','Erdem',DATE '1990-10-11','M','0553 555 10 13','0-',true),
 ('HB-000114','Gamze','Aksoy',DATE '1982-01-25','F','0534 555 10 14','AB+',true),
 ('HB-000115','Kemal','Eren',DATE '2004-11-09','M','0545 555 10 15','A+',true)
ON CONFLICT (mrn) DO NOTHING;

-- Seed additional drugs
INSERT INTO pharmacy.drugs(code,name,form,stock,min_stock,unit_price,active)
VALUES
 ('DEMO-0006','Metformin HCl 1000 mg','Tablet',180,40,2.10,true),
 ('DEMO-0007','İnsülin Glargin 100 U/mL SoloStar','Kartuş Kalem',35,10,115.00,true),
 ('DEMO-0008','Asetilsalisilik Asit 100 mg (Coraspin)','Enterik Tablet',310,60,1.10,true),
 ('DEMO-0009','Pantoprazol 40 mg İv Flakon','Liyofilize Flakon',52,20,18.50,true),
 ('DEMO-0010','Seftriakson 1g İv Flakon','Flakon',45,15,24.00,true),
 ('DEMO-0011','Deksametazon 8 mg/2 mL','Ampul',88,20,8.90,true),
 ('DEMO-0012','Enalapril 10 mg','Tablet',120,30,3.50,true)
ON CONFLICT (code) DO NOTHING;

-- Seed additional beds for ICU, Emergency, and Orthopedics
INSERT INTO adt.beds(ward,room,bed_no,status,current_encounter_id)
VALUES
 ('Yoğun Bakım','YB-1','YB-01','Available',NULL),
 ('Yoğun Bakım','YB-1','YB-02','Available',NULL),
 ('Acil Gözlem','ACIL-1','KIRMIZI-1','Available',NULL),
 ('Acil Gözlem','ACIL-1','SARI-1','Available',NULL),
 ('Acil Gözlem','ACIL-1','SARI-2','Available',NULL),
 ('Ortopedi','301','301-A','Available',NULL),
 ('Ortopedi','301','301-B','Available',NULL)
ON CONFLICT (ward,room,bed_no) DO NOTHING;

-- Seed MHRS appointments (tokenized patient_ref, no raw TCKN)
INSERT INTO integration.mhrs_appointments(id,patient_id,patient_ref,patient_name,polyclinic,doctor,appointment_time,status,note)
SELECT 'MHRS-2026-8001',id,'TR-REF-000101','Ayşe Demir','İç Hastalıkları (Dahiliye)','Uzm. Dr. Mehmet Kaya','09:00','Admitted','Diyabet ve rutin biyokimya takibi'
FROM patient.patients WHERE mrn='HB-000101'
ON CONFLICT (id) DO NOTHING;

INSERT INTO integration.mhrs_appointments(id,patient_id,patient_ref,patient_name,polyclinic,doctor,appointment_time,status,note)
SELECT 'MHRS-2026-8002',id,'TR-REF-000104','Ahmet Yılmaz','Göğüs Hastalıkları','Uzm. Dr. Canan Ak','09:30','Admitted','KOAH kontrol ve solunum testi'
FROM patient.patients WHERE mrn='HB-000104'
ON CONFLICT (id) DO NOTHING;

INSERT INTO integration.mhrs_appointments(id,patient_id,patient_ref,patient_name,polyclinic,doctor,appointment_time,status,note)
SELECT 'MHRS-2026-8003',id,'TR-REF-000105','Zeynep Çelik','Endokrinoloji','Doç. Dr. Serdar Tekin','10:00','Booked','Hashimoto tiroiditi hormon takibi'
FROM patient.patients WHERE mrn='HB-000105'
ON CONFLICT (id) DO NOTHING;

INSERT INTO integration.mhrs_appointments(id,patient_id,patient_ref,patient_name,polyclinic,doctor,appointment_time,status,note)
SELECT 'MHRS-2026-8004',id,'TR-REF-000106','Caner Öztürk','Ortopedi ve Travmatoloji','Op. Dr. Barış Güven','10:15','Booked','Sağ diz burkulması ve hareket kısıtlılığı'
FROM patient.patients WHERE mrn='HB-000106'
ON CONFLICT (id) DO NOTHING;

-- Seed ULAK 112 emergency dispatches (tokenized patient_ref, no raw TCKN)
INSERT INTO integration.ulak_cases(id,patient_id,patient_name,patient_ref,team_code,ambulance_plate,triage_level,triage_title,incident_summary,vitals,eta_minutes,status)
SELECT 'ULAK-112-901',id,'Mustafa Şahin (59E)','TR-REF-000110','34-KRT-112','34 AS 1124','RED','KIRMIZI ALAN (Resüsitasyon)','Evde ani başlayan sıkıştırıcı retrosternal göğüs ağrısı, soğuk terleme, Akut MI şüphesi.','{"bp":"85/55 mmHg","pulse":122,"spo2":89,"gcs":14}'::jsonb,0,'InHospital'
FROM patient.patients WHERE mrn='HB-000110'
ON CONFLICT (id) DO NOTHING;

INSERT INTO integration.ulak_cases(id,patient_id,patient_name,patient_ref,team_code,ambulance_plate,triage_level,triage_title,incident_summary,vitals,eta_minutes,status)
SELECT 'ULAK-112-902',id,'Tolga Erdem (36E)','TR-REF-000113','34-ACD-112','34 AS 1198','RED','KIRMIZI ALAN (Çoklu Travma)','D-100 karayolunda araç içi trafik kazası. Künt toraks travması.','{"bp":"90/60 mmHg","pulse":115,"spo2":91,"gcs":12}'::jsonb,0,'InHospital'
FROM patient.patients WHERE mrn='HB-000113'
ON CONFLICT (id) DO NOTHING;

INSERT INTO integration.ulak_cases(id,patient_id,patient_name,patient_ref,team_code,ambulance_plate,triage_level,triage_title,incident_summary,vitals,eta_minutes,status)
SELECT 'ULAK-112-903',id,'Fatma Arslan (71K)','TR-REF-000107','34-KAD-112','34 AS 1150','YELLOW','SARI ALAN (Acil Gözlem)','Islak zeminde düşme, sağ kalça deformitesi ve şiddetli ağrı.','{"bp":"135/85 mmHg","pulse":82,"spo2":96,"gcs":15}'::jsonb,6,'EnRoute'
FROM patient.patients WHERE mrn='HB-000107'
ON CONFLICT (id) DO NOTHING;

-- Seed outbox integration records (no raw TCKN in payload)
INSERT INTO integration.outbox(target,event_type,aggregate_type,aggregate_id,status,attempts,created_at,next_attempt_at,last_error,payload,idempotency_key)
VALUES
 ('USS / e-Nabız (Sağlık Bakanlığı)','Paket101_HastaKayit','patient','HB-000104','Sent',1,now()-interval '45 minutes',now(),NULL,'{"sys_takip_no":"SYS-2026-TR-8494","patient_ref":"TR-REF-000104","paket":101}','outbox:uss:HB-000104'),
 ('SGK MEDULA Gateway','GSS_ProvizyonSorgu','encounter','SEED-ENCOUNTER-101','Sent',1,now()-interval '40 minutes',now(),NULL,'{"medula_takip_no":"260305108492","sonuc_kodu":"0000","katilim_payi":15.00}','outbox:medula:260305108492'),
 ('MHRS Gateway (Bakanlık)','RandevuSenkronizasyon','mhrs','MHRS-2026-8001','Sent',1,now()-interval '35 minutes',now(),NULL,'{"randevu_id":"MHRS-2026-8001","durum":"Admitted"}','outbox:mhrs:MHRS-2026-8001'),
 ('ULAK 112 Acil Vaka Ağı','VakaKabulBildirimi','emergency','ULAK-112-901','Sent',1,now()-interval '30 minutes',now(),NULL,'{"protokol_no":"ULAK-112-901","triage":"RED","yatak":"KIRMIZI-1"}','outbox:ulak:ULAK-112-901'),
 ('ÜTS (Ürün Takip Sistemi)','KarekodTuketimBildirimi','uts','UTS-DRG-05','Sent',1,now()-interval '25 minutes',now(),NULL,'{"barcode":"8699525010050","ilac":"Enoksaparin Sodyum"}','outbox:uts:UTS-DRG-05')
ON CONFLICT (idempotency_key) DO NOTHING;
