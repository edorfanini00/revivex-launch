// Meta Conversions API: the server copy of the browser pixel events, with the same
// event ids so Meta counts each event once.
//
// Never blocks or fails a response: callers fire and forget after replying, every send
// has a short timeout, and nothing here throws. It is a silent no-op while the pixel id
// is the placeholder, META_CAPI_ACCESS_TOKEN is unset, or the browser sends Global Privacy
// Control (Sec-GPC: 1). Meta receives the client IP, user agent, the _fbp/_fbc cookie
// values and, only when Stripe returns one, a SHA-256 hash of the email. Never the raw
// email, name, payment details or the access token in any log.
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { META_PIXEL_ID } from '../public/meta-pixel-id.js';
import { DEPOSIT } from './deposit-config.js';
import { clientIp } from './http.js';

export const GRAPH_API_VERSION = 'v24.0';
export const CAPI_TIMEOUT_MS = 1500;
export const DEPOSIT_CUSTOM_DATA = Object.freeze({
  content_name: 'Revivex machine preorder deposit',
  value: DEPOSIT.amount / 100,
  currency: DEPOSIT.currency.toUpperCase(),
});

const PIXEL_ID_RE = /^[0-9]{6,20}$/;
// fb.<subdomain index>.<creation ms>.<random or fbclid>
const FB_COOKIE_RE = /^fb\.[0-9]\.[0-9]{9,16}\.[A-Za-z0-9_.-]{1,400}$/;
const TEST_CODE_RE = /^TEST[A-Za-z0-9]{1,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

const clean = v => (typeof v === 'string' ? v.trim() : '');

export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function hashEmail(email) {
  const e = clean(email).toLowerCase();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) return null;
  return crypto.createHash('sha256').update(e).digest('hex');
}

export function userData(req, { email } = {}) {
  const ud = {};
  const ip = clientIp(req);
  if (isIP(ip)) ud.client_ip_address = ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string' && ua) ud.client_user_agent = ua.slice(0, 512);
  for (const [cookie, field] of [['_fbp', 'fbp'], ['_fbc', 'fbc']]) {
    const v = readCookie(req.headers.cookie, cookie);
    if (v && FB_COOKIE_RE.test(v)) ud[field] = v;
  }
  const em = hashEmail(email);
  if (em) ud.em = [em];
  return ud;
}

export function buildEvent({ name, eventId, req, sourceUrl, email, nowMs }) {
  const event = {
    event_name: name,
    event_time: Math.floor(nowMs / 1000),
    event_id: eventId,
    action_source: 'website',
    user_data: userData(req, { email }),
    custom_data: { ...DEPOSIT_CUSTOM_DATA },
  };
  if (sourceUrl) event.event_source_url = sourceUrl;
  return event;
}

// Vercel exposes waitUntil through this request-context symbol (what @vercel/functions
// reads), so a send started after the response can finish. Elsewhere it simply runs.
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
export function keepAlive(promise) {
  try { globalThis[REQUEST_CONTEXT]?.get?.()?.waitUntil?.(promise); } catch { /* not on Vercel */ }
}

export function createMetaCapi({
  pixelId = META_PIXEL_ID,
  fetchImpl = (...a) => globalThis.fetch(...a),
  timeoutMs = CAPI_TIMEOUT_MS,
  now = () => Date.now(),
  log = () => {},
  schedule = keepAlive,
} = {}) {
  async function post(token, event, testCode) {
    // The deadline settles the send even if the fetch ignores the abort signal.
    const ac = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error('timeout')); }, timeoutMs); });
    deadline.catch(() => {});
    try {
      const body = { data: [event], access_token: token };
      if (testCode) body.test_event_code = testCode;
      const res = await Promise.race([fetchImpl(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pixelId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
        redirect: 'error',
      }), deadline]);
      res.body?.cancel?.().catch?.(() => {});
      if (!res.ok) {
        log('meta_capi_failed', { reason: event.event_name, status: res.status });
        return { ok: false, status: res.status };
      }
      return { ok: true };
    } catch {
      const kind = ac.signal.aborted ? 'timeout' : 'network';
      log('meta_capi_failed', { reason: event.event_name, kind });
      return { ok: false, kind };
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns a promise that always resolves (for tests); callers do not await it.
  function track(env, req, { name, eventId, sourceUrl, email }) {
    try {
      const token = clean(env?.META_CAPI_ACCESS_TOKEN);
      if (!PIXEL_ID_RE.test(String(pixelId)) || !token) return Promise.resolve({ ok: false, skipped: 'unconfigured' });
      if (req.headers['sec-gpc'] === '1') return Promise.resolve({ ok: false, skipped: 'gpc' });
      if (typeof eventId !== 'string' || !eventId) return Promise.resolve({ ok: false, skipped: 'event_id' });
      const testCode = TEST_CODE_RE.test(clean(env.META_TEST_EVENT_CODE)) ? clean(env.META_TEST_EVENT_CODE) : '';
      const sending = post(token, buildEvent({ name, eventId, req, sourceUrl, email, nowMs: now() }), testCode);
      schedule(sending);
      return sending;
    } catch {
      return Promise.resolve({ ok: false, skipped: 'error' });
    }
  }

  return { track };
}
