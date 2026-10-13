// POST /api/signup   short "Get launch updates" opt in (email + optional first name)
// GET|POST /api/unsubscribe?t=<signed token>   one click unsubscribe
//
// Signup: same origin JSON only, bounded body, per IP and global rate limits, a hidden
// honeypot field, validated fields. Stored in `subscribers` with consent_marketing=true
// and the exact consent line shown. The reply is identical whether the address is new,
// already subscribed or caught by the honeypot, so the form cannot be used to test which
// addresses are on the list. A short welcome email (with List-Unsubscribe headers) goes
// out only when this request turned consent on.
import { HttpError, assertSameOrigin, clientIp, createInstanceRateLimiter, makeLogger, rateLimitKey, readJsonBody, sendJson } from './http.js';
import { SIGNUP_CONSENT_TEXT, readCrmSecret, readDatabaseUrl, readEmailConfig, readLinkOrigin } from './crm-config.js';
import { sqlClient } from './db.js';
import { createCrmStore } from './crm-store.js';
import { sanitizeAttribution } from './operation-token.js';
import { hashIp, readUnsubscribeToken, unsubscribeToken } from './unsubscribe-token.js';
import { renderWelcome } from './email/index.js';
import { sendEmail } from './resend.js';
import { SUPPORT_EMAIL } from './deposit-config.js';

const BODY_LIMIT = 2048;
const FIELDS = new Set(['email', 'firstName', 'website', 'source', 'attribution']);
const SOURCES = new Set(['reserve', 'footer']);
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

export const SIGNUP_MESSAGES = {
  ok: "Thanks. You're on the list.",
  invalid_email: 'Please enter a valid email address.',
  invalid_name: 'Please shorten your first name.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  unavailable: 'Sign up is not available right now. Nothing was saved. Please try again later.',
  invalid: 'Something was wrong with that request. Nothing was saved.',
};

export function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

// Optional first name: trimmed, control characters removed, at most 60 characters.
export function normalizeFirstName(v) {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false };
  const n = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (n.length > 60) return { ok: false };
  return { ok: true, value: n || null };
}

const reply = (res, status, state, headers) => sendJson(res, status, { ok: status < 300, state, message: SIGNUP_MESSAGES[state] }, headers);

export function createSignupHandler({
  getEnv = () => process.env,
  storeFactory = url => createCrmStore(sqlClient(url)),
  sendMail = sendEmail,
  log = makeLogger(),
  limiter = createInstanceRateLimiter({ limit: 5, windowMs: 60_000 }),
  globalLimiter = createInstanceRateLimiter({ limit: 60, windowMs: 60_000 }),
} = {}) {
  return async function signupHandler(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, state: 'method_not_allowed' }, { Allow: 'POST' });
    const env = getEnv();
    const dbUrl = readDatabaseUrl(env);
    const secret = readCrmSecret(env);
    if (!dbUrl || !secret) {
      log('crm_signup_unconfigured', { reason: [!dbUrl && 'DATABASE_URL', !secret && 'REVIVEX_CRM_SIGNING_SECRET'].filter(Boolean).join(',') });
      return reply(res, 503, 'unavailable');
    }
    const origin = readLinkOrigin(env);

    let body;
    try {
      assertSameOrigin(req, origin);
      body = await readJsonBody(req, BODY_LIMIT);
    } catch (e) {
      return reply(res, e instanceof HttpError ? e.status : 400, 'invalid');
    }
    if (Object.keys(body).some(k => !FIELDS.has(k))) return reply(res, 400, 'invalid');

    const ip = clientIp(req);
    const rl = limiter(rateLimitKey(ip));
    if (!rl.ok) return reply(res, 429, 'rate_limited', { 'Retry-After': String(rl.retryAfter) });
    const gl = globalLimiter('all');
    if (!gl.ok) return reply(res, 429, 'rate_limited', { 'Retry-After': String(gl.retryAfter) });

    // Honeypot: people never see or fill this field. Same answer, nothing stored.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      log('crm_signup_honeypot');
      return reply(res, 200, 'ok');
    }
    const email = normalizeEmail(body.email);
    if (!email) return reply(res, 400, 'invalid_email');
    const name = normalizeFirstName(body.firstName);
    if (!name.ok) return reply(res, 400, 'invalid_name');
    const source = SOURCES.has(body.source) ? body.source : 'site';

    const store = storeFactory(dbUrl);
    let sub;
    try {
      sub = await store.subscribe({
        email, firstName: name.value, source, consentText: SIGNUP_CONSENT_TEXT,
        utm: sanitizeAttribution(body.attribution), ipHash: hashIp(secret, rateLimitKey(ip)),
      });
    } catch (e) {
      log('crm_signup_store_error', { code: e?.code });
      return reply(res, 503, 'unavailable');
    }

    if (sub.optedIn) await sendWelcome({ env, store, sub, email, secret, origin });
    log('crm_signup_stored', { state: sub.optedIn ? 'opted_in' : 'already' });
    return reply(res, 200, 'ok');
  };

  // Best effort: the signup is already stored, so a mail failure is only logged.
  async function sendWelcome({ env, store, sub, email, secret, origin }) {
    const cfg = readEmailConfig(env);
    if (!cfg) { log('crm_welcome_unconfigured'); return; }
    const unsubscribeUrl = `${origin}/api/unsubscribe?t=${encodeURIComponent(unsubscribeToken(secret, sub.id))}`;
    const msg = renderWelcome({ firstName: sub.firstName, unsubscribeUrl, origin });
    const day = new Date().toISOString().slice(0, 10);
    try {
      const { id } = await sendMail(cfg, {
        to: email, subject: msg.subject, html: msg.html, text: msg.text,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:${SUPPORT_EMAIL}?subject=unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        tags: [{ name: 'category', value: 'welcome' }],
      }, { idempotencyKey: `subscriber-welcome/${sub.id}/${day}`, timeoutMs: 4000 });
      await store.logEmail({ subscriberId: sub.id, kind: 'welcome', resendId: id, status: 'sent' }).catch(() => {});
    } catch (e) {
      log('crm_welcome_email_error', { kind: e?.kind, status: e?.status });
      await store.logEmail({ subscriberId: sub.id, kind: 'welcome', status: 'failed', error: e?.message }).catch(() => {});
    }
  }
}

