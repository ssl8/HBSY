/**
 * HTTP client for NOVA HBYS APIs with Bearer token injection, key normalization,
 * and structured error propagation (401 auth recovery, 409 CDS conflicts).
 */

let tokenProvider = async () => null;
let unauthorizedHandler = async () => {};

export function registerAuthHooks({ getToken, onUnauthorized }) {
  if (typeof getToken === 'function') tokenProvider = getToken;
  if (typeof onUnauthorized === 'function') unauthorizedHandler = onUnauthorized;
}

export class ApiError extends Error {
  constructor(message, status, payload = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.code || null;
    this.payload = payload || {};
  }
}

export function camelizeKey(key) {
  if (typeof key !== 'string' || !key.includes('_')) return key;
  return key.replace(/_([a-z0-9])/gi, (_, ch) => ch.toUpperCase());
}

/** Recursively normalize snake_case response keys to canonical camelCase. */
export function normalizeKeys(value) {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[camelizeKey(k)] = normalizeKeys(v);
    }
    return out;
  }
  return value;
}

export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const token = options.anonymous ? null : await tokenProvider();
  const correlationId = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const headers = {
    Accept: 'application/json',
    'X-Correlation-ID': correlationId,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.rawBody !== undefined
      ? { 'Content-Type': options.contentType || 'text/plain; charset=utf-8' }
      : options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
    ...(options.headers || {})
  };

  const fetchBody = options.rawBody !== undefined
    ? String(options.rawBody)
    : options.body !== undefined
      ? JSON.stringify(options.body)
      : undefined;

  const response = await fetch(path, {
    method,
    headers,
    body: fetchBody,
    credentials: 'same-origin',
    cache: 'no-store'
  });

  const text = await response.text();
  let rawPayload = {};
  if (text) {
    try {
      rawPayload = JSON.parse(text);
    } catch {
      rawPayload = { raw: text };
    }
  }
  const payload = normalizeKeys(rawPayload);

  if (!response.ok) {
    if (response.status === 401 && !options.anonymous && !options.skipUnauthorizedHandler) {
      await unauthorizedHandler();
    }
    const msg = payload?.error || payload?.detail || payload?.title || `İstek başarısız (${response.status})`;
    throw new ApiError(msg, response.status, payload);
  }

  return payload;
}
