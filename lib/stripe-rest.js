// Minimal Stripe REST client for the deposit flow (no SDK dependency).
// Each call has a hard timeout. Results are classified so callers can tell a
// definite answer from an uncertain one; nothing here retries a write.
import { STRIPE_API_VERSION } from './deposit-config.js';

const API = 'https://api.stripe.com';

export class StripeCallError extends Error {
  // kind: 'timeout' | 'network' | 'api'
  constructor(kind, { status = 0, type = '', code = '', requestId = '' } = {}) {
    super(`stripe_${kind}${status ? `_${status}` : ''}`);
    this.kind = kind;
    this.status = status;
    this.type = type;
    this.code = code;
    this.requestId = requestId;
  }
}

// Stripe form encoding: nested objects as a[b][c]=v, arrays as a[0]=v.
export function encodeForm(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encodeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
async function readText(res) {
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new StripeCallError('api', { status: res.status, type: 'response_too_large' });
  return text;
}

export function createStripeRestProvider({ secretKey, fetchImpl = globalThis.fetch, timeoutMs = 4000, createTimeoutMs = 5500 }) {
  if (!secretKey) throw new Error('secret key required');

  async function call(method, path, { query, form, idempotencyKey, timeout = timeoutMs } = {}) {
    const url = new URL(path, API);
    if (query) for (const [k, v] of query) url.searchParams.append(k, v);
    const headers = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': STRIPE_API_VERSION };
    let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = encodeForm(form).toString(); }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    // One deadline covers connect, headers and the whole body. Racing every await
    // against it means a hung or slow body still ends as a classified timeout.
    const ac = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(new StripeCallError('timeout')); }, timeout);
    });
    deadline.catch(() => {});
    let res, text;
    try {
      res = await Promise.race([fetchImpl(url.toString(), { method, headers, body, signal: ac.signal, redirect: 'error' }), deadline]);
      text = await Promise.race([readText(res), deadline]);
    } catch (e) {
      if (e instanceof StripeCallError) { res?.body?.cancel?.().catch?.(() => {}); throw e; }
      throw new StripeCallError(ac.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
    const requestId = res.headers?.get?.('request-id') || '';
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = data?.error || {};
      throw new StripeCallError('api', { status: res.status, type: err.type || '', code: err.code || '', requestId });
    }
    if (!data || typeof data !== 'object') throw new StripeCallError('api', { status: res.status, type: 'invalid_response', requestId });
    return data;
  }

  return {
    getAccount: () => call('GET', '/v1/account'),
    getPrice: priceId => call('GET', `/v1/prices/${encodeURIComponent(priceId)}`, {
      query: [['expand[]', 'product'], ['expand[]', 'currency_options']],
    }),
    createCheckoutSession: (params, idempotencyKey) =>
      call('POST', '/v1/checkout/sessions', { form: params, idempotencyKey, timeout: createTimeoutMs }),
    retrieveCheckoutSession: sessionId => call('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      query: [['expand[]', 'line_items'], ['expand[]', 'payment_intent.latest_charge']],
    }),
  };
}
