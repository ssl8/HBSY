# NOVA HBYS — Unified Stage 4 Architecture & API Contract

This document is the single source of truth across `.NET 10` microservices, PostgreSQL 18 migrations (`V001`–`V016`), Nginx gateway (`infra/nginx/nginx.conf`), Node.js local demo parity server (`server.js`), browser UI (`web/`), and verification suites (`tests/`).

---

## 1. Runtime Modes & Configuration Discovery

Every client boot (`web/js/auth.js`) fetches **`GET /api/config`** (unauthenticated / `AllowAnonymous`) before deciding how to authenticate.

### Response Schema (`GET /api/config`)
```json
{
  "mode": "enterprise",
  "auth": "oidc",
  "oidc": {
    "issuer": "http://localhost:8080/realms/hbys",
    "clientId": "hbys-web",
    "redirectUri": "/"
  },
  "features": {
    "connectors": true,
    "simulation": false,
    "patient360": true,
    "cdsAllergy": true,
    "criticalAck": true,
    "vitalsNews2": true,
    "dicomViewer": true,
    "hl7Sandbox": true
  }
}
```
- **Enterprise Stack (`.NET + Nginx + Keycloak`)**: Served by `PatientSvc` (`location = /api/config` in `nginx.conf`). Defaults to `"mode": "enterprise"`, `"auth": "oidc"`, `"simulation": false` (overridable via `HBYS_ENABLE_SIMULATION=true`).
- **Local Demo Server (`node server.js`)**: Defaults to `"mode": "demo"`, `"auth": "demo"`, `"oidc": null`, `"simulation": true`.
- **OIDC Flow (`auth === "oidc"`)**:
  - `web/` runs Authorization Code + PKCE S256 against `{issuer}/protocol/openid-connect/auth` and token exchange against `{issuer}/protocol/openid-connect/token`.
  - On initial load without an active token, `web/` runs silent SSO check (`prompt=none`). If unauthenticated (`error=login_required`), URL params are cleaned and `#login-screen` is shown; clicking `#login-form button[type="submit"]` starts interactive Keycloak login.
  - Access/ID token signatures are verified client-side using WebCrypto (`RS256`) against `{issuer}/protocol/openid-connect/certs` (JWKS) with `iss`, `aud`/`azp`, `exp`, and `nonce` checks before accepting the session.
- **Demo Flow (`auth === "demo"`)**:
  - `POST /api/auth/demo-login` returns a session token (`x-demo-session`) plus active user profile. Every authenticated browser request sends `Authorization: Bearer <token>` (or `x-demo-session`), AND `server.js` resolves the caller's role from the **session map** (with optional `x-demo-role` only when in test/demo harness mode, never trusting arbitrary client body fields).

---

## 2. Canonical Role & RBAC Matrix (9 Roles)

Canonical role identifiers (`RoleClaims.cs` & `server.js` & `web/`):
`admin`, `doctor`, `nurse`, `lab`, `radiology`, `pharmacist`, `billing`, `registrar`, `integration`

Turkish Display Labels (`#user-role`):
- `admin`: `Sistem Yöneticisi`
- `doctor`: `Hekim`
- `nurse`: `Hemşire`
- `lab`: `Laboratuvar Teknisyeni`
- `radiology`: `Radyoloji Teknisyeni`
- `pharmacist`: `Eczacı`
- `billing`: `Faturalama Uzmanı`
- `registrar`: `Hasta Kayıt Görevlisi`
- `integration`: `Entegrasyon Operatörü`

### Endpoint & UI Access Matrix

> **Hard Invariants (Verified by Playwright E2E `auth-and-role-access.spec.ts` & Negative Security Tests):**
> - `/api/patients` MUST return `403` for `lab`, `billing`, `pharmacist`, `radiology`, `integration`.
> - `/api/orders` MUST return `403` for `nurse`, `billing`, `pharmacist`, `integration`.
> - `/api/lab-results` (`GET`, `POST`, `acknowledge`) MUST return `403` for `radiology`, `billing`, `nurse`, `registrar`, `pharmacist`, `integration`.
> - `/api/radiology-reports` (`GET`, `POST`) MUST return `403` for `lab` on `POST` (and `403` for `billing`, `nurse`, `registrar`, `pharmacist`, `integration`).
> - `/api/audit` (`GET`) MUST return `403` for every role except `admin`.
> - `/api/integrations` (`GET`) is allowed only for `admin`, `integration` and MUST NEVER include `payload` in list responses (`V013` column isolation).

