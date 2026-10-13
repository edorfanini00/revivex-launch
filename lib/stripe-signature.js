// Stripe webhook signature check (Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]).
// HMAC-SHA256 over `${t}.${raw body}` with the endpoint secret, compared in constant
// time against every v1 entry; timestamps outside the tolerance are rejected.
import crypto from 'node:crypto';

export const SIGNATURE_TOLERANCE_S = 300;

export function signPayload(secret, timestamp, raw) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
}

// Returns { ok: true } or { ok: false, reason }.
export function verifyStripeSignature(raw, header, secret, { nowS = Math.floor(Date.now() / 1000), toleranceS = SIGNATURE_TOLERANCE_S } = {}) {
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (typeof header !== 'string' || !header || header.length > 2048) return { ok: false, reason: 'missing_header' };
  let t = null;
  const v1 = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (t === null || !v1.length) return { ok: false, reason: 'malformed_header' };
  const expected = Buffer.from(signPayload(secret, t, raw), 'hex');
  const match = v1.some(sig => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!match) return { ok: false, reason: 'signature' };
  if (Math.abs(nowS - t) > toleranceS) return { ok: false, reason: 'timestamp' };
  return { ok: true, timestamp: t };
}

// Test helper: builds a header Stripe would send.
export function signatureHeader(secret, raw, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${signPayload(secret, timestamp, raw)}`;
}
