-- V016: Clinical Depth, Column-Level Security Hardening, Connector Persistence & Worker Role

-- 1. Defensive cleanup in case an older database already created plaintext tc_kimlik columns in integration schema.
DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['mhrs_appointments', 'ulak_cases', 'medula_provisions'] LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'integration' AND table_name = tbl AND column_name = 'tc_kimlik'
        ) THEN
            EXECUTE format('ALTER TABLE integration.%I ADD COLUMN IF NOT EXISTS patient_ref VARCHAR(40)', tbl);
            EXECUTE format(
                'UPDATE integration.%I SET patient_ref = COALESCE(NULLIF(patient_ref, ''''), ''TCKN-***'' || right(tc_kimlik, 4)) WHERE patient_ref IS NULL OR patient_ref = ''''',
                tbl
            );
            EXECUTE format('ALTER TABLE integration.%I ALTER COLUMN patient_ref SET NOT NULL', tbl);
            EXECUTE format('ALTER TABLE integration.%I DROP COLUMN tc_kimlik', tbl);
        END IF;
    END LOOP;
END $$;

ALTER TABLE integration.medula_provisions
    ADD COLUMN IF NOT EXISTS patient_id BIGINT REFERENCES patient.patients(id);

-- 2. Patient allergies & chronic conditions (protected by V014 column-level isolation).
ALTER TABLE patient.patients
    ADD COLUMN IF NOT EXISTS allergies TEXT,
    ADD COLUMN IF NOT EXISTS chronic_conditions TEXT;

UPDATE patient.patients SET allergies = 'Penisilin', chronic_conditions = 'Tip 2 Diyabet' WHERE mrn = 'HB-000101' AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Yok', chronic_conditions = 'Hipertansiyon, KAH' WHERE mrn = 'HB-000102' AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Aspirin', chronic_conditions = 'Astım' WHERE mrn = 'HB-000103' AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Yok', chronic_conditions = 'KOAH' WHERE mrn = 'HB-000104' AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Sulfa grubu', chronic_conditions = 'Hipotiroidi (Hashimoto)' WHERE mrn = 'HB-000105' AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Yok', chronic_conditions = 'Yok' WHERE mrn IN ('HB-000106','HB-000108','HB-000111','HB-000113','HB-000115') AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Yok', chronic_conditions = 'Osteoporoz' WHERE mrn = 'HB-000107' AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Yok', chronic_conditions = 'Gebelik 24. Hafta' WHERE mrn = 'HB-000109' AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Yok', chronic_conditions = 'KAH, Hiperlipidemi' WHERE mrn = 'HB-000110' AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Yok', chronic_conditions = 'Rutin Çocuk İzlem' WHERE mrn = 'HB-000112' AND allergies IS NULL;
UPDATE patient.patients SET allergies = 'Yok', chronic_conditions = 'Migren' WHERE mrn = 'HB-000114' AND allergies IS NULL;

-- 3. Pharmacy drug allergy metadata, barcodes, prescription override columns & stock movement ledger linkage.
ALTER TABLE pharmacy.drugs
    ADD COLUMN IF NOT EXISTS generic_name VARCHAR(128),
    ADD COLUMN IF NOT EXISTS allergy_group VARCHAR(64),
    ADD COLUMN IF NOT EXISTS barcode VARCHAR(32),
    ADD COLUMN IF NOT EXISTS uts_code VARCHAR(40);