| Resource / Action | `admin` | `doctor` | `nurse` | `lab` | `radiology` | `pharmacist` | `billing` | `registrar` | `integration` |
|---|---|---|---|---|---|---|---|---|---|
| `GET /api/config` | Public | Public | Public | Public | Public | Public | Public | Public | Public |
| `GET /api/me`, `GET /api/dashboard` | All | All | All | All | All | All | All | All | All |
| `GET /api/search?q=` (Ctrl+K) | Role-filtered | Role-filtered | Role-filtered | Role-filtered | Role-filtered | Role-filtered | Role-filtered | Role-filtered | Role-filtered |
| `GET /api/patients`, `GET /api/patients/{id}/chart` | R | R | R | 403 | 403 | 403 | 403 | R | 403 |
| `POST /api/patients` | W | W | 403 | 403 | 403 | 403 | 403 | W | 403 |
| `GET /api/encounters` | R | R | R | 403 | 403 | 403 | R | R | 403 |
| `POST /api/encounters` | W | W | W | 403 | 403 | 403 | 403 | W | 403 |
| `GET/POST /api/encounters/{id}/vitals` | RW | RW | RW | 403 | 403 | 403 | 403 | 403 | 403 |
| `GET/POST /api/encounters/{id}/notes` | RW | RW | RW | 403 | 403 | 403 | 403 | 403 | 403 |
| `GET /api/orders` | R | R | 403 | R | R | 403 | 403 | 403 | 403 |
| `POST /api/orders` | W | W | 403 | 403 | 403 | 403 | 403 | 403 | 403 |
| `PATCH /api/orders/{id}/status` | StateMachine | StateMachine | 403 | StateMachine | StateMachine | 403 | 403 | 403 | 403 |
| `GET /api/lab-results` | R | R | 403 | R | 403 | 403 | 403 | 403 | 403 |
| `POST /api/lab-results` | W | 403 | 403 | W | 403 | 403 | 403 | 403 | 403 |
| `POST /api/lab-results/{id}/acknowledge` | W | W | 403 | 403 | 403 | 403 | 403 | 403 | 403 |
| `GET /api/radiology-reports` | R | R | 403 | R | R | 403 | 403 | 403 | 403 |
| `POST /api/radiology-reports` | W | 403 | 403 | 403 | W | 403 | 403 | 403 | 403 |
| `GET /api/beds`, `GET /api/admissions/{id}/transfers` | R | R | R | 403 | 403 | 403 | 403 | R | 403 |
| `POST /api/admissions`, `/discharge`, `/transfer` | W | W | W | 403 | 403 | 403 | 403 | W | 403 |
| `GET /api/drugs`, `GET /api/drugs/{id}/movements` | R | R | R | 403 | 403 | R | 403 | 403 | 403 |
| `POST /api/drugs/stock-receipt` | W | 403 | 403 | 403 | 403 | W | 403 | 403 | 403 |
| `GET /api/prescriptions` | R | R | R | 403 | 403 | R | 403 | 403 | 403 |
| `POST /api/prescriptions` | W | W | 403 | 403 | 403 | 403 | 403 | 403 | 403 |
| `POST /api/prescriptions/{id}/dispense` | W | 403 | 403 | 403 | 403 | W | 403 | 403 | 403 |
| `GET /api/invoices`, `GET /api/encounters/{id}/charge-preview` | R | 403 | 403 | 403 | 403 | 403 | R | R | 403 |
| `POST /api/invoices` | W | 403 | 403 | 403 | 403 | 403 | W | 403 | 403 |
| `GET /api/vaccinations` | R | R | R | 403 | 403 | 403 | 403 | R | 403 |
| `POST /api/vaccinations` | W | W | W | 403 | 403 | 403 | 403 | 403 | 403 |
| `POST /api/hl7/oru`, `GET /api/lis/inbox` | RW | 403 | 403 | RW | 403 | 403 | 403 | 403 | RW |
| `GET /api/integrations`, `POST /api/integrations/{id}/retry` | RW | 403 | 403 | 403 | 403 | 403 | 403 | 403 | RW |
| `GET /api/audit` | R | 403 | 403 | 403 | 403 | 403 | 403 | 403 | 403 |
| `GET /api/connectors/overview` | R | R | R | 403 | 403 | R | R | R | R |
| `/api/connectors/mhrs/*` | RW | RW | 403 | 403 | 403 | 403 | 403 | RW | RW |
| `/api/connectors/ulak/*` | RW | RW | RW | 403 | 403 | 403 | 403 | 403 | RW |
| `/api/connectors/medula/*` | RW | 403 | 403 | 403 | 403 | 403 | RW | RW | RW |
| `/api/connectors/enabiz/*`, `/api/connectors/uss/*` | RW | RW | 403 | 403 | 403 | 403 | 403 | 403 | RW |
| `/api/connectors/its/verify` | W | 403 | 403 | 403 | 403 | W | 403 | 403 | W |

