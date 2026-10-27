// Early access waitlist: POST /api/signup (join), GET /api/signup (visitor country hint)
// and GET|POST /api/unsubscribe?token=… (one-click unsubscribe).
//
// Storage is the shared Neon Postgres database (DATABASE_URL), table revivex_waitlist,
// created by scripts/migrate-waitlist.mjs. A signup answers { ok: true } only after its
// row is committed; every other outcome is an error and nothing is reported as saved.
// Repeat signups for the same email are idempotent (one row, no second welcome email).
//
// Privacy: no raw email address, token or IP address is ever logged. The IP address is
// stored only as an HMAC-SHA256 with a secret salt (REVIVEX_IP_HASH_SALT), which is also
// the key for the per-IP rate limit counter (table revivex_waitlist_rate).
import crypto from 'node:crypto';
import { isCountryCode } from '../public/countries.js';
import { HttpError, clientIp, makeLogger, rateLimitKey, readJsonBody } from './http.js';
import { createMetaCapi, readCookie } from './meta-capi.js';

export const CONSENT_TEXT_VERSION = 'waitlist-v1';
export const SIGNUP_BODY_LIMIT = 4096;
// Per IP (or IPv6 /64): this many signup attempts per window, counted in the database so
// the limit holds across function instances.
export const RATE_LIMIT = 10;
export const RATE_WINDOW_S = 600;
export const EMAIL_TIMEOUT_MS = 4000;
export const SOURCES = new Set(['nav', 'hero', 'mid', 'waitlist']);
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
// The hidden field real visitors never see or fill.
export const HONEYPOT_FIELD = 'hp_extra';

// Additive only: production and previews share this database. Never drops or alters an
// existing object; safe to run any number of times.
export const MIGRATION_SQL = `
create extension if not exists citext;
create table if not exists revivex_waitlist (
  id bigint generated always as identity primary key,
  email citext not null,
  country char(2),
  source text not null,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbp text,
  fbc text,
  user_agent text,
  ip_hash text,
  consent_text_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  unsubscribe_token text not null
);
create unique index if not exists revivex_waitlist_email_key on revivex_waitlist (email);
create unique index if not exists revivex_waitlist_unsubscribe_token_key on revivex_waitlist (unsubscribe_token);
create table if not exists revivex_waitlist_rate (
  ip_hash text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (ip_hash, window_start)
);
`;

// Strict but practical: one @, a dot-atom local part (no leading, trailing or doubled
// dots), and a domain of LDH labels with an alphabetic TLD of at least two letters.
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const e = value.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  const at = e.lastIndexOf('@');
  if (at < 1 || e.indexOf('@') !== at) return null;
  const local = e.slice(0, at), domain = e.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every(l => LABEL_RE.test(l))) return null;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return null;
  return e;
}

const UTM_RE = /^[\p{L}\p{N} ._~:/|+%-]{1,100}$/u;
export function cleanAttribution(a) {
  const out = {};
  if (!a || typeof a !== 'object' || Array.isArray(a)) return out;
  for (const k of UTM_KEYS) {
    const v = typeof a[k] === 'string' ? a[k].trim() : '';
    if (v && UTM_RE.test(v)) out[k] = v;
  }
  return out;
}

const FB_COOKIE_RE = /^fb\.[0-9]\.[0-9]{9,16}\.[A-Za-z0-9_.-]{1,400}$/;
const fbCookie = (req, name) => { const v = readCookie(req.headers.cookie, name); return v && FB_COOKIE_RE.test(v) ? v : null; };

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const newLeadEventId = () => `lead_${crypto.randomBytes(16).toString('base64url')}`;

export function ipHash(salt, req) {
  return crypto.createHmac('sha256', salt).update(`rvx-waitlist-ip-v1|${rateLimitKey(clientIp(req))}`).digest('hex');
}

// The origin the visitor used. Vercel sets Host (and x-forwarded-host) to the deployment
// domain; anything else never reaches this function.
export function requestOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(host)) return null;
  const local = /^(127\.0\.0\.1|localhost)(:|$)/.test(host);
  return `${local ? 'http' : 'https'}://${host}`;
}

// Same-origin gate for the state-changing routes: the Origin header must name this host.
function assertSameHost(req) {
  const origin = req.headers.origin;
  if (!origin || origin !== requestOrigin(req)) throw new HttpError(403, 'forbidden_origin');
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'forbidden_origin');
}

