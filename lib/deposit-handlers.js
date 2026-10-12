// Refundable $100 preorder deposit via Stripe-hosted Checkout.
//
// GET  /api/checkout                    public availability (no Stripe call)
// POST /api/checkout {step:'start'}     issue a signed operation token (no Stripe call)
// POST /api/checkout {step:'create'}    verify merchant/price, create or replay the session
// GET  /api/reservation?session_id=     server-side deposit status for the receipt page
//
// Stripe is the deposit ledger. Nothing is fulfilled automatically (no order, shipment,
// queue position or email enrolment), so there is no webhook: the receipt page retrieves
// the session from Stripe on every view and never treats a browser return or query
// parameter as proof of payment.
import { DEPOSIT, KNOWN_TERMS_VERSIONS, STRIPE_CHECKOUT_ORIGIN, SUPPORT_EMAIL, readCheckoutConfig, readStripeConfig } from './deposit-config.js';
import { OPERATION_MAX_AGE_S, bindingDigest, idempotencyKeyFor, issueOperation, readOperation } from './operation-token.js';
import { createStripeRestProvider, StripeCallError } from './stripe-rest.js';
import { HttpError, assertSameOrigin, clientIp, createInstanceRateLimiter, makeLogger, readJsonBody, sendJson } from './http.js';

const BODY_LIMIT = 2048;
const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{8,250}$/;
const FIELDS = new Map([
  ['start', new Set(['step', 'termsAccepted', 'termsVersion', 'attribution'])],
  ['create', new Set(['step', 'operation', 'termsAccepted', 'termsVersion'])],
]);

const defaultProviderFactory = cfg => createStripeRestProvider({ secretKey: cfg.secretKey });

// Messages distinguish requests that certainly did not open a checkout page from
// requests whose outcome is unknown. Neither claims anything about other attempts.
export const MESSAGES = {
  unavailable: 'Reservations are temporarily unavailable. This request did not open a checkout page.',
  retry: 'Checkout could not be opened just now. This request did not open a checkout page. Please try again.',
  uncertain: 'We could not confirm the checkout status. Check your payment confirmation before trying again.',
  reconcile: `We could not confirm the status of your earlier checkout attempt. Check your email for a Stripe receipt before reserving again. If you were charged and need help, contact ${SUPPORT_EMAIL}.`,
  expired: 'That checkout page expired without a payment. Press the button again to start a new one.',
  terms_changed: 'The deposit terms have been updated. Please reload the page and review them.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
};

export function priceProblem(price, cfg) {
  if (!price || price.object !== 'price' || price.id !== cfg.priceId) return 'price_id';
  if (price.livemode !== cfg.live) return 'price_mode';
  if (price.active !== true) return 'price_inactive';
  if (price.type !== 'one_time' || price.recurring) return 'price_not_one_time';
  if (price.billing_scheme !== 'per_unit' || price.custom_unit_amount || price.transform_quantity) return 'price_scheme';
  if (price.currency !== DEPOSIT.currency) return 'price_currency';
  if (price.unit_amount !== DEPOSIT.amount) return 'price_amount';
  const extraCurrencies = Object.keys(price.currency_options || {}).filter(c => c !== DEPOSIT.currency);
  if (extraCurrencies.length) return 'price_multi_currency';
  const product = price.product && typeof price.product === 'object' ? price.product : null;
  if (!product || product.id !== cfg.productId) return 'product_id';
  if (product.active !== true) return 'product_inactive';
  return null;
}

export function accountProblem(account, cfg) {
  if (!account || account.id !== cfg.accountId) return 'account_id';
  if (account.charges_enabled !== true) return 'charges_disabled';
  return null;
}