UPDATE pharmacy.drugs SET generic_name = 'Parasetamol', allergy_group = 'Analgesic', barcode = '8699525010012', uts_code = 'UTS-DRG-01' WHERE code = 'DEMO-0001';
UPDATE pharmacy.drugs SET generic_name = 'Amoksisilin', allergy_group = 'Penicillin', barcode = '8699525010029', uts_code = 'UTS-DRG-02' WHERE code = 'DEMO-0002';
UPDATE pharmacy.drugs SET generic_name = 'Sodyum Klorür %0.9', allergy_group = NULL, barcode = '8699525010036', uts_code = 'UTS-DRG-03' WHERE code = 'DEMO-0003';
UPDATE pharmacy.drugs SET generic_name = 'Salbutamol', allergy_group = 'Beta-Agonist', barcode = '8699525010043', uts_code = 'UTS-DRG-04' WHERE code = 'DEMO-0004';
UPDATE pharmacy.drugs SET generic_name = 'Enoksaparin Sodyum', allergy_group = 'Heparin', barcode = '8699525010050', uts_code = 'UTS-DRG-05' WHERE code = 'DEMO-0005';
UPDATE pharmacy.drugs SET generic_name = 'Metformin HCl', allergy_group = 'Biguanide', barcode = '8699525010067', uts_code = 'UTS-DRG-06' WHERE code = 'DEMO-0006';
UPDATE pharmacy.drugs SET generic_name = 'İnsülin Glargin', allergy_group = 'Insulin', barcode = '8699525010074', uts_code = 'UTS-DRG-07' WHERE code = 'DEMO-0007';
UPDATE pharmacy.drugs SET generic_name = 'Asetilsalisilik Asit', allergy_group = 'NSAID', barcode = '8699525010081', uts_code = 'UTS-DRG-08' WHERE code = 'DEMO-0008';
UPDATE pharmacy.drugs SET generic_name = 'Pantoprazol', allergy_group = 'PPI', barcode = '8699525010098', uts_code = 'UTS-DRG-09' WHERE code = 'DEMO-0009';
UPDATE pharmacy.drugs SET generic_name = 'Seftriakson', allergy_group = 'Beta-Lactam', barcode = '8699525010104', uts_code = 'UTS-DRG-10' WHERE code = 'DEMO-0010';
UPDATE pharmacy.drugs SET generic_name = 'Deksametazon', allergy_group = 'Corticosteroid', barcode = '8699525010111', uts_code = 'UTS-DRG-11' WHERE code = 'DEMO-0011';
UPDATE pharmacy.drugs SET generic_name = 'Enalapril', allergy_group = 'ACE-Inhibitor', barcode = '8699525010128', uts_code = 'UTS-DRG-12' WHERE code = 'DEMO-0012';

ALTER TABLE pharmacy.prescriptions
    ADD COLUMN IF NOT EXISTS allergy_overridden BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS override_reason VARCHAR(500);

ALTER TABLE pharmacy.stock_movements
    ADD COLUMN IF NOT EXISTS prescription_id BIGINT REFERENCES pharmacy.prescriptions(id);

ALTER TABLE pharmacy.stock_movements
    DROP CONSTRAINT IF EXISTS ck_stock_movement_sign;
ALTER TABLE pharmacy.stock_movements
    ADD CONSTRAINT ck_stock_movement_sign
    CHECK ((upper(movement_type) = 'RECEIPT' AND quantity > 0)
        OR (upper(movement_type) = 'DISPENSE' AND quantity < 0)) NOT VALID;
ALTER TABLE pharmacy.stock_movements VALIDATE CONSTRAINT ck_stock_movement_sign;

