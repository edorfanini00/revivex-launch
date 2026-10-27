// Meta Conversions API: the server copy of the browser pixel events, with the same
// event ids so Meta counts each event once. Used by the deposit routes (InitiateCheckout,
// Purchase) and the waitlist signup (Lead, lib/waitlist.js).
//
// Never blocks or fails a response: callers fire and forget after replying, every send
// has a short timeout, and nothing here throws. It is a silent no-op while the pixel id
// is the placeholder, META_CAPI_ACCESS_TOKEN is unset, the caller's mode is not live, the
// browser sends Global Privacy Control (Sec-GPC: 1), or this instance already made
// CAPI_SENDS_PER_MINUTE sends in the last minute. Meta receives the client IP, user
// agent, the _fbp/_fbc cookie values and, when there is one (Stripe customer email or
// waitlist email), a SHA-256 hash of the email. Never the raw
// email, name, payment details or the access token in any log.
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { META_PIXEL_ID } from '../public/meta-pixel-id.js';
import { DEPOSIT } from './deposit-config.js';
import { clientIp, createInstanceRateLimiter } from './http.js';

export const GRAPH_API_VERSION = 'v24.0';
export const CAPI_TIMEOUT_MS = 1500;
// Per-instance ceiling on outbound sends, far above real deposit traffic.
export const CAPI_SENDS_PER_MINUTE = 60;
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

// eventTime (unix seconds) is when it happened, e.g. the payment time; defaults to now.
// value (USD) is the amount actually paid, for a deposit made under earlier terms;
// defaults to the current deposit. customData replaces the deposit data entirely (the
// waitlist Lead carries no value).
export function buildEvent({ name, eventId, req, sourceUrl, email, eventTime, value, customData, nowMs }) {
  const event = {
    event_name: name,
    event_time: Number.isInteger(eventTime) ? eventTime : Math.floor(nowMs / 1000),
    event_id: eventId,
    action_source: 'website',
    user_data: userData(req, { email }),
    custom_data: customData ? { ...customData } : { ...DEPOSIT_CUSTOM_DATA, ...(Number.isFinite(value) && value > 0 ? { value } : {}) },
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
  sendLimiter = createInstanceRateLimiter({ limit: CAPI_SENDS_PER_MINUTE, windowMs: 60_000, now }),
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

  // Returns a promise that always resolves (for tests); callers do not await it. Only
  // { ok: true } means Meta accepted the event. mode is the Stripe mode of the deposit:
  // test mode payments are never reported to the live dataset.
  function track(env, req, { name, eventId, sourceUrl, email, eventTime, mode, value, customData }) {
    try {
      const token = clean(env?.META_CAPI_ACCESS_TOKEN);
      if (!PIXEL_ID_RE.test(String(pixelId)) || !token) return Promise.resolve({ ok: false, skipped: 'unconfigured' });
      if (mode !== 'live') return Promise.resolve({ ok: false, skipped: 'test_mode' });
      if (req.headers['sec-gpc'] === '1') return Promise.resolve({ ok: false, skipped: 'gpc' });
      if (typeof eventId !== 'string' || !eventId) return Promise.resolve({ ok: false, skipped: 'event_id' });
      if (!sendLimiter('all').ok) return Promise.resolve({ ok: false, skipped: 'rate_limited' });
      const testCode = TEST_CODE_RE.test(clean(env.META_TEST_EVENT_CODE)) ? clean(env.META_TEST_EVENT_CODE) : '';
      const sending = post(token, buildEvent({ name, eventId, req, sourceUrl, email, eventTime, value, customData, nowMs: now() }), testCode);
      schedule(sending);
      return sending;
    } catch {
      return Promise.resolve({ ok: false, skipped: 'error' });
    }
  }

  return { track };
}
