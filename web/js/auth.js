/**
 * Dual-mode authentication manager:
 *  - Enterprise OIDC: Authorization Code + PKCE (S256), prompt=none silent SSO check,
 *    and client-side RS256 JWKS signature + claim verification via WebCrypto.
 *  - Local Demo: Session-token auth via POST /api/auth/demo-login and /api/auth/switch-role.
 */

import { api, registerAuthHooks } from './api.js';
import { $, esc } from './dom.js';
import { DEMO_USERS, ROLE_LABELS, state } from './state.js';

const OIDC_TX_KEY = 'hbys_oidc_tx';
const OIDC_SESSION_KEY = 'hbys_oidc_session';
const OIDC_SILENT_KEY = 'hbys_oidc_silent_done';
const DEMO_SESSION_KEY = 'hbys_demo_session';

const jwksCache = new Map();
let refreshPromise = null;
let onSessionLostCallback = null;

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function decodeJwt(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('Geçersiz JWT biçimi.');
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  const signatureBytes = base64UrlDecode(parts[2]);
  return {
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signatureBytes
  };
}

async function fetchJwks(jwksUrl, forceRefresh = false) {
  const cached = jwksCache.get(jwksUrl);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < 300_000) {
    return cached.keys;
  }
  const resp = await fetch(jwksUrl, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`JWKS anahtarları alınamadı (${resp.status}).`);
  const data = await resp.json();
  const keys = Array.isArray(data.keys) ? data.keys : [];
  jwksCache.set(jwksUrl, { keys, fetchedAt: Date.now() });
  return keys;
}

async function findVerificationKey(jwksUrl, kid) {
  let keys = await fetchJwks(jwksUrl, false);
  let jwk = keys.find(k => (!kid || k.kid === kid) && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  if (!jwk) {
    keys = await fetchJwks(jwksUrl, true);
    jwk = keys.find(k => (!kid || k.kid === kid) && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  }
  if (!jwk) throw new Error('Token imzası için eşleşen JWKS RSA anahtarı bulunamadı.');
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

async function verifyJwtRs256(jwt, issuer, opts = {}) {
  const { header, payload, signingInput, signatureBytes } = decodeJwt(jwt);
  if (header.alg !== 'RS256') {
    throw new Error(`Desteklenmeyen JWT algoritması: ${header.alg || 'yok'}`);
  }
  const jwksUrl = opts.jwksUri || `${issuer}/protocol/openid-connect/certs`;
  const cryptoKey = await findVerificationKey(jwksUrl, header.kid);
  const validSig = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signatureBytes,
    new TextEncoder().encode(signingInput)
  );
  if (!validSig) {
    throw new Error('OIDC token RS256 imzası doğrulanamadı.');
  }

  const normalizedIssuer = issuer.replace(/\/+$/, '');
  const tokenIssuer = String(payload.iss || '').replace(/\/+$/, '');
  if (tokenIssuer !== normalizedIssuer) {
    throw new Error(`Token issuer uyuşmuyor (${tokenIssuer}).`);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec - 60) {
    throw new Error('OIDC oturum süresi dolmuş.');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) {
    throw new Error('OIDC token henüz geçerli değil.');
  }

  const audList = Array.isArray(payload.aud)
    ? payload.aud
    : payload.aud
      ? [payload.aud]
      : [];
  if (opts.allowedAudiences?.length) {
    const audOk = opts.allowedAudiences.some(a => audList.includes(a));
    if (!audOk) {
      throw new Error('OIDC token audience (aud) doğrulaması başarısız.');
    }
  }
  if (opts.clientId && payload.azp && payload.azp !== opts.clientId) {
    throw new Error('OIDC token authorized party (azp) uyuşmuyor.');
  }
  if (opts.expectedNonce && payload.nonce !== opts.expectedNonce) {
    throw new Error('OIDC nonce doğrulaması başarısız.');
  }

  return payload;
}

function getOidcSettings() {
  const raw = state.config?.oidc || {};
  const issuer = String(raw.issuer || 'http://localhost:8080/realms/hbys').replace(/\/+$/, '');
  const clientId = String(raw.clientId || 'hbys-web');
  const redirectUri = new URL(raw.redirectUri || '/', window.location.origin).toString();
  const jwksUri = raw.jwksUri
    ? new URL(raw.jwksUri, window.location.origin).toString()
    : `${issuer}/protocol/openid-connect/certs`;
  return { issuer, clientId, redirectUri, jwksUri };
}

function normalizeUser(userPayload, claims = {}) {
  const roles = Array.isArray(userPayload?.roles)
    ? userPayload.roles
    : Array.isArray(claims?.roles)
      ? claims.roles
      : [];
  const role = String(userPayload?.role || roles[0] || 'user').toLowerCase();
  const displayName = userPayload?.displayName || claims?.name || userPayload?.username || claims?.preferred_username || 'Kullanıcı';
  const username = userPayload?.username || claims?.preferred_username || 'unknown';
  return {
    id: userPayload?.id || claims?.sub || username,
    username,
    displayName,
    role,
    roles,
    specialty: userPayload?.specialty || ''
  };
}

async function exchangeToken(paramsObj) {
  const { issuer } = getOidcSettings();
  const resp = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(paramsObj).toString(),
    cache: 'no-store'
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error_description || data.error || `OIDC token isteği başarısız (${resp.status}).`);
  }
  return data;
}

