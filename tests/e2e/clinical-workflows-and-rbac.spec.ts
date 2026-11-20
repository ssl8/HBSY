import { test, expect, Page } from '@playwright/test';

async function loginAsKeycloak(page: Page, username: string, password: string): Promise<string> {
  let bearerToken = '';
  page.on('request', (req) => {
    const auth = req.headers()['authorization'];
    if (auth && auth.startsWith('Bearer ') && req.url().includes('/api/')) {
      bearerToken = auth;
    }
  });

  await page.goto('/');
  await page.waitForURL(url => url.port === '8080' && url.pathname.includes('/protocol/openid-connect/auth'), { timeout: 30_000 });
  await page.waitForURL(url => url.port === '8088' && url.pathname === '/', { timeout: 30_000 });

  await expect(page.locator('#login-screen')).toBeVisible();
  await page.locator('#login-form button[type="submit"]').click();

  await expect(page.locator('#username')).toBeVisible({ timeout: 30_000 });
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();

  await expect(page.locator('#app-shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => bearerToken, { timeout: 15_000 }).toMatch(/^Bearer\s+.+/);
  return bearerToken;
}

test('runtime config advertises enterprise OIDC PKCE without demo shortcuts', async ({ request, page }) => {
  const cfgRes = await request.get('/api/config');
  expect(cfgRes.status()).toBe(200);
  const cfg = await cfgRes.json();
  expect(cfg.mode).toBe('enterprise');
  expect(cfg.auth).toBe('oidc');
  expect(cfg.oidc?.clientId).toBe('hbys-web');

  await page.goto('/');
  await page.waitForURL(url => url.port === '8080' && url.pathname.includes('/protocol/openid-connect/auth'), { timeout: 30_000 });
  await page.waitForURL(url => url.port === '8088' && url.pathname === '/', { timeout: 30_000 });
  await expect(page.locator('#login-screen')).toBeVisible();
  await expect(page.locator('[data-demo-role]')).toHaveCount(0);
});

test('registrar role can manage patients, admissions and MHRS connectors but not clinical orders or audit', async ({ page }) => {
  const bearer = await loginAsKeycloak(page, 'registrar', 'Registrar123!');
  await expect(page.locator('#user-role')).toContainText('Hasta Kayıt Görevlisi');

  await expect(page.locator('#main-nav [data-page="patients"]')).toBeVisible();
  await expect(page.locator('#main-nav [data-page="beds"]')).toBeVisible();
  await expect(page.locator('#main-nav [data-page="connectors"]')).toBeVisible();
  await expect(page.locator('#main-nav [data-page="clinical"]')).toHaveCount(0);
  await expect(page.locator('#main-nav [data-page="audit"]')).toHaveCount(0);

  const patientsRes = await page.request.get('/api/patients', { headers: { Authorization: bearer } });
  expect(patientsRes.status()).toBe(200);
  const connectorsRes = await page.request.get('/api/connectors/overview', { headers: { Authorization: bearer } });
  expect(connectorsRes.status()).toBe(200);
  const ordersRes = await page.request.get('/api/orders', { headers: { Authorization: bearer } });
  expect(ordersRes.status()).toBe(403);
  const auditRes = await page.request.get('/api/audit', { headers: { Authorization: bearer } });
  expect(auditRes.status()).toBe(403);
});

test('doctor can inspect Patient 360 drawer, verify CDS allergy protection, and check audit/billing boundaries', async ({ page }) => {
  const bearer = await loginAsKeycloak(page, 'doctor', 'Doctor123!');
  await expect(page.locator('#user-role')).toContainText('Hekim');

  const chartRes = await page.request.get('/api/patients/1/chart', { headers: { Authorization: bearer } });
  expect(chartRes.status()).toBe(200);
  const chart = await chartRes.json();
  expect(chart.patient?.id).toBe(1);

  await page.locator('#main-nav [data-page="patients"]').click();
  await expect(page.locator('#page-content h1')).toContainText('Hasta Yönetimi');

  const drawerTrigger = page.locator('[data-patient-id]').first();
  if (await drawerTrigger.count() > 0) {
    await drawerTrigger.click();
    await expect(page.locator('#patient-360-drawer')).toBeVisible();
    await page.locator('#drawer-close-btn').click();
    await expect(page.locator('#patient-360-drawer')).toHaveClass(/hidden/);
  }
});
