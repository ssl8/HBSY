# NOVA HBYS — Unified Stage 4 System Architecture

## Topology

```text
Browser (Modular ES App under web/, CSP script-src 'self')
   │
   ├── GET /api/config ──► Runtime discovery: Enterprise (OIDC PKCE + JWKS) vs Demo (Session Bearer)
   │
   ▼
Nginx Gateway (infra/nginx/nginx.conf :8088)   ──or──   Node.js Parity Runtime (server.js)
   │
   ├── /api/config, /api/me, /api/dashboard,
   │   /api/search, /api/patients, /api/encounters,
   │   /vitals, /notes                               ──► PatientSvc    (patient_svc DB role)
   ├── /api/encounters/{id}/charge-preview,
   │   /api/invoices                                 ──► BillingSvc    (billing_svc DB role)
   ├── /api/orders, /api/lab-results,
   │   /api/radiology-reports                        ──► ClinicalSvc   (clinical_svc DB role)
   ├── /api/beds, /api/admissions                    ──► AdtSvc        (adt_svc DB role)
   ├── /api/drugs, /api/prescriptions                ──► PharmacySvc   (pharmacy_svc DB role)
   ├── /api/vaccinations                             ──► PublicHealthSvc (publichealth_svc DB role)
   ├── /api/hl7/*, /api/lis/*                        ──► LisSvc        (lis_svc DB role)
   ├── /api/integrations                             ──► IntegrationSvc (integration_svc — no payload read!)
   ├── /api/connectors/*                             ──► ConnectorSvc  (connector_svc — tokenized patient_ref)
   ├── /api/audit                                    ──► AuditSvc      (audit_svc — append/verify chain)
   └── Background Polling (IntegrationWorker)        ──► integration.outbox (integration_worker DB role)
```

## Shared Domain Layer (`src/BuildingBlocks/`)
- `ServiceDefaults.cs`: `CamelCase` JSON policy, structured correlation IDs, read/write audit logging (`Db.TextOrDbNull`), Keycloak JWT Bearer validation.
- `Database/Db.cs`: Parameterized `Npgsql` command wrappers + `QueryCamelAsync` / `ToCamelRows`.
- `Security/RoleClaims.cs`: Canonical 9 roles (`admin`, `doctor`, `nurse`, `lab`, `radiology`, `pharmacist`, `billing`, `registrar`, `integration`).
- `Domain/OrderStateMachine.cs`: Authoritative order workflow & `MoneyRules` precision checks.
- `Domain/News2Calculator.cs`: Royal College of Physicians NEWS2 clinical risk scoring.
- `Domain/AllergyMatcher.cs`: Drug-allergy class matching for prescription CDS.
- `Domain/CriticalLabEvaluator.cs`: Panic lab threshold evaluation.
- `Hl7/Hl7OruParser.cs`: HL7 v2.5.1 ORU^R01 segment parser with `MSH-3`/`MSH-7`/`MSH-10`/`PID`/`OBR`/`OBX` extraction.
- `Audit/AuditPayloadVerifier.cs`: End-to-end SHA-256 chain verification.

## Data & Migration Architecture (`db/migrations/`)
Sequential migrations `V001` through `V016`:
- `V008`, `V013`, `V014`: Least-privilege per-service DB roles, outbox payload column isolation (`V013`), and patient PHI column isolation (`V014`).
- `V012`: Database trigger-enforced SHA-256 hash chain over `audit.events`.
- `V015`: Turkish national connector tables (`mhrs_appointments`, `ulak_cases`, `medula_provisions`) using tokenized `patient_ref` and nullable `patient_id` FK (no raw `tc_kimlik`).
- `V016`: `clinical.vitals`, `clinical.clinical_notes`, critical lab read-back fields, `adt.bed_transfers`, `pharmacy.stock_movements`, `billing.invoice_lines`, `integration.enabiz_packages`, `integration.its_verifications`, `connector_svc` & `integration_worker` DB role grants, and clean Stage 4 seed corrections.
