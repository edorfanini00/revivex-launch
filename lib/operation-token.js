// Signed, server-issued checkout operation tokens. No database needed.
//
// A token is issued (no Stripe call) before the first create request and kept by the
// browser for the whole attempt. It binds:
//   - a random operation id and issue time,
//   - a digest of the merchant binding (mode, account, price, product, terms, origin),
//   - the campaign attribution accepted at issue time.
// The Stripe idempotency key and every Checkout Session parameter derive only from the
// token, so a retry always sends identical parameters. A token that is too old for
// Stripe's idempotency retention, or whose binding no longer matches the current
// configuration, is never re-sent to Stripe: the caller must reconcile instead.
import crypto from 'node:crypto';
import { CHECKOUT_PARAMS_VERSION, DEPOSIT } from './deposit-config.js';

// Stripe keeps v1 idempotency results for at least 24 hours; stop well before that.
export const OPERATION_MAX_AGE_S = 23 * 60 * 60;
const MAX_TOKEN_LENGTH = 700;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

const b64 = buf => Buffer.from(buf).toString('base64url');
const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(`rvx-op-v1.${payload}`).digest();

export function bindingDigest(cfg) {
  return crypto.createHash('sha256')
    .update([cfg.mode, cfg.accountId, cfg.priceId, cfg.productId, DEPOSIT.termsVersion, cfg.siteOrigin, CHECKOUT_PARAMS_VERSION].join('|'))
    .digest('base64url').slice(0, 32);
}

// Small allowlist from copy/measurement.md. Only these four keys, lowercase snake case,
// short. No full URLs, referrers, click ids, emails or health data are ever accepted.
const SLUG = /^[a-z0-9][a-z0-9_]{0,39}$/;
const ATTRIBUTION_RULES = {
  utm_source: v => SLUG.test(v),
  utm_medium: v => ['organic_social', 'paid_social', 'creator_social', 'email'].includes(v),
  utm_campaign: v => v === 'morning_simplified_preorder',
  utm_content: v => SLUG.test(v),
};
export function sanitizeAttribution(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, ok] of Object.entries(ATTRIBUTION_RULES)) {
    const v = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined;
    if (typeof v === 'string' && v.length <= 40 && ok(v)) out[key] = v;
  }
  return out;
}

export function issueOperation(cfg, { now, attribution }) {
  const payload = b64(JSON.stringify({
    v: 1,
    id: b64(crypto.randomBytes(16)),
    iat: Math.floor(now() / 1000),
    b: bindingDigest(cfg),
    a: sanitizeAttribution(attribution),
  }));
  return `${payload}.${b64(sign(cfg.operationSecret, payload))}`;
}

// Returns { ok: true, op } or { ok: false, reason }. Signature is checked before parsing.
export function readOperation(token, secret, nowMs) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payload, mac] = parts;
  // Compare canonical encodings so only one string form of a MAC is ever accepted.
  const expected = Buffer.from(b64(sign(secret, payload)));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };
  let op;
  try { op = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (!op || op.v !== 1 || !ID_RE.test(op.id) || !Number.isInteger(op.iat) || typeof op.b !== 'string') return { ok: false, reason: 'malformed' };
  const nowS = Math.floor(nowMs / 1000);
  if (op.iat > nowS + 60) return { ok: false, reason: 'future' };
  // Re-sanitise so a token can never carry more than the allowlist.
  const a = sanitizeAttribution(op.a);
  if (JSON.stringify(a) !== JSON.stringify(op.a || {})) return { ok: false, reason: 'malformed' };
  return { ok: true, op: { id: op.id, iat: op.iat, binding: op.b, attribution: a, ageS: nowS - op.iat } };
}

export function idempotencyKeyFor(op) {
  const digest = crypto.createHash('sha256').update(`${op.binding}|${op.id}`).digest('hex');
  return `rvx-deposit-v1-${digest.slice(0, 48)}`;
}
