const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

function requestJson(baseUrl, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlPath, baseUrl);
    const reqHeaders = { ...headers };
    let payload = null;
    if (body !== null && body !== undefined) {
      payload = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
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
        try { json = JSON.parse(raw); } catch { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload, 'utf8');
    req.end();
  });
}

function spawnDemoServer() {
  return new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
      cwd: ROOT_DIR,
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { srv.kill(); } catch {}
        reject(new Error(`Tour server startup timeout. stdout=${stdoutBuf} stderr=${stderrBuf}`));
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
        reject(new Error(`Server exited early (${code}): ${stderrBuf}`));
      }
    });
  });
}

async function runTourTest() {
  console.log('\n[NOVA HBYS Stage 4 — 12-Step Enterprise Simulation Tour Verification]\n');

  const { srv, baseUrl } = await spawnDemoServer();
  const watchdog = setTimeout(() => {
    console.error('Tour watchdog exceeded 20s');
    try { srv.kill(); } catch {}
    process.exit(1);
  }, 20000);

  try {
    // Verify simulation control rejects unauthenticated calls
    const unauth = await requestJson(baseUrl, 'POST', '/api/simulation/start', {});
    assert.equal(unauth.status, 401, 'Unauthenticated simulation start MUST fail with 401');

    // Authenticate as admin session
    const loginRes = await requestJson(baseUrl, 'POST', '/api/auth/demo-login', { role: 'admin' });
    assert.equal(loginRes.status, 200);
    const authHeaders = { Authorization: `Bearer ${loginRes.json.token}` };

    const drugsBefore = await requestJson(baseUrl, 'GET', '/api/drugs', null, authHeaders);
    const levBefore = drugsBefore.json.find(d => d.id === 13).stock;
    assert.equal(levBefore, 140);

    const startRes = await requestJson(baseUrl, 'POST', '/api/simulation/start', {}, authHeaders);
    assert.equal(startRes.status, 200);
    assert.equal(startRes.json.success, true);
    assert.equal(startRes.json.status, 'running');
    assert.equal(startRes.json.running, true);
    assert.equal(startRes.json.locked, true);
    console.log('  [PASS] 0. Simulation started & UI lock engaged');

    for (let i = 0; i < 12; i++) {
      const stepRes = await requestJson(baseUrl, 'POST', '/api/simulation/step', { step: i }, authHeaders);
      assert.equal(stepRes.status, 200);
      assert.equal(stepRes.json.success, true);
      assert.equal(stepRes.json.step.step, i);
      assert.equal(stepRes.json.executedStep.step, i);
      assert.equal(stepRes.json.step.totalSteps, 12);
      assert.ok(stepRes.json.step.department && stepRes.json.step.title && stepRes.json.step.externalSystem);
      console.log(`  [PASS] Step ${String(i + 1).padStart(2, '0')}/12 [${stepRes.json.step.role.padEnd(11)}] -> ${stepRes.json.step.department}: ${stepRes.json.step.title}`);
    }

    // Verify clinical & connector state mutations performed by tour
    const drugsAfter = await requestJson(baseUrl, 'GET', '/api/drugs', null, authHeaders);
    const levAfter = drugsAfter.json.find(d => d.id === 13).stock;
    assert.equal(levAfter, 139, 'Step 7 should dispense 1 box of Levotiroksin (drugId 13)');

    const movs = await requestJson(baseUrl, 'GET', '/api/drugs/13/movements', null, authHeaders);
    assert.ok(movs.json.some(m => m.movementType === 'DISPENSE' && m.qtyDelta === -1));

    const uss = await requestJson(baseUrl, 'GET', '/api/connectors/enabiz/packages', null, authHeaders);
    assert.ok(uss.json.some(p => p.sysTakipNo === 'SYS-2026-TR-8520'));

    const mhrs = await requestJson(baseUrl, 'GET', '/api/connectors/mhrs/appointments', null, authHeaders);
    assert.equal(mhrs.json.find(a => a.id === 'MHRS-2026-8003').status, 'Admitted');

    const auditRes = await requestJson(baseUrl, 'GET', '/api/audit', null, authHeaders);
    assert.equal(auditRes.status, 200);
    assert.equal(auditRes.json.chainValid, true, 'Audit SHA-256 hash chain must remain valid across all 12 tour steps');
    assert.equal(auditRes.json.brokenEventId, null);

    // Pause, Stop & Reset checks
    const pauseRes = await requestJson(baseUrl, 'POST', '/api/simulation/pause', {}, authHeaders);
    assert.equal(pauseRes.status, 200);
    assert.equal(pauseRes.json.status, 'paused');
    assert.equal(pauseRes.json.paused, true);
    assert.equal(pauseRes.json.locked, false);

    const stopRes = await requestJson(baseUrl, 'POST', '/api/simulation/stop', {}, authHeaders);
    assert.equal(stopRes.status, 200);
    assert.equal(stopRes.json.status, 'stopped');
    assert.equal(stopRes.json.running, false);

    const resetRes = await requestJson(baseUrl, 'POST', '/api/demo/reset', {}, authHeaders);
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.json.success, true);

    const drugsReset = await requestJson(baseUrl, 'GET', '/api/drugs', null, authHeaders);
    assert.equal(drugsReset.json.find(d => d.id === 13).stock, 140, 'Demo reset must restore clean initial dataset');

    const auditReset = await requestJson(baseUrl, 'GET', '/api/audit', null, authHeaders);
    assert.equal(auditReset.json.chainValid, true);

    console.log('\n  [OK] 12-Step Simulation Tour & Audit Hash Chain Verification Passed!\n');
  } finally {
    clearTimeout(watchdog);
    try { srv.kill(); } catch {}
  }
}

runTourTest().catch((err) => {
  console.error('Tour test failed:', err);
  process.exit(1);
});