// Core identity of a deposit session; shared by create and lookup.
function sessionProblem(s, cfg) {
  if (!s || s.object !== 'checkout.session') return 'session_object';
  const m = SESSION_ID_RE.exec(String(s.id));
  if (!m || m[1] !== cfg.mode || s.livemode !== cfg.live) return 'session_mode';
  if (s.mode !== 'payment') return 'session_not_payment';
  if (s.currency !== DEPOSIT.currency || s.amount_total !== DEPOSIT.amount) return 'session_amount';
  if (s.metadata?.purpose !== DEPOSIT.purpose) return 'session_metadata';
  if (!KNOWN_TERMS_VERSIONS.includes(s.metadata?.terms_version)) return 'session_terms_version';
  if (s.subscription || s.setup_intent) return 'session_extra_intent';
  return null;
}

// All parameters derive from the verified token plus the (binding-checked) config, so
// a retry of the same operation sends byte-identical parameters.
export function checkoutSessionParams(cfg, op) {
  const metadata = {
    purpose: DEPOSIT.purpose,
    terms_version: DEPOSIT.termsVersion,
    operation: idempotencyKeyFor(op).slice(-16),
    ...op.attribution,
  };
  return {
    mode: 'payment',
    line_items: [{ price: cfg.priceId, quantity: DEPOSIT.quantity }],
    payment_method_types: ['card'],
    adaptive_pricing: { enabled: false },
    allow_promotion_codes: false,
    submit_type: 'pay',
    success_url: `${cfg.siteOrigin}/reservation.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cfg.siteOrigin}/#reserve`,
    metadata,
    payment_intent_data: {
      description: `Revivex refundable preorder deposit (${DEPOSIT.termsVersion})`,
      metadata,
    },
    custom_text: {
      submit: {
        message: '$100 USD refundable preorder deposit for the Revivex machine, which is in development. '
          + 'Applied to the final machine price. No automatic balance charge. '
          + 'The final price and shipping date have not been announced.',
      },
    },
  };
}

// Before any write: a failure is either transient (safe to retry) or a stop.
function preWriteFailure(e) {
  if (e instanceof StripeCallError && (e.kind === 'timeout' || e.kind === 'network' || e.status === 429 || e.status >= 500)) return { status: 503, state: 'retry' };
  return { status: 503, state: 'unavailable' };
}

// After the create request was sent: only a definite Stripe rejection is certain.
function createFailure(e) {
  if (!(e instanceof StripeCallError)) return { status: 503, state: 'uncertain' };
  if (e.kind === 'timeout' || e.kind === 'network') return { status: 503, state: 'uncertain' };
  if (e.status === 400 && e.type === 'idempotency_error') return { status: 409, state: 'reconcile' };
  if (e.status === 409 || e.status === 429 || e.status >= 500) return { status: 503, state: 'uncertain' };
  // Other 4xx: Stripe rejected the request; it did not create a session.
  return { status: 503, state: 'unavailable' };
}

function reply(res, status, state, extra = {}, headers = {}) {
  sendJson(res, status, { ok: status < 300, state, message: MESSAGES[state], ...extra }, headers);
}

