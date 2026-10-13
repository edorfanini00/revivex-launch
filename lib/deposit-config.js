// Refundable preorder deposit: fixed terms and environment configuration.
// Everything money-related is a server constant; the browser never supplies amount,
// currency, price, quantity or redirect URLs. Missing or inconsistent configuration
// fails closed before any request to Stripe.

export const DEPOSIT = Object.freeze({
  amount: 10000, // minor units: $100.00
  currency: 'usd',
  quantity: 1,
  purpose: 'revivex_preorder_deposit',
  termsVersion: 'deposit-terms-v2',
});

// Terms versions whose completed deposits the receipt page recognises.
// v1 (never used for a real payment) carried an unapproved refund cutoff and was
// replaced by v2; v1 stays recognised so any historical session still reads correctly.
export const KNOWN_TERMS_VERSIONS = Object.freeze(['deposit-terms-v1', 'deposit-terms-v2']);

// Scoped per-session Checkout controls (no merchant-wide Stripe settings are changed).
// allowed_payment_method_types filters Stripe's dynamic methods to cards only (cards
// include Apple Pay / Google Pay wallets); the hosted header shows this display name.
export const ALLOWED_PAYMENT_METHODS = Object.freeze(['card']);
export const CHECKOUT_DISPLAY_NAME = 'Revivex';
// Bumped whenever the Checkout Session parameters change so older operation tokens
// reconcile instead of hitting a Stripe idempotency parameter mismatch.
export const CHECKOUT_PARAMS_VERSION = 'params-v2';

// Official Revivex support address published on healthrevivex.com (contact, terms and
// privacy pages). Used as the refund contact on this site.
export const SUPPORT_EMAIL = 'support@revivex.store';

export const STRIPE_API_VERSION = '2026-09-30.endive';
export const STRIPE_CHECKOUT_ORIGIN = 'https://checkout.stripe.com';

const KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,250}$/;
const ACCOUNT_RE = /^acct_[A-Za-z0-9]{6,64}$/;
const PRICE_RE = /^price_[A-Za-z0-9]{6,64}$/;
const PRODUCT_RE = /^prod_[A-Za-z0-9]{6,64}$/;

const clean = v => (typeof v === 'string' ? v.trim() : '');

export function parseOrigin(raw, mode) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol === 'https:') return u.origin;
  // Plain HTTP only for a loopback harness in test mode.
  if (u.protocol === 'http:' && local && mode === 'test') return u.origin;
  return null;
}

// Stripe access needed to look up existing deposits (receipt/status page).
export function readStripeConfig(env = process.env) {
  const problems = [];
  const mode = clean(env.STRIPE_MODE);
  const secretKey = clean(env.STRIPE_SECRET_KEY);
  const accountId = clean(env.STRIPE_EXPECTED_ACCOUNT_ID);
  const priceId = clean(env.STRIPE_DEPOSIT_PRICE_ID);
  const productId = clean(env.STRIPE_DEPOSIT_PRODUCT_ID);

  if (mode !== 'test' && mode !== 'live') problems.push('STRIPE_MODE');
  const key = KEY_RE.exec(secretKey);
  if (!key) problems.push('STRIPE_SECRET_KEY');
  else if (key[2] !== mode) problems.push('STRIPE_SECRET_KEY_MODE_MISMATCH');
  if (!ACCOUNT_RE.test(accountId)) problems.push('STRIPE_EXPECTED_ACCOUNT_ID');
  if (!PRICE_RE.test(priceId)) problems.push('STRIPE_DEPOSIT_PRICE_ID');
  if (!PRODUCT_RE.test(productId)) problems.push('STRIPE_DEPOSIT_PRODUCT_ID');

  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { mode, live: mode === 'live', secretKey, accountId, priceId, productId } };
}

// Everything required before a new deposit may be taken.
export function readCheckoutConfig(env = process.env) {
  const stripe = readStripeConfig(env);
  const problems = stripe.ok ? [] : [...stripe.problems];
  const mode = clean(env.STRIPE_MODE);

  if (clean(env.REVIVEX_CHECKOUT_ENABLED) !== 'true') problems.push('REVIVEX_CHECKOUT_ENABLED');
  const siteOrigin = parseOrigin(clean(env.REVIVEX_SITE_ORIGIN), mode);
  if (!siteOrigin) problems.push('REVIVEX_SITE_ORIGIN');
  // HMAC key for the signed checkout operation tokens (lib/operation-token.js).
  const operationSecret = typeof env.REVIVEX_OPERATION_SIGNING_SECRET === 'string' ? env.REVIVEX_OPERATION_SIGNING_SECRET : '';
  // Length plus a crude variety check; the runbook requires `openssl rand -base64 48`.
  if (operationSecret.length < 32 || new Set(operationSecret).size < 10) problems.push('REVIVEX_OPERATION_SIGNING_SECRET');
  // Live money additionally needs an explicit sign-off naming the exact terms version
  // (terms, merchant identity, refund handling and tax/jurisdiction review approved).
  if (mode === 'live' && clean(env.REVIVEX_LIVE_APPROVED_TERMS_VERSION) !== DEPOSIT.termsVersion) {
    problems.push('REVIVEX_LIVE_APPROVED_TERMS_VERSION');
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { ...stripe.config, siteOrigin, operationSecret } };
}