async function validateAndStoreOidcTokens(tokenResponse, expectedNonce = null) {
  const { issuer, clientId, jwksUri } = getOidcSettings();
  if (!tokenResponse.access_token) throw new Error('OIDC access_token alınamadı.');

  const accessClaims = await verifyJwtRs256(tokenResponse.access_token, issuer, {
    allowedAudiences: ['hbys-api', clientId],
    clientId,
    jwksUri
  });

  let idClaims = {};
  if (tokenResponse.id_token) {
    idClaims = await verifyJwtRs256(tokenResponse.id_token, issuer, {
      allowedAudiences: [clientId],
      clientId,
      expectedNonce,
      jwksUri
    });
  } else if (expectedNonce) {
    throw new Error('OIDC id_token alınamadı; nonce doğrulanamıyor.');
  }

  const expiresInSec = Number(tokenResponse.expires_in || 300);
  const session = {
    accessToken: tokenResponse.access_token,
    idToken: tokenResponse.id_token || null,
    refreshToken: tokenResponse.refresh_token || null,
    expiresAt: Date.now() + expiresInSec * 1000,
    claims: { ...idClaims, ...accessClaims }
  };
  sessionStorage.setItem(OIDC_SESSION_KEY, JSON.stringify(session));
  state.token = session.accessToken;
  return session;
}

export async function beginOidcAuthorization({ prompt } = {}) {
  const { issuer, clientId, redirectUri } = getOidcSettings();
  const txState = randomBase64Url(24);
  const nonce = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);

  sessionStorage.setItem(OIDC_TX_KEY, JSON.stringify({
    state: txState,
    nonce,
    codeVerifier,
    prompt: prompt || null,
    createdAt: Date.now()
  }));

  const authUrl = new URL(`${issuer}/protocol/openid-connect/auth`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('state', txState);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (prompt) authUrl.searchParams.set('prompt', prompt);

  window.location.assign(authUrl.toString());
}