export function createCheckoutHandler({
  getEnv = () => process.env,
  providerFactory = defaultProviderFactory,
  log = makeLogger(),
  limiter = createInstanceRateLimiter({ limit: 20, windowMs: 60_000 }),
  now = () => Date.now(),
} = {}) {
  return async function checkoutHandler(req, res) {
    const env = getEnv();
    if (req.method === 'GET' || req.method === 'HEAD') {
      const checkout = readCheckoutConfig(env);
      const stripe = readStripeConfig(env);
      return sendJson(res, 200, {
        ok: true,
        available: checkout.ok,
        mode: stripe.ok ? stripe.config.mode : null,
        amount: DEPOSIT.amount,
        currency: DEPOSIT.currency,
        termsVersion: DEPOSIT.termsVersion,
        supportEmail: SUPPORT_EMAIL,
      });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, state: 'method_not_allowed' }, { Allow: 'GET, HEAD, POST' });

    const checkout = readCheckoutConfig(env);
    if (!checkout.ok) {
      log('deposit_checkout_unavailable', { reason: checkout.problems.join(',') });
      return reply(res, 503, 'unavailable');
    }
    const cfg = checkout.config;

    let body;
    try {
      assertSameOrigin(req, cfg.siteOrigin);
      body = await readJsonBody(req, BODY_LIMIT);
    } catch (e) {
      if (e instanceof HttpError) return reply(res, e.status, e.state);
      throw e;
    }
    const allowed = typeof body.step === 'string' ? FIELDS.get(body.step) : undefined;
    if (!allowed) return reply(res, 400, 'invalid_step');
    if (Object.keys(body).some(k => !allowed.has(k))) return reply(res, 400, 'unexpected_field');
    if (body.termsAccepted !== true) return reply(res, 400, 'terms_required');
    if (body.termsVersion !== DEPOSIT.termsVersion) return reply(res, 409, 'terms_changed');

    const rl = limiter(clientIp(req));
    if (!rl.ok) return reply(res, 429, 'rate_limited', {}, { 'Retry-After': String(rl.retryAfter) });

    if (body.step === 'start') {
      return reply(res, 200, 'started', { operation: issueOperation(cfg, { now, attribution: body.attribution }) });
    }

    // create: the token must be authentic, young enough for Stripe idempotency, and
    // bound to exactly the current merchant/price/terms/origin. Otherwise reconcile;
    // never re-key or re-parameterise an attempt whose outcome may be unknown.
    const read = readOperation(body.operation, cfg.operationSecret, now());
    if (!read.ok) {
      log('deposit_operation_rejected', { reason: read.reason });
      return reply(res, 400, 'invalid_operation', { message: MESSAGES.reconcile });
    }
    const op = read.op;
    if (op.ageS > OPERATION_MAX_AGE_S || op.binding !== bindingDigest(cfg)) {
      log('deposit_operation_reconcile', { reason: op.ageS > OPERATION_MAX_AGE_S ? 'aged' : 'binding_changed' });
      return reply(res, 409, 'reconcile');
    }

    const provider = providerFactory(cfg);

    // 1. Verify the merchant account and the exact deposit price before any write.
    try {
      const [account, price] = await Promise.all([provider.getAccount(), provider.getPrice(cfg.priceId)]);
      const problem = accountProblem(account, cfg) || priceProblem(price, cfg);
      if (problem) {
        log('deposit_merchant_verification_failed', { reason: problem });
        return reply(res, 503, 'unavailable');
      }
    } catch (e) {
      const f = preWriteFailure(e);
      log('deposit_merchant_verification_error', { state: f.state, kind: e.kind, status: e.status, type: e.type, code: e.code, requestId: e.requestId });
      return reply(res, f.status, f.state);
    }

    // 2. Create, or replay, the session for this operation.
    let session;
    try {
      session = await provider.createCheckoutSession(checkoutSessionParams(cfg, op), idempotencyKeyFor(op));
    } catch (e) {
      const f = createFailure(e);
      log('deposit_session_create_error', { state: f.state, kind: e.kind, status: e.status, type: e.type, code: e.code, requestId: e.requestId });
      return reply(res, f.status, f.state);
    }

    const problem = sessionProblem(session, cfg);
    if (problem) {
      log('deposit_session_rejected', { reason: problem });
      return reply(res, 502, 'unavailable');
    }
    if (session.status === 'complete') {
      return reply(res, 200, 'complete', { reservationUrl: `/reservation.html?session_id=${encodeURIComponent(session.id)}` });
    }
    if (session.status === 'expired') return reply(res, 410, 'expired');
    if (session.status !== 'open' || typeof session.url !== 'string' || !session.url.startsWith(`${STRIPE_CHECKOUT_ORIGIN}/`)) {
      log('deposit_session_rejected', { reason: 'session_url' });
      return reply(res, 502, 'unavailable');
    }
    log('deposit_session_ready', { state: 'redirect' });
    return reply(res, 200, 'redirect', { url: session.url });
  };
}