function send(res, status, body, extra = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

const MESSAGES = {
  invalid_email: 'Enter a valid email address.',
  invalid_country: 'Choose your country from the list.',
  invalid_request: 'This request could not be read. Please reload the page and try again.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  unavailable: 'Signup is not available right now. Nothing was saved. Please try again later.',
  save_failed: 'We could not save your signup. Nothing was saved. Please try again.',
  forbidden_origin: 'This request could not be accepted. Please reload the page and try again.',
};
const fail = (res, status, error, extra) => send(res, status, { ok: false, error, message: MESSAGES[error] || MESSAGES.invalid_request }, extra);

export function readWaitlistConfig(env = {}) {
  const databaseUrl = String(env.DATABASE_URL || '').trim();
  const salt = String(env.REVIVEX_IP_HASH_SALT || '').trim();
  return {
    ok: !!databaseUrl && salt.length >= 32,
    databaseUrl,
    salt,
    resend: {
      apiKey: String(env.RESEND_API_KEY || '').trim(),
      from: String(env.RESEND_FROM || '').trim(),
      replyTo: String(env.RESEND_REPLY_TO || '').trim(),
    },
    // Server Lead events go to the live dataset only from the production deployment.
    metaMode: env.VERCEL_ENV === 'production' || env.REVIVEX_META_MODE === 'live' ? 'live' : 'test',
    siteOrigin: env.VERCEL_ENV === 'production' && /^https:\/\/[A-Za-z0-9.-]+$/.test(String(env.REVIVEX_SITE_ORIGIN || '')) ? env.REVIVEX_SITE_ORIGIN : null,
  };
}

// Neon serverless (HTTPS, one statement per call). Tests inject their own { query }.
export async function neonDb(url) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  return { query: (text, params) => sql.query(text, params) };
}
const rowsOf = r => (Array.isArray(r) ? r : r && Array.isArray(r.rows) ? r.rows : []);

// One atomic counter per IP hash and fixed window. Old windows are pruned occasionally.
export async function takeRateLimit(db, hash, { limit = RATE_LIMIT, windowS = RATE_WINDOW_S, random = Math.random } = {}) {
  const rows = rowsOf(await db.query(
    `insert into revivex_waitlist_rate as r (ip_hash, window_start, hits)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     on conflict (ip_hash, window_start) do update set hits = r.hits + 1
     returning hits`, [hash, windowS]));
  if (random() < 0.02) await db.query(`delete from revivex_waitlist_rate where window_start < now() - interval '1 day'`).catch(() => {});
  return Number(rows[0]?.hits) <= limit;
}

// Inserts the signup, or touches the existing row for that email. First-touch attribution
// is kept; a missing country is filled in; signing up again after unsubscribing is an
// explicit new consent, so it clears unsubscribed_at. Returns { id, inserted, token }.
export async function upsertSignup(db, s) {
  const rows = rowsOf(await db.query(
    `insert into revivex_waitlist as w (email, country, source, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       fbp, fbc, user_agent, ip_hash, consent_text_version, unsubscribe_token)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (email) do update set
       updated_at = now(),
       country = coalesce(w.country, excluded.country),
       unsubscribed_at = null,
       consent_text_version = excluded.consent_text_version
     returning id, (xmax = 0) as inserted, unsubscribe_token`,
    [s.email, s.country, s.source, s.utm.utm_source || null, s.utm.utm_medium || null, s.utm.utm_campaign || null, s.utm.utm_content || null, s.utm.utm_term || null,
      s.fbp, s.fbc, s.userAgent, s.ipHash, CONSENT_TEXT_VERSION, s.token]));
  const r = rows[0];
  if (!r || r.id === undefined || r.id === null) throw new Error('no row returned');
  return { id: String(r.id), inserted: r.inserted === true || r.inserted === 't', token: r.unsubscribe_token };
}

