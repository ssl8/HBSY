# NOVA HBYS — Security Architecture & Production Go-Live Controls

## Defense-in-Depth Security Controls Implemented

1. **Identity & Authentication Dual-Mode (`web/js/auth.js`, Keycloak 26)**
   - Enterprise mode enforces Keycloak Authorization Code + PKCE (`S256`) with `prompt=none` silent SSO probe and WebCrypto `RS256` JWKS verification (`iss`, `aud`/`azp`, `exp`, `nonce`) before session acceptance.
   - Local Demo mode (`server.js`) uses per-session cryptographic Bearer tokens (`crypto.randomUUID()`), fails closed with `401` on unauthenticated `/api/*` requests, and keeps `X-Demo-Role` disabled unless explicitly opted in via `HBYS_ALLOW_ROLE_HEADER=1`.

2. **Browser Content Security Policy & XSS Prevention (`nginx.conf`, `server.js`, `web/`)**
   - `Content-Security-Policy`: `script-src 'self'` strictly enforced; zero inline scripts or inline DOM event attributes (`on*=`).
   - All server/user-derived strings pass through `esc()` or `.textContent` (including notifications and audit/clinical modals).

3. **9-Role Least-Privilege RBAC Matrix**
   - Enforced consistently in Nginx upstream `.NET` endpoints (`RequireRole`), `server.js`, and navigation rendering in `web/app.js`.
   - Restricted endpoints (`GET/POST /api/patients` blocked for ancillary/billing roles, `GET /api/orders` blocked for `nurse`/`billing`/`pharmacist`, `POST /api/radiology-reports` vs `/api/lab-results` cross-role isolation, `admin`-only `GET /api/audit`).

4. **PostgreSQL Column & Role Isolation (`V008`, `V013`, `V014`, `V015`, `V016`)**
   - Dedicated `LOGIN NOINHERIT` roles per microservice plus separate `connector_svc` and `integration_worker` roles.
   - `V013`: `integration_svc` has explicit column grants excluding `payload`, preventing sensitive HL7/e-Nabız/USS bodies from leaking to API operators (`integration_worker` dispatches outbox payloads cleanly in background).
   - `V014`: `patient_svc` and clinical schemas respect strict column-level grants separating operational care fields from identity columns.
   - `V015`/`V016`: Zero plaintext `tc_kimlik` in connector/outbox schemas (`patient_ref` masking enforced).
   - Verified automatically via [scripts/check-db-security.sh](../../scripts/check-db-security.sh).

5. **Tamper-Evident Audit Logging (`V012`, `AuditSvc`, `server.js`)**
   - Every clinical, financial, administrative, and security override action (`ALLERGY_OVERRIDE`, critical lab read-back, role changes, connectors) appends to the SHA-256 hash chain verified dynamically on `GET /api/audit`.

## Remaining Go-Live Prerequisites Outside Repository Scope
- Replace Keycloak realm credentials and sample secrets before staging/production.
- Configure external TLS termination / reverse proxy certificates and hospital Active Directory / e-Devlet / Sağlık.NET mTLS endpoints for live connector adapters (`HBYS_CONNECTOR_MODE=live`).
- Provision managed PostgreSQL automated encrypted backups and off-host WORM log shipping.