// Receipt/status lookup. Returns only state, fixed amount and a payment reference.
// "confirmed" means Stripe holds this paid, unrefunded, undisputed deposit. It is not
// an order, shipment, queue position or marketing enrolment.
export function lookupState(session, cfg) {
  const problem = sessionProblem(session, cfg);
  if (problem) return { state: 'not_recognized', reason: problem };
  const items = session.line_items?.data;
  if (!Array.isArray(items) || items.length !== 1 || items[0].price?.id !== cfg.priceId || items[0].quantity !== DEPOSIT.quantity) {
    return { state: 'not_recognized', reason: 'session_line_items' };
  }
  if (session.status === 'open') return { state: 'not_completed' };
  if (session.status === 'expired') return { state: 'expired' };
  if (session.status !== 'complete') return { state: 'not_recognized', reason: 'session_status' };
  if (session.payment_status !== 'paid') return { state: 'processing' };

  const pi = session.payment_intent;
  if (!pi || typeof pi !== 'object' || pi.status !== 'succeeded' || pi.amount_received !== DEPOSIT.amount || pi.currency !== DEPOSIT.currency || pi.livemode !== cfg.live) {
    return { state: 'not_recognized', reason: 'payment_intent' };
  }
  const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  if (!charge || charge.paid !== true || charge.status !== 'succeeded') return { state: 'not_recognized', reason: 'charge' };
  const reference = pi.id;
  if (charge.disputed === true) return { state: 'disputed', reference };
  if (charge.refunded === true) return { state: 'refunded', reference };
  if (charge.amount_refunded > 0) return { state: 'partially_refunded', reference };
  return { state: 'confirmed', reference };
}

export function createReservationHandler({
  getEnv = () => process.env,
  providerFactory = defaultProviderFactory,
  log = makeLogger(),
  limiter = createInstanceRateLimiter({ limit: 30, windowMs: 60_000 }),
} = {}) {
  return async function reservationHandler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, state: 'method_not_allowed' }, { Allow: 'GET' });
    const stripe = readStripeConfig(getEnv());
    if (!stripe.ok) return sendJson(res, 503, { ok: false, state: 'unavailable' });
    const cfg = stripe.config;

    // The session id is only a lookup handle; every other query parameter is ignored.
    const sessionId = new URL(req.url, 'http://local').searchParams.get('session_id') || '';
    const m = SESSION_ID_RE.exec(sessionId);
    if (!m || m[1] !== cfg.mode) return sendJson(res, 404, { ok: false, state: 'not_found' });

    const rl = limiter(clientIp(req));
    if (!rl.ok) return sendJson(res, 429, { ok: false, state: 'rate_limited' }, { 'Retry-After': String(rl.retryAfter) });

    const provider = providerFactory(cfg);
    let account, session;
    try {
      [account, session] = await Promise.all([provider.getAccount(), provider.retrieveCheckoutSession(sessionId)]);
    } catch (e) {
      if (e instanceof StripeCallError && e.status === 404) return sendJson(res, 404, { ok: false, state: 'not_found' });
      log('deposit_lookup_error', { kind: e.kind, status: e.status, type: e.type, code: e.code, requestId: e.requestId });
      return sendJson(res, 503, { ok: false, state: 'retry' });
    }
    if (accountProblem(account, cfg) === 'account_id') {
      log('deposit_lookup_rejected', { reason: 'account_id' });
      return sendJson(res, 503, { ok: false, state: 'unavailable' });
    }
    const result = lookupState(session, cfg);
    if (result.reason) log('deposit_lookup_rejected', { reason: result.reason });
    return sendJson(res, 200, {
      ok: true,
      state: result.state,
      amount: DEPOSIT.amount,
      currency: DEPOSIT.currency,
      reference: result.reference || null,
      mode: cfg.mode,
    });
  };
}
