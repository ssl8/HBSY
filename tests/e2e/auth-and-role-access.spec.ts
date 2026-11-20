import { test, expect, Page } from '@playwright/test';

async function signIn(page: Page, username: string, password: string): Promise<string> {
  let bearerToken = '';
  page.on('request', request => {
    const authorization = request.headers()['authorization'];
    if (authorization?.startsWith('Bearer ')) bearerToken = authorization;
  });

  await page.goto('/');
  // Wait for the anonymous prompt=none round-trip to finish before clicking login.
  await page.waitForURL(url => url.port === '8080' && url.pathname.includes('/protocol/openid-connect/auth'), { timeout: 30_000 });
  await page.waitForURL(url => url.port === '8088' && url.pathname === '/', { timeout: 30_000 });
  await expect(page.locator('#login-screen')).toBeVisible();
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#username')).toBeVisible();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await expect(page.locator('#app-shell')).toBeVisible();
  await expect.poll(() => bearerToken).toMatch(/^Bearer\s+.+/);
  return bearerToken;
}

async function apiGet(page: Page, path: string, bearerToken: string) {
  return page.request.get(`http://localhost:8088${path}`, {
    headers: { Authorization: bearerToken, Accept: 'application/json' }
  });
}

async function apiPost(page: Page, path: string, bearerToken: string, body: Record<string, unknown> = {}) {
  return page.request.post(`http://localhost:8088${path}`, {
    headers: { Authorization: bearerToken, Accept: 'application/json' },
    data: body
  });
}

test.describe('OIDC authentication and role isolation', () => {
  test('admin can access patient, audit and integration workspaces and APIs', async ({ page }) => {
    const token = await signIn(page, 'admin', 'Admin123!');
    await expect(page.locator('#user-role')).toContainText('Sistem Yöneticisi');

    const patientResponse = await apiGet(page, '/api/patients', token);
    expect(patientResponse.status()).toBe(200);

    await page.locator('#main-nav [data-page="patients"]').click();
    await expect(page.locator('#page-content h1')).toContainText('Hasta Yönetimi');
    await expect(page.locator('#page-content')).toContainText('HB-000101');

    await page.locator('#main-nav [data-page="audit"]').click();
    await expect(page.locator('#page-content h1')).toContainText('Denetim');

    await page.locator('#main-nav [data-page="integrations"]').click();
    await expect(page.locator('#page-content')).toContainText('Outbox / entegrasyon kayıtları');
  });

  test('laboratory role sees clinical workflow but is denied patient administration API', async ({ page }) => {
    const token = await signIn(page, 'lab', 'Lab123!');
    await expect(page.locator('#main-nav [data-page="clinical"]')).toBeVisible();
    await expect(page.locator('#main-nav [data-page="patients"]')).toHaveCount(0);
    const denied = await apiGet(page, '/api/patients', token);
    expect(denied.status()).toBe(403);

    await page.locator('#main-nav [data-page="clinical"]').click();
    await expect(page.locator('#page-content h1')).toContainText('Klinik');
    await expect(page.locator('#page-content')).toContainText('İstem listesi');
    const crossWorkflowWrite = await apiPost(page, '/api/radiology-reports', token, {
      order_id: 1, report_text: 'Yetkisiz test raporu metni', impression: 'Yetkisiz test'
    });
    expect(crossWorkflowWrite.status()).toBe(403);
  });

  test('billing role sees invoices but is denied clinical and patient APIs', async ({ page }) => {
    const token = await signIn(page, 'billing', 'Billing123!');
    await expect(page.locator('#main-nav [data-page="billing"]')).toBeVisible();
    await expect(page.locator('#main-nav [data-page="clinical"]')).toHaveCount(0);
    await expect(page.locator('#main-nav [data-page="patients"]')).toHaveCount(0);

    const patientDenied = await apiGet(page, '/api/patients', token);
    const clinicalDenied = await apiGet(page, '/api/orders', token);
    expect(patientDenied.status()).toBe(403);
    expect(clinicalDenied.status()).toBe(403);

    await page.locator('#main-nav [data-page="billing"]').click();
    await expect(page.locator('#page-content h1')).toContainText('Faturalama');
  });


  test('pharmacist can access pharmacy workflows but not patient administration', async ({ page }) => {
    const token = await signIn(page, 'pharmacy', 'Pharmacy123!');
    await expect(page.locator('#main-nav [data-page="pharmacy"]')).toBeVisible();
    await expect(page.locator('#main-nav [data-page="patients"]')).toHaveCount(0);
    expect((await apiGet(page, '/api/drugs', token)).status()).toBe(200);
    expect((await apiGet(page, '/api/prescriptions', token)).status()).toBe(200);
    expect((await apiGet(page, '/api/patients', token)).status()).toBe(403);
    expect((await apiGet(page, '/api/orders', token)).status()).toBe(403);
  });

  test('billing can use encounter picker and invoices without patient-master access', async ({ page }) => {
    const token = await signIn(page, 'billing', 'Billing123!');
    expect((await apiGet(page, '/api/encounters', token)).status()).toBe(200);
    expect((await apiGet(page, '/api/invoices', token)).status()).toBe(200);
    expect((await apiGet(page, '/api/patients', token)).status()).toBe(403);
    await page.locator('#main-nav [data-page="billing"]').click();
    await expect(page.locator('#page-content h1')).toContainText('Faturalama');
  });

  test('integration operator receives outbox metadata only, never payload', async ({ page }) => {
    const token = await signIn(page, 'integration', 'Integration123!');
    const response = await apiGet(page, '/api/integrations', token);
    expect(response.status()).toBe(200);
    const rows = await response.json();
    expect(Array.isArray(rows)).toBeTruthy();
    for (const row of rows) expect(row).not.toHaveProperty('payload');
    expect((await apiGet(page, '/api/patients', token)).status()).toBe(403);
  });

  test('nurse can access admission workflows but not clinical order queue', async ({ page }) => {
    const token = await signIn(page, 'nurse', 'Nurse123!');
    expect((await apiGet(page, '/api/patients', token)).status()).toBe(200);
    expect((await apiGet(page, '/api/beds', token)).status()).toBe(200);
    expect((await apiGet(page, '/api/orders', token)).status()).toBe(403);
  });

  test('radiology role reads reports but cannot write laboratory results', async ({ page }) => {
    const token = await signIn(page, 'radiology', 'Radiology123!');
    expect((await apiGet(page, '/api/radiology-reports', token)).status()).toBe(200);
    expect((await apiGet(page, '/api/lab-results', token)).status()).toBe(403);
    expect((await apiPost(page, '/api/lab-results', token, {
      order_id: 1, analyte_code: 'TEST', display: 'Test', value: '1', flag: 'N'
    })).status()).toBe(403);
  });

});