---

## 3. Domain State Machines & Validation Parity

### 3.1 `OrderStateMachine` (`.NET` = `server.js`)
Allowed order types: `LAB`, `RAD`, `PROCEDURE`, `CONSULT`.
Allowed transitions (`CanTransition(from, to, role, orderType)`):
- `LAB`:
  - `Submitted -> InProgress` (`lab`, `admin`)
  - `Submitted -> Cancelled` (`doctor`, `admin`)
  - `InProgress -> Resulted` (`lab`, `admin`)
  - `InProgress -> Cancelled` (`doctor`, `admin`)
  - `Resulted -> Verified` (`doctor`, `admin`)
- `RAD`:
  - `Submitted -> InProgress` (`radiology`, `admin`)
  - `Submitted -> Cancelled` (`doctor`, `admin`)
  - `InProgress -> Resulted` (`radiology`, `admin`)
  - `InProgress -> Cancelled` (`doctor`, `admin`)
  - `Resulted -> Verified` (`doctor`, `admin`)
- `PROCEDURE` / `CONSULT`:
  - `Submitted -> InProgress` (`doctor`, `admin`)
  - `Submitted -> Cancelled` (`doctor`, `admin`)
  - `InProgress -> Resulted` (`doctor`, `admin`)
  - `InProgress -> Cancelled` (`doctor`, `admin`)
  - `Resulted -> Verified` (`doctor`, `admin`)

Invalid transitions MUST return `409 Conflict` or `403 Forbidden` (if role is wrong for a valid target state, `403`; if transition itself is invalid, `409`).

### 3.2 `MoneyRules` (`.NET` = `server.js`)
- Amounts must be finite, `> 0`, and have at most 2 decimal places (`Math.Round(val, 2) == val`).
- Multi-line invoices (`lines: [{ code, description, qty, unitPrice }]`): each line `qty > 0`, `unitPrice > 0` (<= 2 decimals), `totalAmount = sum(qty * unitPrice)` rounded to 2 decimals. Legacy single `{ encounterId, amount }` remains accepted if `lines` is omitted.
- Currency: `TRY` default.

### 3.3 Drug–Allergy CDS (`POST /api/prescriptions`)
- Accepts `{ encounterId, patientId?, items: [{ drugId, dosage, frequency, durationDays }], overrideAllergy?, overrideReason? }`.
- Also accepts legacy `{ encounterId, items: ... }`.
- Server resolves patient's known `allergies` (comma-separated tokens e.g. `"Penisilin, Aspirin"` or structured).
- Each requested `drugId` resolves to `drugs` metadata (`genericName`, `name`, `allergyGroup` e.g. `Penicillin`, `NSAID`, `Beta-Lactam`).
- If any prescribed drug matches the patient's recorded allergy group/name:
  - Unless `overrideAllergy === true` AND `overrideReason` is non-empty (>= 5 chars), return **`409 Conflict`**:
    ```json
    {
      "error": "Alerji çakışması tespit edildi",
      "code": "ALLERGY_CONFLICT",
      "allergy": "Penisilin",
      "drugName": "Amoksisilin+Klavulanat 1000mg",
      "requiresOverrideReason": true
    }
    ```
  - If overridden with valid reason, persist prescription, record `overrideReason`, and write an explicit `ALLERGY_OVERRIDE` audit event.
- Dispensing (`POST /api/prescriptions/{id}/dispense`):
  - Idempotent/guarded: if status is already `Dispensed` or `Cancelled`, return `409`.
  - Atomically checks all items have `stock_qty >= qty`; if insufficient stock on any item, return `409` without partially decrementing other items.
  - Records negative `-qty` entries in `pharmacy.stock_movements` (`movement_type = 'DISPENSE'`).

### 3.4 Critical Lab Value Read-Back (`POST /api/lab-results/{id}/acknowledge`)
- Critical thresholds (`H` high, `L` low, or critical markers like Troponin > 0.04, K+ >= 6.0 / <= 2.8, Glucose >= 400 / <= 45, Hgb <= 7.0) set `critical_flag = true`.
- `POST /api/lab-results/{id}/acknowledge` accepts `{ communicatedWith, ackNote }` (role: `doctor` or `admin`), sets `critical_ack_by`, `critical_ack_at`, `critical_ack_note`, returns updated result, and writes a critical read-back `audit.events` record.