const page = (title, text, form = '') => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${title} | Revivex</title>
<style>body{margin:0;background:#F8F7F4;font-family:-apple-system,BlinkMacSystemFont,'Inter','Helvetica Neue',Arial,sans-serif;color:#0A0A0A}
main{max-width:460px;margin:12vh auto;padding:40px 32px;background:#fff;border-radius:22px;text-align:center}
img{height:16px;width:auto;margin-bottom:28px}h1{font-size:26px;font-weight:600;letter-spacing:-0.02em;margin:0 0 12px}
p{color:rgba(10,10,10,.6);line-height:1.55;margin:0 0 22px}button{height:48px;padding:0 28px;border:0;border-radius:999px;background:#0F1F38;color:#fff;font:600 15px/1 inherit;cursor:pointer}
a{color:#0F1F38}</style></head>
<body><main><img src="/assets/brand/logo-dark.png" alt="Revivex"><h1>${title}</h1><p>${text}</p>${form}<p><a href="/">Back to Revivex</a></p></main></body></html>`;

function sendPage(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.end(html);
}

// GET shows a confirm button (link scanners prefetch GETs and must not unsubscribe
// anyone); POST unsubscribes. Mail clients use POST with List-Unsubscribe=One-Click.
export function createUnsubscribeHandler({
  getEnv = () => process.env,
  storeFactory = url => createCrmStore(sqlClient(url)),
  log = makeLogger(),
  limiter = createInstanceRateLimiter({ limit: 30, windowMs: 60_000 }),
} = {}) {
  return async function unsubscribeHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return sendPage(res, 405, page('Not allowed', 'Use the link in your email.'));
    const env = getEnv();
    const secret = readCrmSecret(env);
    const dbUrl = readDatabaseUrl(env);
    const token = new URL(req.url, 'http://local').searchParams.get('t') || '';
    const id = readUnsubscribeToken(secret, token);
    if (!id) return sendPage(res, 400, page('Link not recognised', `This unsubscribe link is not valid. Email ${SUPPORT_EMAIL} and we will remove you.`));
    if (!limiter(rateLimitKey(clientIp(req))).ok) return sendPage(res, 429, page('Please wait', 'Too many attempts. Please try again in a minute.'));
    if (req.method === 'GET') {
      const action = `/api/unsubscribe?t=${encodeURIComponent(token)}`;
      return sendPage(res, 200, page('Unsubscribe', 'Stop receiving Revivex launch updates at this address?',
        `<form method="post" action="${action.replace(/"/g, '&quot;')}"><button type="submit">Unsubscribe</button></form>`));
    }
    if (!dbUrl) return sendPage(res, 503, page('Try again later', `We could not update your preferences just now. Email ${SUPPORT_EMAIL} and we will remove you.`));
    try {
      await storeFactory(dbUrl).unsubscribe(id);
    } catch (e) {
      log('crm_unsubscribe_error', { code: e?.code });
      return sendPage(res, 503, page('Try again later', `We could not update your preferences just now. Email ${SUPPORT_EMAIL} and we will remove you.`));
    }
    log('crm_unsubscribed');
    return sendPage(res, 200, page("You're unsubscribed", 'You will not receive Revivex launch updates at this address anymore. Emails about a preorder you placed still reach you.'));
  };
}