-- 4. Clinical Vitals (NEWS2), SOAP Clinical Notes, Critical Lab Read-Back & Modality Metadata
CREATE TABLE IF NOT EXISTS clinical.vitals (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    encounter_id BIGINT NOT NULL REFERENCES patient.encounters(id),
    systolic_bp INTEGER NOT NULL CHECK (systolic_bp BETWEEN 30 AND 320),
    diastolic_bp INTEGER NOT NULL CHECK (diastolic_bp BETWEEN 20 AND 220),
    heart_rate INTEGER NOT NULL CHECK (heart_rate BETWEEN 15 AND 280),
    resp_rate INTEGER NOT NULL CHECK (resp_rate BETWEEN 2 AND 80),
    temp_c NUMERIC(4,1) NOT NULL CHECK (temp_c BETWEEN 25.0 AND 45.0),
    spo2 INTEGER NOT NULL CHECK (spo2 BETWEEN 30 AND 100),
    consciousness CHAR(1) NOT NULL DEFAULT 'A' CHECK (consciousness IN ('A','V','P','U')),
    news2_score INTEGER NOT NULL CHECK (news2_score BETWEEN 0 AND 20),
    news2_risk VARCHAR(20) NOT NULL CHECK (news2_risk IN ('LOW','LOW_MEDIUM','MEDIUM','HIGH')),
    recorded_by VARCHAR(120) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_vitals_encounter_time ON clinical.vitals(encounter_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS clinical.clinical_notes (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    encounter_id BIGINT NOT NULL REFERENCES patient.encounters(id),
    author VARCHAR(120) NOT NULL,
    note_type VARCHAR(40) NOT NULL DEFAULT 'SOAP' CHECK (note_type IN ('SOAP','PROGRESS','DISCHARGE','TRIAGE','CONSULT')),
    subjective VARCHAR(4000) NOT NULL,
    objective VARCHAR(4000) NOT NULL,
    assessment VARCHAR(4000) NOT NULL,
    plan VARCHAR(4000) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_clinical_notes_encounter_time ON clinical.clinical_notes(encounter_id, created_at DESC);

ALTER TABLE clinical.lab_results
    ADD COLUMN IF NOT EXISTS critical_flag BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS critical_ack_by VARCHAR(120),
    ADD COLUMN IF NOT EXISTS critical_ack_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS critical_ack_note VARCHAR(500);

UPDATE clinical.lab_results SET critical_flag = critical WHERE critical_flag IS DISTINCT FROM critical;

ALTER TABLE clinical.radiology_reports
    ADD COLUMN IF NOT EXISTS modality VARCHAR(16) NOT NULL DEFAULT 'CR' CHECK (modality IN ('CR','CT','MR','US')),
    ADD COLUMN IF NOT EXISTS dicom_series_uid VARCHAR(128);

CREATE INDEX IF NOT EXISTS ix_invoice_lines_invoice ON billing.invoice_lines(invoice_id);

-- 5. Connector & Outbox tables
CREATE TABLE IF NOT EXISTS integration.enabiz_packages (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    patient_id BIGINT REFERENCES patient.patients(id),
    encounter_id BIGINT REFERENCES patient.encounters(id),
    patient_ref VARCHAR(40) NOT NULL,
    paket_tipi INTEGER NOT NULL,
    package_type VARCHAR(80),
    sys_takip_no VARCHAR(60) NOT NULL UNIQUE,
    status VARCHAR(30) NOT NULL DEFAULT 'Sent',
    response_code VARCHAR(30) NOT NULL DEFAULT 'SYS_0000',
    response_msg VARCHAR(500) NOT NULL DEFAULT 'Paket e-Nabız sunucusuna iletildi',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE integration.enabiz_packages
    ADD COLUMN IF NOT EXISTS package_type VARCHAR(80);

CREATE TABLE IF NOT EXISTS integration.its_verifications (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    barcode VARCHAR(64) NOT NULL,
    drug_id BIGINT REFERENCES pharmacy.drugs(id),
    gtin VARCHAR(32),
    lot_no VARCHAR(60),
    serial_no VARCHAR(64),
    status VARCHAR(40) NOT NULL DEFAULT 'Valid',
    verified_by VARCHAR(120) NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE integration.outbox
    ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

GRANT SELECT (sent_at) ON integration.outbox TO integration_svc;

-- 6. Least-Privilege Grants (Respecting V013 outbox payload & V014 patient PHI column isolation)
GRANT SELECT, INSERT ON clinical.vitals, clinical.clinical_notes TO patient_svc;
GRANT USAGE, SELECT ON SEQUENCE clinical.vitals_id_seq, clinical.clinical_notes_id_seq TO patient_svc;
GRANT SELECT ON clinical.radiology_reports, adt.admissions, pharmacy.prescription_items TO patient_svc;
GRANT SELECT (id, code, name, generic_name, allergy_group, form, stock, min_stock, unit_price, barcode, uts_code, active)
    ON pharmacy.drugs TO patient_svc;

GRANT SELECT, INSERT, UPDATE ON clinical.vitals, clinical.clinical_notes TO clinical_svc;
GRANT USAGE, SELECT ON SEQUENCE clinical.vitals_id_seq, clinical.clinical_notes_id_seq TO clinical_svc;
GRANT SELECT (allergies, chronic_conditions) ON patient.patients TO clinical_svc;

GRANT SELECT (allergies) ON patient.patients TO pharmacy_svc;

GRANT USAGE ON SCHEMA clinical, pharmacy, adt TO billing_svc;
GRANT SELECT (id, encounter_id, order_type, code, description, status) ON clinical.orders TO billing_svc;
GRANT SELECT (id, encounter_id, status) ON pharmacy.prescriptions TO billing_svc;
GRANT SELECT (id, prescription_id, drug_id, quantity) ON pharmacy.prescription_items TO billing_svc;
GRANT SELECT (id, code, name, unit_price, active) ON pharmacy.drugs TO billing_svc;
GRANT SELECT (id, encounter_id, admitted_at, discharged_at, status) ON adt.admissions TO billing_svc;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'connector_svc') THEN
        GRANT USAGE ON SCHEMA patient, clinical, adt, pharmacy, integration, audit TO connector_svc;
        GRANT SELECT (id, mrn, given_name, family_name, blood_type, active) ON patient.patients TO connector_svc;
        GRANT SELECT (id, patient_id, encounter_type, status, opened_at) ON patient.encounters TO connector_svc;
        GRANT INSERT (patient_id, encounter_type, status, chief_complaint, opened_at, external_ref) ON patient.encounters TO connector_svc;
        GRANT USAGE, SELECT ON SEQUENCE patient.encounters_id_seq TO connector_svc;
        GRANT SELECT (id, ward, room, bed_no, status, current_encounter_id) ON adt.beds TO connector_svc;
        GRANT SELECT (id, code, name, generic_name, form, stock, barcode, uts_code, active) ON pharmacy.drugs TO connector_svc;
        GRANT SELECT, INSERT, UPDATE ON
            integration.mhrs_appointments,
            integration.ulak_cases,
            integration.medula_provisions,
            integration.enabiz_packages,
            integration.its_verifications TO connector_svc;
        GRANT USAGE, SELECT ON SEQUENCE
            integration.enabiz_packages_id_seq,
            integration.its_verifications_id_seq TO connector_svc;
        GRANT INSERT ON integration.outbox TO connector_svc;
        GRANT SELECT (id, idempotency_key, status) ON integration.outbox TO connector_svc;
        GRANT USAGE, SELECT ON SEQUENCE integration.outbox_id_seq TO connector_svc;
        GRANT SELECT (id, event_hash) ON audit.events TO connector_svc;
        GRANT INSERT (occurred_at, username, role, action, entity_type, entity_id, details_json,
                      previous_hash, event_hash, canonical_payload)
            ON audit.events TO connector_svc;
        GRANT USAGE, SELECT ON SEQUENCE audit.events_id_seq TO connector_svc;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'integration_worker') THEN
        GRANT USAGE ON SCHEMA integration, audit TO integration_worker;
        GRANT SELECT (id, target, event_type, aggregate_type, aggregate_id, status, attempts,
                      created_at, next_attempt_at, last_error, payload, idempotency_key, sent_at)
            ON integration.outbox TO integration_worker;
        GRANT UPDATE (status, attempts, next_attempt_at, last_error, sent_at)
            ON integration.outbox TO integration_worker;
        GRANT SELECT (id, event_hash) ON audit.events TO integration_worker;
        GRANT INSERT (occurred_at, username, role, action, entity_type, entity_id, details_json,
                      previous_hash, event_hash, canonical_payload)
            ON audit.events TO integration_worker;
        GRANT USAGE, SELECT ON SEQUENCE audit.events_id_seq TO integration_worker;
    END IF;
END $$;

-- 7. Rich Stage 4 Clinical Seed Data (no encounter double-assigned across beds)
INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
SELECT id,'Emergency','Admitted','Akut Anterior MI şüphesi, retrosternal baskı (ULAK 112 Kırmızı Alan)',now()-interval '45 minutes','SEED-ENCOUNTER-103'
FROM patient.patients WHERE mrn='HB-000110'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
SELECT id,'Emergency','Admitted','Trafik kazası, toraks travması (ULAK 112 Kırmızı Alan)',now()-interval '90 minutes','SEED-ENCOUNTER-104'
FROM patient.patients WHERE mrn='HB-000113'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
SELECT id,'Outpatient','Open','Sağ diz burkulması, hareket kısıtlılığı (MHRS randevulu)',now()-interval '30 minutes','SEED-ENCOUNTER-105'
FROM patient.patients WHERE mrn='HB-000106'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
SELECT id,'Outpatient','Open','KOAH alevlenme, dispne ve öksürük (MHRS randevulu)',now()-interval '60 minutes','SEED-ENCOUNTER-106'
FROM patient.patients WHERE mrn='HB-000104'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
SELECT id,'Emergency','Admitted','Şiddetli sağ alt kadran ağrısı, bulantı (ULAK 112 Sarı Alan)',now()-interval '40 minutes','SEED-ENCOUNTER-107'
FROM patient.patients WHERE mrn='HB-000108'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
SELECT id,'Outpatient','Open','Rutin tiroid paneli ve USG kontrolü',now()-interval '180 minutes','SEED-ENCOUNTER-108'
FROM patient.patients WHERE mrn='HB-000105'
ON CONFLICT (external_ref) DO NOTHING;

-- Assign one distinct bed per admitted encounter (never double-assign encounter 3)
UPDATE adt.beds b SET status='Occupied', current_encounter_id=e.id
FROM patient.encounters e
WHERE e.external_ref='SEED-ENCOUNTER-103' AND b.ward='Acil Gözlem' AND b.bed_no='KIRMIZI-1'
  AND b.status='Available' AND NOT EXISTS (SELECT 1 FROM adt.beds x WHERE x.current_encounter_id=e.id);

UPDATE adt.beds b SET status='Occupied', current_encounter_id=e.id
FROM patient.encounters e
WHERE e.external_ref='SEED-ENCOUNTER-104' AND b.ward='Yoğun Bakım' AND b.bed_no='YB-01'
  AND b.status='Available' AND NOT EXISTS (SELECT 1 FROM adt.beds x WHERE x.current_encounter_id=e.id);

UPDATE adt.beds b SET status='Occupied', current_encounter_id=e.id
FROM patient.encounters e
WHERE e.external_ref='SEED-ENCOUNTER-107' AND b.ward='Acil Gözlem' AND b.bed_no='SARI-1'
  AND b.status='Available' AND NOT EXISTS (SELECT 1 FROM adt.beds x WHERE x.current_encounter_id=e.id);

INSERT INTO adt.admissions(encounter_id,bed_id,admitted_at,status)
SELECT e.id,b.id,e.opened_at,'Admitted'
FROM patient.encounters e JOIN adt.beds b ON b.current_encounter_id=e.id
WHERE e.external_ref IN ('SEED-ENCOUNTER-103','SEED-ENCOUNTER-104','SEED-ENCOUNTER-107')
  AND NOT EXISTS (SELECT 1 FROM adt.admissions a WHERE a.encounter_id=e.id AND a.status='Admitted');

-- Seed orders across LAB, RAD, PROCEDURE, CONSULT
INSERT INTO clinical.orders(encounter_id,order_type,code_system,code,description,ordered_by,status,priority,created_at,updated_at,external_ref)
SELECT e.id,'LAB','LOINC','10839-9','Kardiyak Troponin I (hs-cTnI)','Dr. Ahmet Öz','Resulted','U',now()-interval '40 minutes',now()-interval '20 minutes','SEED-ORDER-003'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-103'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO clinical.orders(encounter_id,order_type,code_system,code,description,ordered_by,status,priority,created_at,updated_at,external_ref)
SELECT e.id,'PROCEDURE','SUT','704.220','12 Derivasyonlu EKG','Dr. Ahmet Öz','Submitted','U',now()-interval '38 minutes',now()-interval '38 minutes','SEED-ORDER-004'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-103'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO clinical.orders(encounter_id,order_type,code_system,code,description,ordered_by,status,priority,created_at,updated_at,external_ref)
SELECT e.id,'RAD','SUT','804.100','Toraks ve Beyin BT','Dr. Ahmet Öz','Resulted','U',now()-interval '80 minutes',now()-interval '30 minutes','SEED-ORDER-005'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-104'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO clinical.orders(encounter_id,order_type,code_system,code,description,ordered_by,status,priority,created_at,updated_at,external_ref)
SELECT e.id,'RAD','SUT','802.130','PA Akciğer Grafisi (Dijital Röntgen)','Dr. Canan Ak','Resulted','R',now()-interval '55 minutes',now()-interval '25 minutes','SEED-ORDER-006'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-106'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO clinical.orders(encounter_id,order_type,code_system,code,description,ordered_by,status,priority,created_at,updated_at,external_ref)
SELECT e.id,'RAD','SUT','804.500','Sağ Diz MR Görüntüleme','Op. Dr. Barış Güven','Resulted','R',now()-interval '25 minutes',now()-interval '10 minutes','SEED-ORDER-007'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-105'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO clinical.orders(encounter_id,order_type,code_system,code,description,ordered_by,status,priority,created_at,updated_at,external_ref)
SELECT e.id,'CONSULT','SUT','520.050','Kardiyoloji Acil Konsültasyonu','Dr. Ahmet Öz','Submitted','U',now()-interval '30 minutes',now()-interval '30 minutes','SEED-ORDER-008'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-103'
ON CONFLICT (external_ref) DO NOTHING;

-- Seed critical lab result & radiology reports (CR, CT, MR)
INSERT INTO clinical.lab_results(order_id,analyte_code,display,value,unit,reference_range,flag,critical,critical_flag,resulted_at)
SELECT o.id,'10839-9','Kardiyak Troponin I (hs-cTnI)','1.92','ng/mL','0.00 - 0.04','HH',true,true,now()-interval '20 minutes'
FROM clinical.orders o
WHERE o.external_ref='SEED-ORDER-003'
  AND NOT EXISTS (SELECT 1 FROM clinical.lab_results lr WHERE lr.order_id=o.id AND lr.analyte_code='10839-9');

INSERT INTO clinical.radiology_reports(order_id,report_text,impression,reported_by,reported_at,modality,dicom_series_uid)
SELECT o.id,'KLİNİK BİLGİ: KOAH alevlenme. BULGULAR: Trakea orta hatta, plevral effüzyon saptanmadı.','Bilateral aktif infiltrasyon izlenmedi.','Uzm. Dr. Burak Koç',now()-interval '25 minutes','CR','1.2.840.10008.5.1.4.1.1.1.20261105.1'
FROM clinical.orders o WHERE o.external_ref='SEED-ORDER-006'
ON CONFLICT (order_id) DO NOTHING;

INSERT INTO clinical.radiology_reports(order_id,report_text,impression,reported_by,reported_at,modality,dicom_series_uid)
SELECT o.id,'BEYİN VE TORAKS BT: İntrakranial kanama izlenmedi. Sol alt lobda hafif kontüzyon dansitesi mevcut.','Akut hemoraji yok, sol alt lob kontüzyon.','Uzm. Dr. Burak Koç',now()-interval '30 minutes','CT','1.2.840.10008.5.1.4.1.1.2.20261105.2'
FROM clinical.orders o WHERE o.external_ref='SEED-ORDER-005'
ON CONFLICT (order_id) DO NOTHING;

INSERT INTO clinical.radiology_reports(order_id,report_text,impression,reported_by,reported_at,modality,dicom_series_uid)
SELECT o.id,'SAĞ DİZ MR: Medial menisküs arka boynuzunda Grade 2B sinyal artışı.','Medial menisküs Grade 2B dejeneratif yırtık.','Uzm. Dr. Burak Koç',now()-interval '10 minutes','MR','1.2.840.10008.5.1.4.1.1.4.20261105.3'
FROM clinical.orders o WHERE o.external_ref='SEED-ORDER-007'
ON CONFLICT (order_id) DO NOTHING;

-- Seed initial vitals (NEWS2) & SOAP clinical notes
INSERT INTO clinical.vitals(encounter_id,systolic_bp,diastolic_bp,heart_rate,resp_rate,temp_c,spo2,consciousness,news2_score,news2_risk,recorded_by,recorded_at)
SELECT e.id,124,78,76,16,36.7,98,'A',0,'LOW','nurse',now()-interval '90 minutes'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-101'
  AND NOT EXISTS (SELECT 1 FROM clinical.vitals v WHERE v.encounter_id=e.id);

INSERT INTO clinical.vitals(encounter_id,systolic_bp,diastolic_bp,heart_rate,resp_rate,temp_c,spo2,consciousness,news2_score,news2_risk,recorded_by,recorded_at)
SELECT e.id,85,55,122,26,36.7,89,'A',11,'HIGH','nurse',now()-interval '35 minutes'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-103'
  AND NOT EXISTS (SELECT 1 FROM clinical.vitals v WHERE v.encounter_id=e.id);

INSERT INTO clinical.clinical_notes(encounter_id,author,note_type,subjective,objective,assessment,plan,created_at)
SELECT e.id,'doctor','SOAP',
       'Poliklinik diyabet kontrolü; son 2 haftada sabah glukoz değerleri hafif yüksek.',
       'TA: 124/78 mmHg, Nb: 76/dk, SpO2: %98. Genel durumu iyi, koopere.',
       'Tip 2 Diabetes Mellitus (E11.9), Penisilin alerjisi mevcut.',
       'Hemogram ve HbA1c takibi, oral antidiyabetik idame.',
       now()-interval '85 minutes'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-101'
  AND NOT EXISTS (SELECT 1 FROM clinical.clinical_notes n WHERE n.encounter_id=e.id);

INSERT INTO clinical.clinical_notes(encounter_id,author,note_type,subjective,objective,assessment,plan,created_at)
SELECT e.id,'doctor','TRIAGE',
       'Evde ani başlayan sıkıştırıcı retrosternal göğüs ağrısı ve soğuk terleme.',
       'TA: 85/55 mmHg, Nb: 122/dk, SpO2: %89, NEWS2: 11 (HIGH).',
       'Akut Anterior MI şüphesi (I21.0), kritik Troponin I yüksekliği.',
       'Kırmızı alan monitorizasyonu, seri EKG, acil kardiyoloji konsültasyonu.',
       now()-interval '30 minutes'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-103'
  AND NOT EXISTS (SELECT 1 FROM clinical.clinical_notes n WHERE n.encounter_id=e.id);

-- Seed MEDULA provisions & e-Nabiz packages (tokenized patient_ref, no raw TCKN)
INSERT INTO integration.medula_provisions(takip_no,patient_id,encounter_id,patient_ref,sigortali_turu,brans_kodu,provizyon_tipi,katilim_payi,sonuc_kodu,sonuc_mesaji)
SELECT '260305108492',e.patient_id,e.id,'TR-REF-000101','4A (SSK Aktif Çalışan)','1000','Normal Muayene',15.00,'0000','Hak sahipliği doğrulandı.'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-101'
ON CONFLICT (takip_no) DO NOTHING;

INSERT INTO integration.enabiz_packages(patient_id,encounter_id,patient_ref,paket_tipi,package_type,sys_takip_no,status,response_code,response_msg)
SELECT e.patient_id,e.id,'TR-REF-000101',101,'Paket101_HastaKayit','SYS-2026-TR-8491','Sent','SYS_0000','Hasta muayene paketi e-Nabız ile senkronize edildi.'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-101'
ON CONFLICT (sys_takip_no) DO NOTHING;

UPDATE integration.enabiz_packages
SET package_type = CASE paket_tipi
    WHEN 101 THEN 'Paket101_HastaKayit'
    WHEN 103 THEN 'Paket103_MuayeneBilgisi'
    WHEN 105 THEN 'Paket105_TetkikSonuc'
    WHEN 201 THEN 'Paket201_YatisBilgisi'
    WHEN 207 THEN 'Paket207_AsiBildirim'
    ELSE 'Paket' || paket_tipi || '_USS'
END
WHERE package_type IS NULL;