### 3.5 Nursing Vitals & NEWS2 (`POST /api/encounters/{id}/vitals`)
- Payload: `{ systolicBp, diastolicBp, heartRate, respRate, tempC, spo2, consciousness }` (`consciousness`: `'A'|'V'|'P'|'U'`).
- Server computes `news2Score` (0–20) and `news2Risk` (`LOW`, `LOW_MEDIUM`, `MEDIUM`, `HIGH`) deterministically using Royal College of Physicians NEWS2 thresholds:
  - Resp Rate: <=8 (3), 9-11 (1), 12-20 (0), 21-24 (2), >=25 (3)
  - SpO2: <=91 (3), 92-93 (2), 94-95 (1), >=96 (0)
  - Temp: <=35.0 (3), 35.1-36.0 (1), 36.1-38.0 (0), 38.1-39.0 (1), >=39.1 (2)
  - Systolic BP: <=90 (3), 91-100 (2), 101-110 (1), 111-219 (0), >=220 (3)
  - Heart Rate: <=40 (3), 41-50 (1), 51-90 (0), 91-110 (1), 111-130 (2), >=131 (3)
  - Consciousness: `'A'` (0), `'V'|'P'|'U'` (3)

### 3.6 HL7 v2.5.1 ORU^R01 Parser & `MSH-10` Deduplication (`POST /api/hl7/oru`)
- Accepts either `text/plain` raw HL7 or `{ rawMessage }` JSON.
- Requires valid `MSH`, `PID`, `OBR`, and at least one `OBX`. Rejects malformed payloads with `400`.
- Extracts `MSH-3` (sending app), `MSH-7` (timestamp), `MSH-10` (control ID, required non-empty), `PID-3` (patient identifier/MRN), `OBR-4` (panel), and each `OBX` (`code^text`, value, unit, refRange, abnormalFlag).
- Deduplication: checks existing `MSH-10` (`message_control_id`). If already seen, returns `200 OK` with `{ deduplicated: true, controlId, status: "DuplicateIgnored" }` and does NOT insert duplicate `lis_inbox` or `lab_results` rows.

### 3.7 Audit Hash Chain (`GET /api/audit`)
- Every audit entry computes real SHA-256 chain hash over previous hash (`0000...` genesis) + canonical pipe-delimited event fields.
- `GET /api/audit` verifies the entire chain in order (`.NET` via PostgreSQL `pgcrypto` + `AuditPayloadVerifier`; `server.js` via `node:crypto` SHA-256 recomputation) and returns `{ chainValid, verifiedCount, brokenEventId, events }`.

---

## 4. UI Selectors & Navigation Contract (`web/`)

Must satisfy all Playwright E2E and unit assertions:
- `#login-screen` (visible when unauthenticated) and `#login-form button[type="submit"]`
- `#app-shell` (visible once authenticated)
- `#user-role` (contains Turkish role display name, e.g. `Sistem Yöneticisi`)
- `#main-nav` buttons use `data-page`:
  - `dashboard`, `patients`, `clinical`, `beds`, `pharmacy`, `billing`, `vaccinations`, `connectors`, `integrations`, `audit`
- Role visibility of `[data-page]`:
  - `patients` MUST NOT render in `#main-nav` for `lab`, `billing`, `pharmacist`, `radiology`, `integration`.
  - `clinical` MUST NOT render in `#main-nav` for `billing`, `nurse`, `pharmacist`, `registrar`, `integration`.
  - `integrations` MUST render for `admin`, `integration` and `#page-content` must include `'Outbox / entegrasyon kayıtları'`.
  - `audit` MUST render ONLY for `admin` and `#page-content h1` must contain `'Denetim'`.
  - `patients` `#page-content h1` must contain `'Hasta Yönetimi'`.
  - `clinical` `#page-content h1` must contain `'Klinik'` and page must contain `'İstem listesi'`.
  - `billing` `#page-content h1` must contain `'Faturalama'`.
- CSP constraint: `<meta>` / HTTP header enforces `script-src 'self'` — **NO** inline `<script>`, **NO** inline `onclick="..."` / `onchange="..."` attributes; use `addEventListener` and modular ES modules (`<script type="module" src="app.js"></script>`).
- XSS safety: ALL API/user-supplied strings MUST be escaped via `esc()` or assigned via `textContent` (including `toast()`, banners, modals, tables, and drawers).