export function unsubscribeUrl(origin, token) {
  return `${origin}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

// Customer copy: no dashes, brand spelled Revivex.
export function welcomeEmail({ unsubscribe }) {
  const subject = "You're on the Revivex early access list";
  const text = [
    "You're on the list.",
    '',
    "Thanks for joining the Revivex early access list. We'll keep you updated as we get closer to launch.",
    '',
    'The Revivex machine is in development. The final price and shipping date have not been announced.',
    '',
    `Unsubscribe at any time: ${unsubscribe}`,
    'Questions? Write to support@revivex.store.',
  ].join('\n');
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html><body style="margin:0;background:#f8f7f4;font-family:Inter,Helvetica,Arial,sans-serif;color:#0a0a0a">
<div style="max-width:520px;margin:0 auto;padding:40px 24px">
<p style="font-size:22px;font-weight:600;margin:0 0 16px">You're on the list.</p>
<p style="font-size:16px;line-height:1.5;margin:0 0 16px">Thanks for joining the Revivex early access list. We'll keep you updated as we get closer to launch.</p>
<p style="font-size:14px;line-height:1.5;color:#555;margin:0 0 32px">The Revivex machine is in development. The final price and shipping date have not been announced.</p>
<p style="font-size:13px;line-height:1.5;color:#777;margin:0">You are receiving this because you joined the waitlist on the Revivex website. <a href="${esc(unsubscribe)}" style="color:#555">Unsubscribe</a> at any time, or write to <a href="mailto:support@revivex.store" style="color:#555">support@revivex.store</a>.</p>
</div></body></html>`;
  return { subject, text, html };
}