async function refreshOidcTokenIfNeeded() {
  if (state.config?.auth !== 'oidc') return state.token;
  const raw = sessionStorage.getItem(OIDC_SESSION_KEY);
  if (!raw) return null;
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Date.now() < Number(session.expiresAt || 0) - 25_000) {
    state.token = session.accessToken;
    return session.accessToken;
  }
  if (!session.refreshToken) return null;
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const { clientId } = getOidcSettings();
        const refreshed = await exchangeToken({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: session.refreshToken
        });
        const next = await validateAndStoreOidcTokens(refreshed, null);
        return next.accessToken;
      } catch {
        sessionStorage.removeItem(OIDC_SESSION_KEY);
        state.token = null;
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

export function renderAuthModeChrome() {
  const isOidc = state.config?.auth === 'oidc';
  const simEnabled = Boolean(state.config?.features?.simulation);

  const quickSection = $('.quick-login-section');
  const divider = $('#login-divider');
  const demoCreds = $('#demo-credentials-box');
  const demoRoleSelectWrap = $('#login-demo-role-wrap');
  const loginSubmitBtn = $('#login-form button[type="submit"]');
  const topRoleWrap = $('.role-switcher-wrap');
  const sideRolePanel = $('.sidebar-role-panel');
  const demoBanner = $('.demo-banner');
  const quickResetBtn = $('#btn-quick-reset');
  const simBar = $('#sim-control-bar');
  const simTrack = $('#sim-progress-track');
  const simHud = $('#sim-presentation-hud');
  const simToggle = $('#btn-toggle-sim');
  const envBadge = $('#login-env-badge');
  const statusPill = $('.status-pill');

  if (quickSection) quickSection.classList.toggle('hidden', isOidc);
  if (divider) divider.classList.toggle('hidden', isOidc);
  if (demoCreds) demoCreds.classList.toggle('hidden', !isOidc);
  if (demoRoleSelectWrap) demoRoleSelectWrap.classList.toggle('hidden', isOidc);
  if (topRoleWrap) topRoleWrap.classList.toggle('hidden', isOidc);
  if (sideRolePanel) sideRolePanel.classList.toggle('hidden', isOidc);
  if (demoBanner) demoBanner.classList.toggle('hidden', isOidc);
  if (quickResetBtn) quickResetBtn.classList.toggle('hidden', isOidc);

  if (simBar) simBar.classList.toggle('hidden', !simEnabled);
  if (simToggle) simToggle.classList.toggle('hidden', !simEnabled);
  if (!simEnabled) {
    if (simTrack) simTrack.classList.add('hidden');
    if (simHud) simHud.classList.add('hidden');
  }

  if (envBadge) {
    envBadge.textContent = isOidc
      ? 'KURUMSAL OIDC · KEYCLOAK PKCE S256'
      : 'CANLI DEMONSTRASYON & EĞİTİM ORTAMI';
  }
  if (statusPill) {
    statusPill.textContent = isOidc ? 'OIDC PKCE' : 'DEMO MODE';
  }
  if (loginSubmitBtn) {
    loginSubmitBtn.textContent = isOidc
      ? 'Keycloak Kurumsal OIDC Giriş →'
      : 'Seçili Demo Rolü ile Giriş Yap →';
  }

  if (!isOidc) {
    renderQuickDemoRoleGrid();
    populateRoleSelects();
  }
}

function renderQuickDemoRoleGrid() {
  const grid = $('#quick-login-grid');
  if (!grid) return;
  grid.innerHTML = DEMO_USERS.map(u => `
    <button class="role-card-btn" type="button" data-demo-role="${esc(u.role)}">
      <div class="role-card-icon">${esc(u.icon)}</div>
      <div class="role-card-text">
        <div class="role-card-title">${esc(ROLE_LABELS[u.role] || u.role)}</div>
        <div class="role-card-sub">${esc(u.displayName)} · ${esc(u.sub)}</div>
      </div>
    </button>
  `).join('');
}

function populateRoleSelects() {
  const optionsHtml = DEMO_USERS.map(u =>
    `<option value="${esc(u.role)}">${esc(u.icon)} ${esc(ROLE_LABELS[u.role] || u.role)} (${esc(u.displayName)})</option>`
  ).join('');
  for (const id of ['#login-demo-role', '#sidebar-role-select', '#demo-role-select']) {
    const sel = $(id);
    if (sel) sel.innerHTML = optionsHtml;
  }
}

export function setLoginError(message = '') {
  const el = $('#login-error');
  if (el) el.textContent = String(message ?? '');
}

export async function loginDemo(role = 'admin') {
  setLoginError('');
  const res = await api('/api/auth/demo-login', {
    method: 'POST',
    anonymous: true,
    body: { role }
  });
  if (!res?.token || !res?.user) {
    throw new Error('Demo oturum anahtarı alınamadı.');
  }
  state.token = res.token;
  const user = normalizeUser(res.user);
  state.user = user;
  sessionStorage.setItem(DEMO_SESSION_KEY, JSON.stringify({ token: res.token, user }));
  return user;
}

export async function switchDemoRole(role) {
  if (state.config?.auth !== 'demo') return null;
  const res = await api('/api/auth/switch-role', {
    method: 'POST',
    body: { role }
  });
  const nextToken = res?.token || state.token;
  const nextUser = normalizeUser(res?.user || { role });
  state.token = nextToken;
  state.user = nextUser;
  sessionStorage.setItem(DEMO_SESSION_KEY, JSON.stringify({ token: nextToken, user: nextUser }));
  return nextUser;
}

export async function logout() {
  const isOidc = state.config?.auth === 'oidc';
  const rawOidc = sessionStorage.getItem(OIDC_SESSION_KEY);
  let idToken = null;
  if (rawOidc) {
    try { idToken = JSON.parse(rawOidc)?.idToken || null; } catch { /* ignore */ }
  }

  sessionStorage.removeItem(DEMO_SESSION_KEY);
  sessionStorage.removeItem(OIDC_SESSION_KEY);
  sessionStorage.removeItem(OIDC_TX_KEY);
  sessionStorage.removeItem(OIDC_SILENT_KEY);
  state.token = null;
  state.user = null;

  if (isOidc) {
    const { issuer, clientId, redirectUri } = getOidcSettings();
    const logoutUrl = new URL(`${issuer}/protocol/openid-connect/logout`);
    logoutUrl.searchParams.set('client_id', clientId);
    logoutUrl.searchParams.set('post_logout_redirect_uri', redirectUri);
    if (idToken) logoutUrl.searchParams.set('id_token_hint', idToken);
    window.location.assign(logoutUrl.toString());
    return;
  }

  $('#app-shell')?.classList.add('hidden');
  $('#login-screen')?.classList.remove('hidden');
}

export async function handleLoginFormSubmit() {
  setLoginError('');
  if (state.config?.auth === 'oidc') {
    await beginOidcAuthorization();
    return null;
  }
  const selectedRole = $('#login-demo-role')?.value || 'admin';
  return loginDemo(selectedRole);
}

export async function initAuth({ onSessionLost } = {}) {
  onSessionLostCallback = onSessionLost || null;

  registerAuthHooks({
    getToken: async () => {
      if (state.config?.auth === 'oidc') {
        return refreshOidcTokenIfNeeded();
      }
      return state.token;
    },
    onUnauthorized: async () => {
      sessionStorage.removeItem(DEMO_SESSION_KEY);
      sessionStorage.removeItem(OIDC_SESSION_KEY);
      state.token = null;
      state.user = null;
      if (typeof onSessionLostCallback === 'function') {
        onSessionLostCallback();
      }
    }
  });

  try {
    const cfg = await api('/api/config', { anonymous: true });
    if (cfg && typeof cfg === 'object') {
      state.config = {
        mode: cfg.mode || 'demo',
        auth: cfg.auth || 'demo',
        oidc: cfg.oidc || null,
        features: { ...(state.config.features || {}), ...(cfg.features || {}) }
      };
    }
  } catch (err) {
    setLoginError(`Yapılandırma alınamadı: ${err.message}`);
  }

  renderAuthModeChrome();

  if (state.config.auth === 'oidc') {
    const url = new URL(window.location.href);
    const params = url.searchParams;

    if (params.has('error')) {
      const errCode = params.get('error');
      const errDesc = params.get('error_description') || errCode;
      const rawTx = sessionStorage.getItem(OIDC_TX_KEY);
      sessionStorage.removeItem(OIDC_TX_KEY);
      sessionStorage.setItem(OIDC_SILENT_KEY, '1');
      window.history.replaceState({}, document.title, url.pathname);

      let tx = null;
      try { tx = rawTx ? JSON.parse(rawTx) : null; } catch { tx = null; }
      const silentExpected = ['login_required', 'interaction_required', 'consent_required'].includes(errCode);
      if (!silentExpected && !(tx?.prompt === 'none')) {
        setLoginError(`OIDC giriş hatası: ${errDesc}`);
      }
      return { authenticated: false };
    }

    if (params.has('code')) {
      const code = params.get('code');
      const returnedState = params.get('state');
      const rawTx = sessionStorage.getItem(OIDC_TX_KEY);
      sessionStorage.removeItem(OIDC_TX_KEY);
      window.history.replaceState({}, document.title, url.pathname);

      let tx = null;
      try { tx = rawTx ? JSON.parse(rawTx) : null; } catch { tx = null; }
      if (!tx || tx.state !== returnedState) {
        setLoginError('OIDC durum (state) doğrulaması başarısız oldu.');
        return { authenticated: false };
      }

      try {
        const { clientId, redirectUri } = getOidcSettings();
        const tokenResponse = await exchangeToken({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: tx.codeVerifier
        });
        const session = await validateAndStoreOidcTokens(tokenResponse, tx.nonce);
        const me = await api('/api/me');
        const user = normalizeUser(me?.user, session.claims);
        state.user = user;
        sessionStorage.removeItem(OIDC_SILENT_KEY);
        return { authenticated: true, user };
      } catch (err) {
        sessionStorage.removeItem(OIDC_SESSION_KEY);
        state.token = null;
        setLoginError(err.message);
        return { authenticated: false };
      }
    }

    const existingRaw = sessionStorage.getItem(OIDC_SESSION_KEY);
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw);
        state.token = existing.accessToken;
        const activeToken = await refreshOidcTokenIfNeeded();
        if (activeToken) {
          const me = await api('/api/me');
          const user = normalizeUser(me?.user, existing.claims);
          state.user = user;
          return { authenticated: true, user };
        }
      } catch {
        sessionStorage.removeItem(OIDC_SESSION_KEY);
        state.token = null;
      }
    }

    if (!sessionStorage.getItem(OIDC_SILENT_KEY)) {
      sessionStorage.setItem(OIDC_SILENT_KEY, '1');
      await beginOidcAuthorization({ prompt: 'none' });
      return { authenticated: false, redirecting: true };
    }

    return { authenticated: false };
  }

  // Demo mode session restore
  const savedDemo = sessionStorage.getItem(DEMO_SESSION_KEY);
  if (savedDemo) {
    try {
      const parsed = JSON.parse(savedDemo);
      if (parsed?.token) {
        state.token = parsed.token;
        const me = await api('/api/me', { skipUnauthorizedHandler: true });
        const user = normalizeUser(me?.user || parsed.user);
        state.user = user;
        return { authenticated: true, user };
      }
    } catch {
      sessionStorage.removeItem(DEMO_SESSION_KEY);
      state.token = null;
      state.user = null;
    }
  }

  return { authenticated: false };
}
