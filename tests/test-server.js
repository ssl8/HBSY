const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createApp, ALL_ROLES, verifyAuditChain, computeNews2 } = require('../server');

const ROOT_DIR = path.resolve(__dirname, '..');

function requestJson(baseUrl, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlPath, baseUrl);
    const reqHeaders = { ...headers };
    let payload = null;
    if (body !== null && body !== undefined) {
      if (typeof body === 'string') {
        payload = body;
        if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'text/plain; charset=utf-8';
      } else {
        payload = JSON.stringify(body);
        if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }

    const req = http.request({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname + target.search,
      method,
      headers: reqHeaders
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* plain text response */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload, 'utf8');
    req.end();
  });
}

function spawnDemoServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
      cwd: ROOT_DIR,
      env: { ...process.env, PORT: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { srv.kill(); } catch {}
        reject(new Error(`Server startup timeout. stdout=${stdoutBuf} stderr=${stderrBuf}`));
      }
    }, 8000);

    srv.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const match = stdoutBuf.match(/Server running on http:\/\/localhost:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ srv, baseUrl: `http://127.0.0.1:${match[1]}` });
      }
    });

    srv.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    srv.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Server exited early with code ${code}. stderr=${stderrBuf}`));
      }
    });
  });
}

async function loginRole(baseUrl, role) {
  const res = await requestJson(baseUrl, 'POST', '/api/auth/demo-login', { role });
  assert.equal(res.status, 200, `Login for role '${role}' should succeed`);
  assert.ok(res.json?.token, `Login for '${role}' must return a bearer token`);
  assert.equal(res.json?.user?.role, role);
  return {
    token: res.json.token,
    user: res.json.user,
    headers: { Authorization: `Bearer ${res.json.token}` }
  };
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.stack || err.message}`);
      failed++;
    }
  }

  console.log('\n[NOVA HBYS Stage 4 API & Domain Parity Test Suite]\n');

  const { srv, baseUrl } = await spawnDemoServer();
  const globalWatchdog = setTimeout(() => {
    console.error('Global test watchdog exceeded 25s');
    try { srv.kill(); } catch {}
    process.exit(1);
  }, 25000);

  try {
    // Login sessions for all 9 canonical roles
    const sessions = {};
    for (const role of ALL_ROLES) {
      sessions[role] = await loginRole(baseUrl, role);
    }

    await test('Public GET /api/config, /api/health, and /api/auth/roles', async () => {
      const cfg = await requestJson(baseUrl, 'GET', '/api/config');
      assert.equal(cfg.status, 200);
      assert.equal(cfg.json.mode, 'demo');
      assert.equal(cfg.json.auth, 'demo');
      assert.equal(cfg.json.oidc, null);
      assert.deepEqual(cfg.json.features, {
        connectors: true,
        simulation: true,
        patient360: true,
        cdsAllergy: true,
        criticalAck: true,
        vitalsNews2: true,
        dicomViewer: true,
        hl7Sandbox: true
      });

      const hlth = await requestJson(baseUrl, 'GET', '/api/health');
      assert.equal(hlth.status, 200);
      assert.equal(hlth.json.status, 'ok');

      const roles = await requestJson(baseUrl, 'GET', '/api/auth/roles');
      assert.equal(roles.status, 200);
      assert.equal(roles.json.length, 9);
      assert.deepEqual(roles.json.map(r => r.role), ALL_ROLES);
    });

    await test('Unauthenticated /api/* requests return 401 & X-Demo-Role cannot spoof privileges', async () => {
      for (const route of [
        ['GET', '/api/me'],
        ['GET', '/api/patients'],
        ['GET', '/api/orders'],
        ['GET', '/api/audit'],
        ['GET', '/api/integrations'],
        ['GET', '/api/simulation/state'],
        ['POST', '/api/auth/switch-role']
      ]) {
        const res = await requestJson(baseUrl, route[0], route[1]);
        assert.equal(res.status, 401, `${route[0]} ${route[1]} must reject unauthenticated callers with 401`);
      }

      // Without HBYS_ALLOW_ROLE_HEADER=1, X-Demo-Role header is ignored unauthenticated...
      const spoofUnauth = await requestJson(baseUrl, 'GET', '/api/audit', null, { 'X-Demo-Role': 'admin' });
      assert.equal(spoofUnauth.status, 401);

      // ...and cannot elevate an active lower-role bearer session either
      const spoofEscalation = await requestJson(baseUrl, 'GET', '/api/audit', null, {
        ...sessions.lab.headers,
        'X-Demo-Role': 'admin'
      });
      assert.equal(spoofEscalation.status, 403);
    });

    await test('Per-session isolation, switch-role, and logout invalidation', async () => {
      const meDoc = await requestJson(baseUrl, 'GET', '/api/me', null, sessions.doctor.headers);
      const meLab = await requestJson(baseUrl, 'GET', '/api/me', null, sessions.lab.headers);
      assert.equal(meDoc.status, 200);
      assert.equal(meLab.status, 200);
      assert.equal(meDoc.json.user.role, 'doctor');
      assert.equal(meLab.json.user.role, 'lab');

      const tempSession = await loginRole(baseUrl, 'registrar');
      const sw = await requestJson(baseUrl, 'POST', '/api/auth/switch-role', { role: 'billing' }, tempSession.headers);
      assert.equal(sw.status, 200);
      assert.equal(sw.json.user.role, 'billing');
      assert.ok(sw.json.token && sw.json.token !== tempSession.token);

      const newHeaders = { Authorization: `Bearer ${sw.json.token}` };
      const lo = await requestJson(baseUrl, 'POST', '/api/auth/logout', {}, newHeaders);
      assert.equal(lo.status, 200);

      const afterLogout = await requestJson(baseUrl, 'GET', '/api/me', null, newHeaders);
      assert.equal(afterLogout.status, 401);
    });

    await test('Static assets emit CSP/nosniff headers, block directory traversal, and return 404 for missing .js', async () => {
      const indexRes = await requestJson(baseUrl, 'GET', '/index.html');
      assert.equal(indexRes.status, 200);
      assert.equal(indexRes.headers['x-content-type-options'], 'nosniff');
      assert.match(String(indexRes.headers['content-security-policy']), /default-src 'self'/);
      assert.match(String(indexRes.headers['content-security-policy']), /script-src 'self'/);
      assert.match(String(indexRes.headers['content-security-policy']), /frame-ancestors 'none'/);

      const appJs = await requestJson(baseUrl, 'GET', '/app.js');
      assert.equal(appJs.status, 200);
      assert.match(String(appJs.headers['content-type']), /^application\/javascript/);

      // Send raw paths without client-side URL dot-segment normalization
      async function rawGet(rawPath) {
        const t = new URL(baseUrl);
        return new Promise((resolve, reject) => {
          const r = http.request({ hostname: t.hostname, port: Number(t.port), path: rawPath, method: 'GET' }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', c => { raw += c; });
            res.on('end', () => resolve({ status: res.statusCode, raw }));
          });
          r.on('error', reject);
          r.end();
        });
      }

      const traversal1 = await rawGet('/..%2fpackage.json');
      assert.equal(traversal1.status, 403, `Traversal must be rejected with 403, got ${traversal1.status}`);

      const traversal2 = await rawGet('/%2e%2e/server.js');
      assert.equal(traversal2.status, 403, `Encoded traversal must be rejected with 403, got ${traversal2.status}`);

      const traversal3 = await rawGet('/../package.json');
      assert.equal(traversal3.status, 403, `Dot-dot traversal must be rejected with 403, got ${traversal3.status}`);

      const missingJs = await requestJson(baseUrl, 'GET', '/nonexistent-bundle-xyz.js');
      assert.equal(missingJs.status, 404);
      assert.doesNotMatch(missingJs.raw, /<!DOCTYPE html>/i);
    });

    await test('Full 9-role RBAC enforcement & stripped integration outbox payloads', async () => {
      // Patients: admin, doctor, nurse, registrar = 200; others = 403
      for (const role of ['admin', 'doctor', 'nurse', 'registrar']) {
        const res = await requestJson(baseUrl, 'GET', '/api/patients', null, sessions[role].headers);
        assert.equal(res.status, 200, `${role} should read /api/patients`);
      }
      for (const role of ['lab', 'radiology', 'pharmacist', 'billing', 'integration']) {
        const res = await requestJson(baseUrl, 'GET', '/api/patients', null, sessions[role].headers);
        assert.equal(res.status, 403, `${role} MUST receive 403 on /api/patients`);
      }

      // Encounters: billing allowed; lab/radiology/pharmacist/integration forbidden
      assert.equal((await requestJson(baseUrl, 'GET', '/api/encounters', null, sessions.billing.headers)).status, 200);
      for (const role of ['lab', 'radiology', 'pharmacist', 'integration']) {
        assert.equal((await requestJson(baseUrl, 'GET', '/api/encounters', null, sessions[role].headers)).status, 403);
      }

      // Orders: nurse, pharmacist, billing, registrar, integration forbidden on GET & POST
      for (const role of ['nurse', 'pharmacist', 'billing', 'registrar', 'integration']) {
        assert.equal((await requestJson(baseUrl, 'GET', '/api/orders', null, sessions[role].headers)).status, 403);
        assert.equal((await requestJson(baseUrl, 'POST', '/api/orders', { encounterId: 1 }, sessions[role].headers)).status, 403);
      }
      assert.equal((await requestJson(baseUrl, 'POST', '/api/orders', { encounterId: 1 }, sessions.lab.headers)).status, 403);

      // Audit: admin ONLY
      assert.equal((await requestJson(baseUrl, 'GET', '/api/audit', null, sessions.admin.headers)).status, 200);
      for (const role of ALL_ROLES.filter(r => r !== 'admin')) {
        assert.equal((await requestJson(baseUrl, 'GET', '/api/audit', null, sessions[role].headers)).status, 403, `${role} MUST get 403 on /api/audit`);
      }

      // Integrations: admin & integration ONLY, payload NEVER exposed
      for (const role of ['admin', 'integration']) {
        const res = await requestJson(baseUrl, 'GET', '/api/integrations', null, sessions[role].headers);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.json) && res.json.length > 0);
        for (const item of res.json) {
          assert.equal('payload' in item, false, 'GET /api/integrations must strip sensitive payload');
        }
      }
      for (const role of ['doctor', 'nurse', 'lab', 'radiology', 'pharmacist', 'billing', 'registrar']) {
        assert.equal((await requestJson(baseUrl, 'GET', '/api/integrations', null, sessions[role].headers)).status, 403);
      }

      // Cross-role clinical denials
      assert.equal((await requestJson(baseUrl, 'POST', '/api/radiology-reports', { orderId: 5 }, sessions.lab.headers)).status, 403);
      assert.equal((await requestJson(baseUrl, 'GET', '/api/lab-results', null, sessions.radiology.headers)).status, 403);
      assert.equal((await requestJson(baseUrl, 'POST', '/api/lab-results', { orderId: 8 }, sessions.doctor.headers)).status, 403);
      assert.equal((await requestJson(baseUrl, 'POST', '/api/invoices', { encounterId: 1 }, sessions.doctor.headers)).status, 403);
      assert.equal((await requestJson(baseUrl, 'POST', '/api/prescriptions', { encounterId: 1 }, sessions.pharmacist.headers)).status, 403);
      assert.equal((await requestJson(baseUrl, 'POST', '/api/prescriptions/1/dispense', {}, sessions.doctor.headers)).status, 403);
      assert.equal((await requestJson(baseUrl, 'POST', '/api/connectors/medula/provision', {}, sessions.lab.headers)).status, 403);
      assert.equal((await requestJson(baseUrl, 'POST', '/api/connectors/its/verify', {}, sessions.doctor.headers)).status, 403);
    });

    await test('Seed consistency (no Bed #4/#8 collision, Drug #13 Levotiroksin) + Patient 360 chart + Search', async () => {
      const bedsRes = await requestJson(baseUrl, 'GET', '/api/beds', null, sessions.nurse.headers);
      assert.equal(bedsRes.status, 200);
      const occupiedEncIds = bedsRes.json.filter(b => b.currentEncounterId !== null).map(b => b.currentEncounterId);
      assert.equal(new Set(occupiedEncIds).size, occupiedEncIds.length, 'Beds must not collide on currentEncounterId');
      const bed201A = bedsRes.json.find(b => b.bedNo === '201-A');
      const bedKirmizi = bedsRes.json.find(b => b.bedNo === 'KIRMIZI-1');
      assert.equal(bed201A.status, 'Available');
      assert.equal(bed201A.currentEncounterId, null);
      assert.equal(bedKirmizi.status, 'Occupied');
      assert.equal(bedKirmizi.currentEncounterId, 3);

      const drugsRes = await requestJson(baseUrl, 'GET', '/api/drugs', null, sessions.pharmacist.headers);
      assert.equal(drugsRes.status, 200);
      const drug13 = drugsRes.json.find(d => d.id === 13);
      assert.match(drug13.name, /Levotiroksin/);

      const chart = await requestJson(baseUrl, 'GET', '/api/patients/1/chart', null, sessions.doctor.headers);
      assert.equal(chart.status, 200);
      assert.equal(chart.json.patient.id, 1);
      assert.deepEqual(chart.json.allergies, ['Penisilin']);
      assert.ok(Array.isArray(chart.json.encounters) && chart.json.encounters.length >= 1);
      assert.ok(Array.isArray(chart.json.vitals));
      assert.ok(Array.isArray(chart.json.clinicalNotes));
      assert.ok(Array.isArray(chart.json.orders));
      assert.ok(Array.isArray(chart.json.labResults));
      assert.ok(Array.isArray(chart.json.radiologyReports));
      assert.ok(Array.isArray(chart.json.prescriptions));
      assert.equal(chart.json.activeAdmission, null);

      const searchDoc = await requestJson(baseUrl, 'GET', '/api/search?q=Demir', null, sessions.doctor.headers);
      assert.equal(searchDoc.status, 200);
      assert.ok(searchDoc.json.items.some(i => i.type === 'patient' && i.id === 1));

      const searchBil = await requestJson(baseUrl, 'GET', '/api/search?q=Demir', null, sessions.billing.headers);
      assert.equal(searchBil.status, 200);
      assert.equal(searchBil.json.items.some(i => i.type === 'patient'), false, 'Billing cannot discover patient entities via /api/search');
      assert.ok(searchBil.json.items.some(i => i.type === 'encounter'));

      const searchLab = await requestJson(baseUrl, 'GET', '/api/search?q=MR', null, sessions.lab.headers);
      assert.equal(searchLab.status, 200);
      assert.equal(searchLab.json.items.some(i => i.subtitle?.includes('RAD') || i.title?.includes('[RAD]')), false, 'Lab search must not leak RAD orders');
    });

    await test('OrderStateMachine transitions (LAB & RAD), 403 wrong role, 409 invalid jump', async () => {
      // LAB flow
      const created = await requestJson(baseUrl, 'POST', '/api/orders', {
        encounterId: 1,
        orderType: 'LAB',
        codeSystem: 'LOINC',
        code: '2823-3',
        description: 'Serum Potasyum (K)',
        priority: 'U'
      }, sessions.doctor.headers);
      assert.equal(created.status, 201);
      assert.equal(created.json.status, 'Created');
      const labOrderId = created.json.id;

      // Invalid transition Created -> Verified returns 409
      const badJump = await requestJson(baseUrl, 'PATCH', `/api/orders/${labOrderId}/status`, { status: 'Verified' }, sessions.admin.headers);
      assert.equal(badJump.status, 409);

      // Submit by doctor
      const submitted = await requestJson(baseUrl, 'PATCH', `/api/orders/${labOrderId}/status`, { status: 'Submitted' }, sessions.doctor.headers);
      assert.equal(submitted.status, 200);
      assert.equal(submitted.json.status, 'Submitted');

      // Doctor tries Submitted -> InProgress => 403
      const docStart = await requestJson(baseUrl, 'PATCH', `/api/orders/${labOrderId}/status`, { status: 'InProgress' }, sessions.doctor.headers);
      assert.equal(docStart.status, 403);

      // Radiology tries LAB Submitted -> InProgress => 403
      const radStartLab = await requestJson(baseUrl, 'PATCH', `/api/orders/${labOrderId}/status`, { status: 'InProgress' }, sessions.radiology.headers);
      assert.equal(radStartLab.status, 403);

      // Lab starts InProgress => 200
      const labStart = await requestJson(baseUrl, 'PATCH', `/api/orders/${labOrderId}/status`, { status: 'InProgress' }, sessions.lab.headers);
      assert.equal(labStart.status, 200);
      assert.equal(labStart.json.status, 'InProgress');

      // Lab tries InProgress -> Verified => 409
      const labSkip = await requestJson(baseUrl, 'PATCH', `/api/orders/${labOrderId}/status`, { status: 'Verified' }, sessions.lab.headers);
      assert.equal(labSkip.status, 409);

      // Lab results order => 200
      const labResulted = await requestJson(baseUrl, 'PATCH', `/api/orders/${labOrderId}/status`, { status: 'Resulted' }, sessions.lab.headers);
      assert.equal(labResulted.status, 200);
      assert.equal(labResulted.json.status, 'Resulted');

      // Lab tries Resulted -> Verified => 403 (doctor/admin only)
      const labVerify = await requestJson(baseUrl, 'PATCH', `/api/orders/${labOrderId}/status`, { status: 'Verified' }, sessions.lab.headers);
      assert.equal(labVerify.status, 403);

      // Doctor verifies => 200
      const docVerify = await requestJson(baseUrl, 'PATCH', `/api/orders/${labOrderId}/status`, { status: 'Verified' }, sessions.doctor.headers);
      assert.equal(docVerify.status, 200);
      assert.equal(docVerify.json.status, 'Verified');

      // RAD flow
      const radOrd = await requestJson(baseUrl, 'POST', '/api/orders', {
        encounterId: 1,
        orderType: 'RAD',
        codeSystem: 'SUT',
        code: '802.130',
        description: 'Kontrol Akciğer Grafisi',
        status: 'Submitted'
      }, sessions.doctor.headers);
      assert.equal(radOrd.status, 201);
      assert.equal(radOrd.json.status, 'Submitted');
      assert.equal((await requestJson(baseUrl, 'PATCH', `/api/orders/${radOrd.json.id}/status`, { status: 'InProgress' }, sessions.lab.headers)).status, 403);
      assert.equal((await requestJson(baseUrl, 'PATCH', `/api/orders/${radOrd.json.id}/status`, { status: 'InProgress' }, sessions.radiology.headers)).status, 200);

      // DRUG / PROCEDURE / CONSULT doctor execution parity (OrderStateMachine.cs)
      const drugOrd = await requestJson(baseUrl, 'POST', '/api/orders', {
        encounterId: 1,
        orderType: 'DRUG',
        codeSystem: 'ATC',
        code: 'N02BE01',
        description: 'IV Parasetamol Infüzyon İstem',
        status: 'Submitted'
      }, sessions.doctor.headers);
      assert.equal(drugOrd.status, 201);
      assert.equal((await requestJson(baseUrl, 'PATCH', `/api/orders/${drugOrd.json.id}/status`, { status: 'InProgress' }, sessions.lab.headers)).status, 403);
      assert.equal((await requestJson(baseUrl, 'PATCH', `/api/orders/${drugOrd.json.id}/status`, { status: 'InProgress' }, sessions.doctor.headers)).status, 200);
      assert.equal((await requestJson(baseUrl, 'PATCH', `/api/orders/${drugOrd.json.id}/status`, { status: 'Resulted' }, sessions.doctor.headers)).status, 200);
      assert.equal((await requestJson(baseUrl, 'PATCH', `/api/orders/${drugOrd.json.id}/status`, { status: 'Verified' }, sessions.doctor.headers)).status, 200);
    });

    await test('Nursing Vitals + RCP NEWS2 thresholds & SOAP Clinical Notes', async () => {
      // Pure function edge check
      const singleParam3 = computeNews2({ systolicBp: 120, diastolicBp: 80, heartRate: 72, respRate: 16, tempC: 36.8, spo2: 91, consciousness: 'A' });
      assert.equal(singleParam3.news2Score, 3);
      assert.equal(singleParam3.news2Risk, 'LOW_MEDIUM');

      const vLow = await requestJson(baseUrl, 'POST', '/api/encounters/1/vitals', {
        systolicBp: 120, diastolicBp: 80, heartRate: 72, respRate: 16, tempC: 36.8, spo2: 98, consciousness: 'A'
      }, sessions.nurse.headers);
      assert.equal(vLow.status, 201);
      assert.equal(vLow.json.news2Score, 0);
      assert.equal(vLow.json.news2Risk, 'LOW');

      const vHigh = await requestJson(baseUrl, 'POST', '/api/encounters/1/vitals', {
        systolicBp: 85, diastolicBp: 50, heartRate: 135, respRate: 28, tempC: 39.5, spo2: 88, consciousness: 'P'
      }, sessions.nurse.headers);
      assert.equal(vHigh.status, 201);
      assert.ok(vHigh.json.news2Score >= 7);
      assert.equal(vHigh.json.news2Risk, 'HIGH');

      const vitalsList = await requestJson(baseUrl, 'GET', '/api/encounters/1/vitals', null, sessions.doctor.headers);
      assert.equal(vitalsList.status, 200);
      assert.ok(vitalsList.json.length >= 2);

      const notePost = await requestJson(baseUrl, 'POST', '/api/encounters/1/notes', {
        noteType: 'SOAP',
        subjective: 'Hastada takip muayenesi.',
        objective: 'TA 120/80 mmHg.',
        assessment: 'Stabil diyabet.',
        plan: '3 ay sonra kontrol.'
      }, sessions.doctor.headers);
      assert.equal(notePost.status, 201);
      assert.equal(notePost.json.authorRole, 'doctor');

      const noteList = await requestJson(baseUrl, 'GET', '/api/encounters/1/notes', null, sessions.nurse.headers);
      assert.equal(noteList.status, 200);
      assert.ok(noteList.json.some(n => n.id === notePost.json.id));
    });

    await test('Critical Lab Auto-Flag + Physician Read-Back Acknowledge + Audit Event', async () => {
      const ordRes = await requestJson(baseUrl, 'POST', '/api/orders', {
        encounterId: 1,
        orderType: 'LAB',
        codeSystem: 'LOINC',
        code: '10839-9',
        description: 'hs-cTnI Acil',
        status: 'Submitted'
      }, sessions.doctor.headers);
      assert.equal(ordRes.status, 201);
      await requestJson(baseUrl, 'PATCH', `/api/orders/${ordRes.json.id}/status`, { status: 'InProgress' }, sessions.lab.headers);

      // Post normal result first (cannot acknowledge non-critical)
      const ordNorm = await requestJson(baseUrl, 'POST', '/api/orders', {
        encounterId: 1, orderType: 'LAB', code: '2160-0', description: 'Kreatinin', status: 'Submitted'
      }, sessions.doctor.headers);
      await requestJson(baseUrl, 'PATCH', `/api/orders/${ordNorm.json.id}/status`, { status: 'InProgress' }, sessions.lab.headers);
      const resNorm = await requestJson(baseUrl, 'POST', '/api/lab-results', {
        orderId: ordNorm.json.id, analyteCode: '2160-0', display: 'Kreatinin', value: '0.90', unit: 'mg/dL', referenceRange: '0.7-1.2', flag: 'N'
      }, sessions.lab.headers);
      assert.equal(resNorm.status, 201);
      assert.equal(resNorm.json.criticalFlag, false);
      assert.equal((await requestJson(baseUrl, 'POST', `/api/lab-results/${resNorm.json.id}/acknowledge`, { ackNote: 'Görüldü okundu' }, sessions.doctor.headers)).status, 409);

      // Post critical troponin result
      const resCrit = await requestJson(baseUrl, 'POST', '/api/lab-results', {
        orderId: ordRes.json.id, analyteCode: '10839-9', display: 'Kardiyak Troponin I', value: '0.88', unit: 'ng/mL', referenceRange: '0.00-0.04', flag: 'HH'
      }, sessions.lab.headers);
      assert.equal(resCrit.status, 201);
      assert.equal(resCrit.json.criticalFlag, true);

      // Lab role cannot acknowledge critical lab
      assert.equal((await requestJson(baseUrl, 'POST', `/api/lab-results/${resCrit.json.id}/acknowledge`, { ackNote: 'Read back' }, sessions.lab.headers)).status, 403);
      // Missing ackNote returns 400
      assert.equal((await requestJson(baseUrl, 'POST', `/api/lab-results/${resCrit.json.id}/acknowledge`, { ackNote: '' }, sessions.doctor.headers)).status, 400);

      // Doctor acknowledges critical read-back
      const ackOk = await requestJson(baseUrl, 'POST', `/api/lab-results/${resCrit.json.id}/acknowledge`, {
        communicatedWith: 'Uzm. Bio. Caner Öztürk',
        ackNote: 'Troponin 0.88 ng/mL hekime iletildi, EKG ve kardiyoloji istendi.'
      }, sessions.doctor.headers);
      assert.equal(ackOk.status, 200);
      assert.ok(ackOk.json.criticalAckBy);
      assert.ok(ackOk.json.criticalAckAt);
      assert.equal(ackOk.json.communicatedWith, 'Uzm. Bio. Caner Öztürk');

      const audit = await requestJson(baseUrl, 'GET', '/api/audit', null, sessions.admin.headers);
      assert.ok(audit.json.events.some(e => e.action === 'CRITICAL_LAB_ACKNOWLEDGED' && String(e.entityId) === String(resCrit.json.id)));
    });

    await test('Drug-Allergy CDS (409 conflict + override audit), Atomic Dispense & Idempotent Stock Receipt', async () => {
      // Patient #1 (Encounter #1) has Penisilin allergy; Drug #2 Amoksisilin-Klavulanat has allergyGroup Penicillin
      const conflictRx = await requestJson(baseUrl, 'POST', '/api/prescriptions', {
        encounterId: 1,
        items: [{ drugId: 2, dosage: '1000 mg', frequency: '2x1', durationDays: 7, quantity: 14 }]
      }, sessions.doctor.headers);
      assert.equal(conflictRx.status, 409);
      assert.equal(conflictRx.json.code, 'ALLERGY_CONFLICT');
      assert.equal(conflictRx.json.requiresOverrideReason, true);

      // Short overrideReason (< 5 chars) must still block with 409
      const shortOverride = await requestJson(baseUrl, 'POST', '/api/prescriptions', {
        encounterId: 1,
        overrideAllergy: true,
        overrideReason: 'ok',
        items: [{ drugId: 2, dosage: '1000 mg', frequency: '2x1', durationDays: 7, quantity: 14 }]
      }, sessions.doctor.headers);
      assert.equal(shortOverride.status, 409);

      // Valid override succeeds (201) & records ALLERGY_OVERRIDE audit
      const okOverride = await requestJson(baseUrl, 'POST', '/api/prescriptions', {
        encounterId: 1,
        overrideAllergy: true,
        overrideReason: 'Alternatif antibiyotik intoleransı nedeniyle yakın gözlem altında onaylandı.',
        items: [{ drugId: 2, dosage: '1000 mg', frequency: '2x1', durationDays: 7, quantity: 14 }]
      }, sessions.doctor.headers);
      assert.equal(okOverride.status, 201);
      assert.equal(okOverride.json.overrideAllergy, true);

      const auditAfterOverride = await requestJson(baseUrl, 'GET', '/api/audit', null, sessions.admin.headers);
      assert.ok(auditAfterOverride.json.events.some(e => e.action === 'ALLERGY_OVERRIDE' && String(e.entityId) === String(okOverride.json.id)));

      // Atomic stock dispense check: Item 1 (drugId:1, qty:2) fits stock 240, Item 2 (drugId:3, qty:999) exceeds stock 18
      const multiRx = await requestJson(baseUrl, 'POST', '/api/prescriptions', {
        encounterId: 1,
        items: [
          { drugId: 1, dosage: '500 mg', frequency: '3x1', durationDays: 3, quantity: 2 },
          { drugId: 3, dosage: '500 mL', frequency: '1x1', durationDays: 3, quantity: 999 }
        ]
      }, sessions.doctor.headers);
      assert.equal(multiRx.status, 201);

      const failDispense = await requestJson(baseUrl, 'POST', `/api/prescriptions/${multiRx.json.id}/dispense`, {}, sessions.pharmacist.headers);
      assert.equal(failDispense.status, 409);
      assert.equal(failDispense.json.code, 'INSUFFICIENT_STOCK');

      // Ensure drugId 1 stock remained completely untouched (240)
      const drugsCheck = await requestJson(baseUrl, 'GET', '/api/drugs', null, sessions.pharmacist.headers);
      assert.equal(drugsCheck.json.find(d => d.id === 1).stock, 240);

      // Valid single-item dispense on drugId 13 (Levotiroksin, initial stock 140)
      const rx13 = await requestJson(baseUrl, 'POST', '/api/prescriptions', {
        encounterId: 8,
        items: [{ drugId: 13, dosage: '100 mcg', frequency: '1x1', durationDays: 30, quantity: 2 }]
      }, sessions.doctor.headers);
      assert.equal(rx13.status, 201);

      const okDispense = await requestJson(baseUrl, 'POST', `/api/prescriptions/${rx13.json.id}/dispense`, {}, sessions.pharmacist.headers);
      assert.equal(okDispense.status, 200);
      assert.equal(okDispense.json.status, 'Dispensed');

      // Double dispense returns 409
      const dupDispense = await requestJson(baseUrl, 'POST', `/api/prescriptions/${rx13.json.id}/dispense`, {}, sessions.pharmacist.headers);
      assert.equal(dupDispense.status, 409);

      // Stock Receipt + Idempotency-Key
      const rcpt1 = await requestJson(baseUrl, 'POST', '/api/drugs/stock-receipt', {
        drugId: 13, quantity: 10, referenceNo: 'IRS-2026-9901'
      }, { ...sessions.pharmacist.headers, 'Idempotency-Key': 'KEY-RCPT-9901' });
      assert.equal(rcpt1.status, 200);
      assert.equal(rcpt1.json.deduplicated, false);
      assert.equal(rcpt1.json.stock, 148); // 140 - 2 + 10

      // Idempotent replay
      const rcpt2 = await requestJson(baseUrl, 'POST', '/api/drugs/stock-receipt', {
        drugId: 13, quantity: 10, referenceNo: 'IRS-2026-9901'
      }, { ...sessions.pharmacist.headers, 'Idempotency-Key': 'KEY-RCPT-9901' });
      assert.equal(rcpt2.status, 200);
      assert.equal(rcpt2.json.deduplicated, true);
      assert.equal(rcpt2.json.stock, 148);

      // Same Idempotency-Key with mismatched qty => 409
      const rcptMismatch = await requestJson(baseUrl, 'POST', '/api/drugs/stock-receipt', {
        drugId: 13, quantity: 99, referenceNo: 'IRS-2026-9902'
      }, { ...sessions.pharmacist.headers, 'Idempotency-Key': 'KEY-RCPT-9901' });
      assert.equal(rcptMismatch.status, 409);

      // Movements ledger shows -2 DISPENSE and +10 RECEIPT
      const movs = await requestJson(baseUrl, 'GET', '/api/drugs/13/movements', null, sessions.pharmacist.headers);
      assert.equal(movs.status, 200);
      assert.ok(movs.json.some(m => m.movementType === 'DISPENSE' && m.qtyDelta === -2));
      assert.ok(movs.json.some(m => m.movementType === 'RECEIPT' && m.qtyDelta === 10));
    });

    await test('Multi-line SUT Invoices, MoneyRules validation, Charge Preview & Pay', async () => {
      const preview = await requestJson(baseUrl, 'GET', '/api/encounters/1/charge-preview', null, sessions.billing.headers);
      assert.equal(preview.status, 200);
      assert.equal(preview.json.encounterId, 1);
      assert.ok(Array.isArray(preview.json.lines) && preview.json.lines.length >= 1);
      assert.ok(preview.json.totalAmount > 0);

      // Invalid money rules => 400
      for (const badLine of [
        { code: '520.010', description: 'Zero price', qty: 1, unitPrice: 0 },
        { code: '520.010', description: 'Negative price', qty: 1, unitPrice: -10 },
        { code: '520.010', description: 'Three decimals', qty: 1, unitPrice: 12.345 },
        { code: '520.010', description: 'Zero qty', qty: 0, unitPrice: 100 }
      ]) {
        const badRes = await requestJson(baseUrl, 'POST', '/api/invoices', {
          encounterId: 1, payer: 'SGK', lines: [badLine]
        }, sessions.billing.headers);
        assert.equal(badRes.status, 400, `Expected 400 for invalid money line: ${JSON.stringify(badLine)}`);
      }

      const invRes = await requestJson(baseUrl, 'POST', '/api/invoices', {
        encounterId: 1,
        payer: 'SGK',
        lines: [
          { code: '520.010', description: 'Uzman Muayene', qty: 1, unitPrice: 350.50 },
          { code: '701.210', description: 'Hormon Paneli', qty: 2, unitPrice: 125.25 }
        ]
      }, sessions.billing.headers);
      assert.equal(invRes.status, 201);
      assert.equal(invRes.json.totalAmount, 601.00);
      assert.equal(invRes.json.patientShare, 15.00);
      assert.equal(invRes.json.sgkShare, 586.00);

      const pay1 = await requestJson(baseUrl, 'POST', `/api/invoices/${invRes.json.id}/pay`, {}, sessions.billing.headers);
      assert.equal(pay1.status, 200);
      assert.equal(pay1.json.status, 'Paid');

      const pay2 = await requestJson(baseUrl, 'POST', `/api/invoices/${invRes.json.id}/pay`, {}, sessions.billing.headers);
      assert.equal(pay2.status, 409);
    });

    await test('ADT Admission, Bed Transfer + Transfer History, Discharge & Cleaning Complete', async () => {
      const adm = await requestJson(baseUrl, 'POST', '/api/admissions', {
        encounterId: 5, bedId: 4
      }, sessions.nurse.headers);
      assert.equal(adm.status, 201);
      assert.equal(adm.json.status, 'Admitted');
      const admId = adm.json.id;

      const transfer = await requestJson(baseUrl, 'POST', `/api/admissions/${admId}/transfer`, {
        newBedId: 5, reason: 'Kardiyoloji monitorizasyon devri'
      }, sessions.nurse.headers);
      assert.equal(transfer.status, 200);
      assert.equal(transfer.json.fromBedId, 4);
      assert.equal(transfer.json.toBedId, 5);
      assert.equal(transfer.json.oldBedStatus, 'Cleaning');

      const history = await requestJson(baseUrl, 'GET', `/api/admissions/${admId}/transfers`, null, sessions.nurse.headers);
      assert.equal(history.status, 200);
      assert.equal(history.json.length, 1);
      assert.equal(history.json[0].fromBedId, 4);
      assert.equal(history.json[0].toBedId, 5);

      const disc = await requestJson(baseUrl, 'POST', `/api/admissions/${admId}/discharge`, {}, sessions.doctor.headers);
      assert.equal(disc.status, 200);
      assert.equal(disc.json.status, 'Discharged');
      assert.equal(disc.json.bedStatus, 'Cleaning');

      const clean5 = await requestJson(baseUrl, 'POST', '/api/beds/5/cleaning-complete', {}, sessions.nurse.headers);
      assert.equal(clean5.status, 200);
      assert.equal(clean5.json.status, 'Available');
    });

    await test('HL7 v2 ORU^R01 Parser, MSH-10 Dedup, Mismatch Rejection & LIS Inbox', async () => {
      const badHl7 = await requestJson(baseUrl, 'POST', '/api/hl7/oru', 'MSH|^~\\&|COBAS\nPID|1||HB-000101', sessions.lab.headers);
      assert.equal(badHl7.status, 400);

      const oruMsg = [
        'MSH|^~\\&|COBAS_E411|LAB|HBYS|HOSP|20261116103000||ORU^R01|MSG-TEST-9001|P|2.5.1',
        'PID|1||HB-000101^^^HOSP^MR||Demir^Ayse||19880412|F',
        'OBR|1||1|718-7^Hemogram^LN',
        'OBX|1|NM|2823-3^Potasyum (K+)||6.8|mmol/L|3.5 - 5.1|HH|||F'
      ].join('\r');

      const hl7Ok = await requestJson(baseUrl, 'POST', '/api/hl7/oru', oruMsg, sessions.lab.headers);
      assert.equal(hl7Ok.status, 200);
      assert.equal(hl7Ok.json.deduplicated, false);
      assert.equal(hl7Ok.json.controlId, 'MSG-TEST-9001');
      assert.equal(hl7Ok.json.status, 'Processed');
      assert.match(hl7Ok.json.ack, /^MSH\|.*MSA\|AA\|MSG-TEST-9001/s);
      assert.equal(hl7Ok.json.results[0].criticalFlag, true);

      // Re-sending same MSH-10 deduplicates cleanly
      const hl7Dup = await requestJson(baseUrl, 'POST', '/api/hl7/oru', { rawMessage: oruMsg }, sessions.integration.headers);
      assert.equal(hl7Dup.status, 200);
      assert.equal(hl7Dup.json.deduplicated, true);
      assert.equal(hl7Dup.json.status, 'DuplicateIgnored');

      // Patient mismatch with existing RAD order returns AE ACK & Failed
      const mismatchOru = [
        'MSH|^~\\&|COBAS|LAB|HBYS|HOSP|20261116103500||ORU^R01|MSG-TEST-9002|P|2.5.1',
        'PID|1||HB-000101^^^HOSP^MR||Demir^Ayse',
        'OBR|1||5|804.100^BT^SUT',
        'OBX|1|NM|2823-3^K||4.1|mmol/L|3.5 - 5.1|N|||F'
      ].join('\n');
      const hl7Fail = await requestJson(baseUrl, 'POST', '/api/hl7/oru', { rawMessage: mismatchOru }, sessions.lab.headers);
      assert.equal(hl7Fail.status, 200);
      assert.equal(hl7Fail.json.status, 'Failed');
      assert.match(hl7Fail.json.ack, /MSA\|AE\|MSG-TEST-9002/);

      const inboxLab = await requestJson(baseUrl, 'GET', '/api/lis/inbox', null, sessions.lab.headers);
      assert.equal(inboxLab.status, 200);
      assert.ok(inboxLab.json.some(m => m.messageControlId === 'MSG-TEST-9001' && m.status === 'Processed'));
      assert.equal((await requestJson(baseUrl, 'GET', '/api/lis/inbox', null, sessions.doctor.headers)).status, 403);
    });

    await test('Connectors Hub endpoints & canonical patientName list parity (MHRS, ULAK 112, MEDULA, e-Nabız/USS, İTS/ÜTS)', async () => {
      const ov = await requestJson(baseUrl, 'GET', '/api/connectors/overview', null, sessions.integration.headers);
      assert.equal(ov.status, 200);
      assert.ok(ov.json.gateways.mhrs && ov.json.gateways.ulak && ov.json.gateways.medula && ov.json.gateways.uss && ov.json.gateways.its);
      assert.ok(ov.json.gateways.mhrs.protocol && ov.json.gateways.mhrs.latencyMs !== undefined);
      assert.ok(Array.isArray(ov.json.outbox));
      for (const ob of ov.json.outbox) assert.equal('payload' in ob, false);

      const mhrsSync = await requestJson(baseUrl, 'POST', '/api/connectors/mhrs/sync', {}, sessions.registrar.headers);
      assert.equal(mhrsSync.status, 200);
      assert.equal(mhrsSync.json.ok, true);

      const mhrsAdmit = await requestJson(baseUrl, 'POST', '/api/connectors/mhrs/admit', { appointmentId: 'MHRS-2026-8005' }, sessions.registrar.headers);
      assert.equal(mhrsAdmit.status, 200);
      assert.equal(mhrsAdmit.json.appointment.status, 'Admitted');
      assert.ok(mhrsAdmit.json.encounter.id);

      const ulakDispatch = await requestJson(baseUrl, 'POST', '/api/connectors/ulak/dispatch', {
        patientId: 11, patientName: 'Selin Aydın (19K)', priority: 'Red', location: 'Kadıköy 4 No\'lu İstasyon'
      }, sessions.nurse.headers);
      assert.equal(ulakDispatch.status, 201);
      assert.equal(ulakDispatch.json.status, 'EnRoute');
      assert.equal(ulakDispatch.json.priority, 'Red');
      assert.equal(ulakDispatch.json.triageLevel, 'RED');
      assert.equal(ulakDispatch.json.location, 'Kadıköy 4 No\'lu İstasyon');

      const ulakAdmit = await requestJson(baseUrl, 'POST', '/api/connectors/ulak/admit', {
        caseId: ulakDispatch.json.id
      }, sessions.nurse.headers);
      assert.equal(ulakAdmit.status, 200);
      assert.equal(ulakAdmit.json.case.status, 'InHospital');

      const medula = await requestJson(baseUrl, 'POST', '/api/connectors/medula/provision', {
        tckn: '28491028472', bransKodu: '1000', provizyonTipi: 'Normal'
      }, sessions.billing.headers);
      assert.equal(medula.status, 200);
      assert.equal(medula.json.sonucKodu, '0000');

      const uss = await requestJson(baseUrl, 'POST', '/api/connectors/uss/send', {
        packageType: 'Paket102_HizmetBildirimi', patientId: 1, encounterId: 1
      }, sessions.doctor.headers);
      assert.equal(uss.status, 200);
      assert.equal(uss.json.responseCode, 'SYS_0000');

      const its = await requestJson(baseUrl, 'POST', '/api/connectors/its/verify', {
        barcode: '8699525010135'
      }, sessions.pharmacist.headers);
      assert.equal(its.status, 200);
      assert.equal(its.json.verified, true);
      assert.equal(its.json.valid, true);
      assert.equal(its.json.itsCode, 'UTS-DRG-13');
      assert.equal(its.json.drugId, 13);
      assert.ok(its.json.serialNo && typeof its.json.stockQty === 'number');
      assert.match(its.json.productName, /Levotiroksin/);

      // Canonical patientName parity on list endpoints
      for (const ep of [
        ['GET', '/api/encounters', sessions.doctor.headers],
        ['GET', '/api/orders', sessions.doctor.headers],
        ['GET', '/api/lab-results', sessions.doctor.headers],
        ['GET', '/api/radiology-reports', sessions.radiology.headers],
        ['GET', '/api/prescriptions', sessions.pharmacist.headers],
        ['GET', '/api/admissions', sessions.nurse.headers],
        ['GET', '/api/invoices', sessions.billing.headers],
        ['GET', '/api/vaccinations', sessions.nurse.headers]
      ]) {
        const listRes = await requestJson(baseUrl, ep[0], ep[1], null, ep[2]);
        assert.equal(listRes.status, 200);
        assert.ok(listRes.json.length > 0 && listRes.json[0].patientName, `${ep[1]} rows must expose canonical patientName`);
      }
    });

    await test('Live SHA-256 Audit Hash Chain Verification + In-Process Tamper Detection', async () => {
      const auditLive = await requestJson(baseUrl, 'GET', '/api/audit', null, sessions.admin.headers);
      assert.equal(auditLive.status, 200);
      assert.equal(auditLive.json.chainValid, true);
      assert.equal(auditLive.json.brokenEventId, null);
      assert.ok(auditLive.json.verifiedCount >= 10);
      assert.match(auditLive.json.events[0].eventHash, /^[0-9a-f]{64}$/);

      // In-process createApp() tamper check
      const app = createApp({ port: 0 });
      await new Promise(r => app.server.listen(0, '127.0.0.1', r));
      const inProcUrl = `http://127.0.0.1:${app.server.address().port}`;
      try {
        const adm = await loginRole(inProcUrl, 'admin');
        await requestJson(inProcUrl, 'POST', '/api/encounters/1/vitals', {
          systolicBp: 120, diastolicBp: 80, heartRate: 75, respRate: 16, tempC: 36.6, spo2: 98, consciousness: 'A'
        }, adm.headers);

        const cleanCheck = await requestJson(inProcUrl, 'GET', '/api/audit', null, adm.headers);
        assert.equal(cleanCheck.json.chainValid, true);

        const dbRef = app.getDb();
        assert.ok(verifyAuditChain(dbRef.auditEvents).chainValid);
        const targetEvt = dbRef.auditEvents[1];
        targetEvt.action = 'TAMPERED_ACTION_BY_ATTACKER';

        const tamperedCheck = await requestJson(inProcUrl, 'GET', '/api/audit', null, adm.headers);
        assert.equal(tamperedCheck.status, 200);
        assert.equal(tamperedCheck.json.chainValid, false, 'Tampered audit entry MUST invalidate SHA-256 chain');
        assert.equal(tamperedCheck.json.brokenEventId, targetEvt.id);
      } finally {
        await new Promise(r => app.server.close(r));
      }
    });

    console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    clearTimeout(globalWatchdog);
    try { srv.kill(); } catch {}
  }
}

runTests().catch((err) => {
  console.error('Fatal test suite error:', err);
  process.exit(1);
});
