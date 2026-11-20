-- Synthetic-only seed records. No TCKN or real patient information is stored.
INSERT INTO patient.patients(mrn,given_name,family_name,birth_date,sex,phone,blood_type,active)
VALUES
 ('HB-000101','Ayşe','Demir',DATE '1988-04-12','F','0500 000 01 01','A+',true),
 ('HB-000102','Mehmet','Kaya',DATE '1974-09-23','M','0500 000 01 02','0+',true),
 ('HB-000103','Elif','Yıldız',DATE '2001-01-05','F',NULL,'B+',true)
ON CONFLICT (mrn) DO NOTHING;

INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
SELECT id,'Outpatient','Open','Kontrol muayenesi (sentetik veri)',now()-interval '2 hours','SEED-ENCOUNTER-101'
FROM patient.patients WHERE mrn='HB-000101'
ON CONFLICT (external_ref) DO NOTHING;
INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
SELECT id,'Inpatient','Admitted','Gözlem (sentetik veri)',now()-interval '1 day','SEED-ENCOUNTER-102'
FROM patient.patients WHERE mrn='HB-000102'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO adt.beds(ward,room,bed_no,status,current_encounter_id)
VALUES
 ('Dahiliye','101','101-A','Available',NULL),
 ('Dahiliye','101','101-B','Available',NULL),
 ('Dahiliye','102','102-A','Available',NULL),
 ('Kardiyoloji','201','201-A','Available',NULL),
 ('Kardiyoloji','201','201-B','Available',NULL),
 ('Gözlem','301','301-A','Available',NULL)
ON CONFLICT (ward,room,bed_no) DO NOTHING;

UPDATE adt.beds b SET status='Occupied',current_encounter_id=e.id
FROM patient.encounters e
WHERE e.external_ref='SEED-ENCOUNTER-102' AND b.ward='Dahiliye' AND b.room='101' AND b.bed_no='101-A'
  AND b.status='Available';
INSERT INTO adt.admissions(encounter_id,bed_id,admitted_at,status)
SELECT e.id,b.id,e.opened_at,'Admitted'
FROM patient.encounters e JOIN adt.beds b ON b.current_encounter_id=e.id
WHERE e.external_ref='SEED-ENCOUNTER-102'
  AND NOT EXISTS (SELECT 1 FROM adt.admissions a WHERE a.encounter_id=e.id AND a.status='Admitted');

INSERT INTO pharmacy.drugs(code,name,form,stock,min_stock,unit_price,active)
VALUES
 ('DEMO-0001','Parasetamol 500 mg','Tablet',240,50,1.25,true),
 ('DEMO-0002','Amoksisilin 500 mg','Kapsül',86,30,4.80,true),
 ('DEMO-0003','Serum fizyolojik 0.9%','Flakon',18,20,7.50,true),
 ('DEMO-0004','Salbutamol 2.5 mg','Nebül',65,15,3.20,true),
 ('DEMO-0005','Enoksaparin 4000 IU','Enjektör',12,15,42.00,true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO clinical.orders(encounter_id,order_type,code_system,code,description,ordered_by,status,priority,created_at,updated_at,external_ref)
SELECT e.id,'LAB','LOINC','718-7','Hemoglobin (demo)','Dr. Demo','InProgress','R',now()-interval '30 minutes',now()-interval '30 minutes','SEED-ORDER-001'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-101'
ON CONFLICT (external_ref) DO NOTHING;

INSERT INTO pharmacy.prescriptions(encounter_id,prescribed_by,status,created_at)
SELECT e.id,'Dr. Demo','Pending',now()-interval '20 minutes'
FROM patient.encounters e
WHERE e.external_ref='SEED-ENCOUNTER-101'
  AND NOT EXISTS (SELECT 1 FROM pharmacy.prescriptions p WHERE p.encounter_id=e.id AND p.prescribed_by='Dr. Demo');
INSERT INTO pharmacy.prescription_items(prescription_id,drug_id,dosage,frequency,duration_days,quantity,dispensed_qty)
SELECT p.id,d.id,'500 mg','Günde 2 kez',5,10,0
FROM pharmacy.prescriptions p CROSS JOIN pharmacy.drugs d
WHERE p.prescribed_by='Dr. Demo' AND d.code='DEMO-0001'
  AND NOT EXISTS (SELECT 1 FROM pharmacy.prescription_items i WHERE i.prescription_id=p.id);

INSERT INTO billing.invoices(encounter_id,invoice_no,payer,status,total,created_at)
SELECT e.id,'DEMO-INV-2026-001','SGK','Issued',850.00,now()-interval '15 minutes'
FROM patient.encounters e WHERE e.external_ref='SEED-ENCOUNTER-101'
ON CONFLICT (invoice_no) DO NOTHING;
INSERT INTO billing.invoice_lines(invoice_id,code,description,quantity,unit_price,line_total)
SELECT id,'DEMO-MUAYENE','Muayene hizmeti (sentetik)',1,850.00,850.00
FROM billing.invoices WHERE invoice_no='DEMO-INV-2026-001'
  AND NOT EXISTS (SELECT 1 FROM billing.invoice_lines l WHERE l.invoice_id=billing.invoices.id);

INSERT INTO publichealth.vaccinations(patient_id,vaccine_code,vaccine_name,dose_no,lot_no,administered_at,administered_by,external_event_id)
SELECT id,'DEMO-VAX-01','Aşı kaydı (sentetik)',1,'LOT-DEMO-26',now()-interval '7 days','Hemşire Demo','SEED-VAX-001'
FROM patient.patients WHERE mrn='HB-000103'
ON CONFLICT (external_event_id) DO NOTHING;

INSERT INTO integration.outbox(target,event_type,aggregate_type,aggregate_id,status,attempts,created_at,next_attempt_at,last_error,payload,idempotency_key)
VALUES
 ('USS / e-Nabız (simülasyon)','PatientRegistered','patient','HB-000101','Pending',0,now()-interval '10 minutes',now(), 'Canlı bağlantı yapılandırılmadı.', '{"mrn":"HB-000101","synthetic":true}', 'seed:patient:HB-000101'),
 ('MEDULA (simülasyon)','InvoiceIssued','invoice','DEMO-INV-2026-001','Failed',1,now()-interval '8 minutes',now(), 'Resmi WSDL ve test hesabı bekleniyor.', '{"invoice_no":"DEMO-INV-2026-001","synthetic":true}', 'seed:invoice:DEMO-INV-2026-001')
ON CONFLICT (idempotency_key) DO NOTHING;