// Resend REST API. Never throws; never logs the address.
export async function sendWelcome({ resend, to, unsubscribe, idempotencyKey, fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = EMAIL_TIMEOUT_MS }) {
  if (!resend.apiKey || !resend.from) return { ok: false, skipped: 'unconfigured' };
  const { subject, text, html } = welcomeEmail({ unsubscribe });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const body = {
      from: resend.from, to: [to], subject, text, html,
      headers: { 'List-Unsubscribe': `<${unsubscribe}>, <mailto:support@revivex.store?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    };
    if (resend.replyTo) body.reply_to = resend.replyTo;
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resend.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
      signal: ac.signal,
      redirect: 'error',
    });
    res.body?.cancel?.().catch?.(() => {});
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch {
    return { ok: false, kind: ac.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export const LEAD_CUSTOM_DATA = Object.freeze({ content_name: 'Revivex early access waitlist' });

export function createSignupHandler({
  getEnv = () => process.env,
  dbFactory = neonDb,
  metaCapi = createMetaCapi({ log: makeLogger() }),
  fetchImpl,
  log = makeLogger(),
  rateLimit = RATE_LIMIT,
} = {}) {
  let cached = null;
  const dbFor = async url => {
    if (!cached || cached.url !== url) cached = { url, db: await dbFactory(url) };
    return cached.db;
  };

  return async function handler(req, res) {
    try {
      if (req.method === 'GET') {
        // Country hint for the form default. Vercel sets x-vercel-ip-country at its edge.
        const c = String(req.headers['x-vercel-ip-country'] || '').toUpperCase();
        return send(res, 200, { country: isCountryCode(c) ? c : null });
      }
      if (req.method !== 'POST') return fail(res, 405, 'invalid_request', { Allow: 'GET, POST' });

      assertSameHost(req);
      const body = await readJsonBody(req, SIGNUP_BODY_LIMIT);
      const cfg = readWaitlistConfig(getEnv());
      if (!cfg.ok) { log('waitlist_unavailable', { reason: 'config' }); return fail(res, 503, 'unavailable'); }

      if (typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '') {
        log('waitlist_rejected', { reason: 'honeypot' });
        return fail(res, 400, 'invalid_request');
      }
      const email = normalizeEmail(body.email);
      if (!email) return fail(res, 400, 'invalid_email');
      const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
      if (!isCountryCode(country)) return fail(res, 400, 'invalid_country');
      const source = `homepage:${SOURCES.has(body.source) ? body.source : 'other'}`;

      let db;
      try { db = await dbFor(cfg.databaseUrl); } catch { log('waitlist_unavailable', { reason: 'db_init' }); return fail(res, 503, 'unavailable'); }
      const hash = ipHash(cfg.salt, req);
      let allowed;
      try { allowed = await takeRateLimit(db, hash, { limit: rateLimit }); } catch (e) {
        log('waitlist_save_failed', { reason: 'rate_counter', code: e && e.code });
        return fail(res, 503, e && e.code === '42P01' ? 'unavailable' : 'save_failed');
      }
      if (!allowed) { log('waitlist_rejected', { reason: 'rate_limited' }); return fail(res, 429, 'rate_limited', { 'Retry-After': String(RATE_WINDOW_S) }); }

      const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : null;
      let saved;
      try {
        saved = await upsertSignup(db, {
          email, country, source, utm: cleanAttribution(body.attribution),
          fbp: fbCookie(req, '_fbp'), fbc: fbCookie(req, '_fbc'), userAgent: ua, ipHash: hash, token: newToken(),
        });
      } catch (e) {
        log('waitlist_save_failed', { reason: 'upsert', code: e && e.code });
        return fail(res, 503, e && e.code === '42P01' ? 'unavailable' : 'save_failed');
      }

      // The row is committed. Everything below is best effort and cannot undo the signup.
      let lead = null;
      if (saved.inserted) {
        lead = newLeadEventId();
        const origin = cfg.siteOrigin || requestOrigin(req);
        const mail = await sendWelcome({ resend: cfg.resend, to: email, unsubscribe: unsubscribeUrl(origin, saved.token), idempotencyKey: `revivex-welcome-${saved.id}`, fetchImpl });
        if (!mail.ok) log('waitlist_email_failed', { reason: mail.skipped || 'send', status: mail.status, kind: mail.kind });
        try {
          metaCapi.track(getEnv(), req, { name: 'Lead', eventId: lead, email, mode: cfg.metaMode, customData: LEAD_CUSTOM_DATA, sourceUrl: typeof req.headers.referer === 'string' && req.headers.referer.startsWith(origin) ? req.headers.referer.split('?')[0] : `${origin}/` });
        } catch { /* measurement never affects the signup */ }
      }
      log('waitlist_saved', { state: saved.inserted ? 'new' : 'repeat' });
      return send(res, 200, { ok: true, lead });
    } catch (e) {
      if (e instanceof HttpError) {
        const map = { forbidden_origin: 'forbidden_origin' };
        return fail(res, e.status, map[e.state] || 'invalid_request');
      }
      log('waitlist_save_failed', { reason: 'unexpected' });
      return fail(res, 500, 'save_failed');
    }
  };
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function page(res, status, title, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Revivex</title></head>
<body style="margin:0;background:#f8f7f4;font-family:Inter,Helvetica,Arial,sans-serif;color:#0a0a0a">
<main style="max-width:520px;margin:0 auto;padding:72px 24px"><img src="/assets/brand/logo-dark.png" alt="Revivex" width="150" style="display:block;height:auto;margin:0 0 40px">
<h1 style="font-size:28px;font-weight:500;margin:0 0 16px">${title}</h1><p style="font-size:16px;line-height:1.5;margin:0 0 24px">${text}</p>
<p style="font-size:14px;margin:0"><a href="/" style="color:#0a0a0a">Back to Revivex</a></p></main></body></html>`);
}

// GET shows a confirmation page; POST is the RFC 8058 one-click request mail apps send.
export function createUnsubscribeHandler({ getEnv = () => process.env, dbFactory = neonDb, log = makeLogger() } = {}) {
  let cached = null;
  return async function handler(req, res) {
    const isPost = req.method === 'POST';
    if (req.method !== 'GET' && !isPost) { res.setHeader('Allow', 'GET, POST'); return page(res, 405, 'Not allowed', 'Use the unsubscribe link from your email.'); }
    const token = new URL(req.url || '/', 'http://x').searchParams.get('token') || '';
    const done = (status, title, text) => (isPost ? send(res, status, { ok: status === 200 }) : page(res, status, title, text));
    if (!TOKEN_RE.test(token)) return done(400, 'Link not recognised', 'This unsubscribe link is not complete. Use the link from your email, or write to support@revivex.store and we will remove you.');
    const cfg = readWaitlistConfig(getEnv());
    if (!cfg.databaseUrl) return done(503, 'Please try again', 'We could not process this right now. Please try the link again later, or write to support@revivex.store.');
    try {
      if (!cached || cached.url !== cfg.databaseUrl) cached = { url: cfg.databaseUrl, db: await dbFactory(cfg.databaseUrl) };
      const rows = rowsOf(await cached.db.query(
        `update revivex_waitlist set unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
         where unsubscribe_token = $1 returning id`, [token]));
      if (!rows.length) return done(404, 'Link not recognised', 'We could not find this subscription. You may already have been removed. Write to support@revivex.store if you still get emails.');
      log('waitlist_unsubscribed', {});
      return done(200, "You're unsubscribed", 'You will not get any more Revivex launch emails. If you change your mind, you can join the waitlist again on our website.');
    } catch (e) {
      log('waitlist_unsubscribe_failed', { code: e && e.code });
      return done(503, 'Please try again', 'We could not process this right now. Please try the link again later, or write to support@revivex.store.');
    }
  };
}
