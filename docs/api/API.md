# NOVA HBYS — API Reference

All endpoints require a valid Bearer JWT (Keycloak OIDC in Enterprise mode) or Bearer Demo Session token (Node.js Demo mode), **except** `GET /api/config`, `/api/health`, `/health/*`, and `/api/auth/demo-login`.

Both `.NET 10` microservices and `server.js` emit canonical **`camelCase` JSON** as specified in [UNIFIED-CONTRACT.md](../docs/architecture/UNIFIED-CONTRACT.md).

---

## Core & Discovery
- `GET /api/config` *(Public)* — Runtime capability discovery (`mode`, `auth`, `oidc`, `features`)
- `POST /api/auth/demo-login`, `POST /api/auth/switch-role`, `POST /api/auth/logout` *(Demo mode only)*
- `GET /api/me` — Active user claims and Turkish role display label (`#user-role`)
- `GET /api/dashboard` — Live role-filtered KPIs (`patients`, `openEncounters`, `ordersToday`, `criticalResults`, `occupiedBeds`, `availableBeds`, `pendingPrescriptions`, `pendingIntegrations`, `activeUlakCases`, `todayMhrsAppointments`, `recentEncounters`)
- `GET /api/search?q=` — Role-filtered quick search (`Ctrl/Cmd+K`)

## Patient, EMR & Vitals (`PatientSvc`)
- `GET /api/patients`, `POST /api/patients` (`admin, registrar, doctor, nurse` read; `admin, registrar, doctor` write)
- `GET /api/patients/{id}/chart` — Patient 360° EMR bundle (allergies, encounters, vitals, SOAP notes, orders, lab results, radiology reports, prescriptions, active admission)
- `GET /api/encounters`, `POST /api/encounters` (`billing` has read-only access to encounters)
- `GET /api/encounters/{id}/vitals`, `POST /api/encounters/{id}/vitals` — Vital signs + deterministic NEWS2 score (`A|V|P|U`)
- `GET /api/encounters/{id}/notes`, `POST /api/encounters/{id}/notes` — Structured notes (`SOAP`, `PROGRESS`, `TRIAGE`, `CONSULT`, `DISCHARGE`)

## Clinical Orders, Lab & Radiology (`ClinicalSvc`)
- `GET /api/orders`, `POST /api/orders` (`admin, doctor, lab, radiology` read; `admin, doctor` write)
- `PATCH /api/orders/{id}/status` — Enforced via `OrderStateMachine` (`LAB`, `RAD`, `PROCEDURE`, `CONSULT`, `DRUG`)
- `GET /api/lab-results`, `POST /api/lab-results` (`admin, doctor, lab` read; `admin, lab` write)
- `POST /api/lab-results/{id}/acknowledge` (`admin, doctor`) — Critical lab read-back acknowledgement (`communicatedWith`, `ackNote`)
- `GET /api/radiology-reports`, `POST /api/radiology-reports` (`admin, doctor, lab, radiology` read; `admin, radiology` write)

## ADT & Ward Management (`AdtSvc`)
- `GET /api/beds` (`admin, doctor, nurse, registrar`)
- `GET /api/admissions`, `POST /api/admissions`, `POST /api/admissions/{id}/discharge`
- `GET /api/admissions/{id}/transfers`, `POST /api/admissions/{id}/transfer` — Full ward bed transfer history (`newBedId` / `toBedId`, `reason`)
- `POST /api/beds/{id}/cleaning-complete` (`admin, nurse`)

## Pharmacy & CDS (`PharmacySvc`)
- `GET /api/drugs`, `GET /api/drugs/{id}/movements`
- `POST /api/drugs/stock-receipt` (alias `POST /api/drugs/{id}/stock-receipts`) — Requires `Idempotency-Key` / `reference` dedup
- `GET /api/prescriptions`, `POST /api/prescriptions` — Runs Drug–Allergy CDS (`409 ALLERGY_CONFLICT` unless `overrideAllergy: true` + `overrideReason` >= 5 chars, audited as `ALLERGY_OVERRIDE`)
- `POST /api/prescriptions/{id}/dispense` — Atomic stock validation & decrement (`409` on low stock or duplicate dispense)

## Billing (`BillingSvc`)
- `GET /api/encounters/{id}/charge-preview` (`admin, billing, registrar`) — Generates itemized SUT charge lines from bed days, orders, and dispensed Rx
- `GET /api/invoices`, `POST /api/invoices` — Multi-line SUT invoice lines or legacy `amount` validated by `MoneyRules` (`> 0`, max 2 decimals)

## Public Health, HL7 LIS, Integrations & Audit
- `GET /api/vaccinations`, `POST /api/vaccinations` (`PublicHealthSvc`)
- `POST /api/hl7/oru`, `GET /api/lis/inbox` (`LisSvc` — raw HL7 v2.5.1 ORU^R01 parsing + `MSH-10` deduplication)
- `GET /api/integrations`, `POST /api/integrations/{id}/retry` (`IntegrationSvc` — metadata-only without `payload`, `admin, integration` only)
- `GET /api/audit` (`AuditSvc` — `admin` only, verifies full SHA-256 hash chain and returns `{ chainValid, verifiedCount, brokenEventId, events }`)

## National External Connectors (`ConnectorSvc`)
- `GET /api/connectors/overview` (alias `/status`)
- `GET/POST /api/connectors/mhrs/appointments`, `POST /api/connectors/mhrs/admit`, `POST /api/connectors/mhrs/sync`
- `GET/POST /api/connectors/ulak/cases`, `POST /api/connectors/ulak/dispatch`, `POST /api/connectors/ulak/admit`
- `GET /api/connectors/medula/provisions`, `POST /api/connectors/medula/provision`
- `GET /api/connectors/enabiz/packages`, `POST /api/connectors/enabiz/send`, `POST /api/connectors/uss/send`
- `POST /api/connectors/its/verify` (alias `/uts/verify`)
