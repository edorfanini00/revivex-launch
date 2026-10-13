// Refundable $100 preorder deposit via Stripe-hosted Checkout.
//
// GET  /api/checkout                    configuration probe only (no Stripe call; NOT
//                                       evidence that the provider accepts payments)
// POST /api/checkout {step:'start'}     issue a signed operation token (no Stripe call)
// POST /api/checkout {step:'create'}    verify merchant/price, create or replay the session
// GET  /api/reservation?session_id=     server-side deposit status for the receipt page
//
// Stripe is the deposit ledger. Nothing is fulfilled automatically (no order, shipment,
// queue position or email enrolment), so there is no webhook: the receipt page retrieves
// the session from Stripe on every view and never treats a browser return or query
// parameter as proof of payment.
import { ALLOWED_PAYMENT_METHODS, CHECKOUT_DISPLAY_NAME, DEPOSIT, KNOWN_TERMS_VERSIONS, STRIPE_CHECKOUT_ORIGIN, SUPPORT_EMAIL, parseOrigin, readCheckoutConfig, readStripeConfig } from './deposit-config.js';
import { OPERATION_MAX_AGE_S, bindingDigest, idempotencyKeyFor, issueOperation, readOperation } from './operation-token.js';
import { createStripeRestProvider, StripeCallError } from './stripe-rest.js';
import { HttpError, assertSameOrigin, clientIp, createInstanceRateLimiter, makeLogger, rateLimitKey, readJsonBody, sendJson } from './http.js';
import { createMetaCapi } from './meta-capi.js';

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
  uncertain: 'We could not confirm the checkout status. Check your card statement or banking app for a $100 Revivex payment before trying again.',
  reconcile: `We could not confirm whether your earlier checkout attempt was paid. Before reserving again, check your card statement or banking app for a $100 Revivex payment (a receipt email may not arrive). If you were charged, or are unsure, contact ${SUPPORT_EMAIL} and we will check it for you.`,
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

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// Core identity of a deposit session; shared by create and lookup.
function sessionProblem(s, cfg) {
  if (!isObj(s) || s.object !== 'checkout.session') return 'session_object';
  const m = SESSION_ID_RE.exec(String(s.id));
  if (!m || m[1] !== cfg.mode || s.livemode !== cfg.live) return 'session_mode';
  if (s.mode !== 'payment') return 'session_not_payment';
  if (s.currency !== DEPOSIT.currency || s.amount_total !== DEPOSIT.amount) return 'session_amount';
  if (!isObj(s.metadata) || s.metadata.purpose !== DEPOSIT.purpose) return 'session_metadata';
  if (!KNOWN_TERMS_VERSIONS.includes(s.metadata?.terms_version)) return 'session_terms_version';
  if (s.subscription || s.setup_intent) return 'session_extra_intent';
  return null;
}

// What the hosted page will present. Only checked before redirecting a visitor there.
function presentationProblem(s) {
  const allowed = s.allowed_payment_method_types;
  const types = s.payment_method_types;
  if (!Array.isArray(allowed) || allowed.length !== ALLOWED_PAYMENT_METHODS.length || !allowed.every(t => ALLOWED_PAYMENT_METHODS.includes(t))) return 'session_payment_methods';
  if (!Array.isArray(types) || !types.length || !types.every(t => ALLOWED_PAYMENT_METHODS.includes(t))) return 'session_payment_methods';
  if (!isObj(s.branding_settings) || s.branding_settings.display_name !== CHECKOUT_DISPLAY_NAME) return 'session_branding';
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
    // payment_method_types is rejected by API 2026-09-30.endive (seen in the TEST
    // sandbox); allowed_payment_method_types filters the dynamic set per session.
    allowed_payment_method_types: [...ALLOWED_PAYMENT_METHODS],
    branding_settings: { display_name: CHECKOUT_DISPLAY_NAME },
    adaptive_pricing: { enabled: false },
    allow_promotion_codes: false,
    submit_type: 'pay',
    success_url: `${cfg.siteOrigin}/reservation.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cfg.siteOrigin}/#reserve`,
    metadata,
    payment_intent_data: {
      description: `Revivex fully refundable preorder deposit (${DEPOSIT.termsVersion})`,
      metadata,
    },
    custom_text: {
      submit: {
        message: '$100 USD fully refundable preorder deposit for the Revivex machine, which is in development. '
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

// After the create request was sent: only a definite Stripe 4xx rejection is certain.
//  - timeout / network / unreadable 2xx body / 409 in-flight / 429: outcome unknown,
//    retrying the same key is useful (Stripe replays or finishes the saved result);
//  - 5xx: Stripe saves the 500 under the key, so every retry replays it. Go straight to
//    the bounded reconcile path instead of an endless "uncertain" loop;
//  - 400 idempotency_error: the key was used with other parameters: reconcile.
function createFailure(e) {
  if (!(e instanceof StripeCallError)) return { status: 503, state: 'uncertain' };
  if (e.kind === 'timeout' || e.kind === 'network') return { status: 503, state: 'uncertain' };
  if (!e.status || (e.status >= 200 && e.status < 300)) return { status: 503, state: 'uncertain' };
  if (e.status === 400 && e.type === 'idempotency_error') return { status: 409, state: 'reconcile' };
  if (e.status >= 500) return { status: 409, state: 'reconcile' };
  if (e.status === 409 || e.status === 429) return { status: 503, state: 'uncertain' };
  // Other 4xx: Stripe rejected the request; it did not create a session.
  return { status: 503, state: 'unavailable' };
}

const errFields = e => ({ kind: e?.kind, status: e?.status, type: e?.type, code: e?.code, param: e?.param, requestId: e?.requestId });

function reply(res, status, state, extra = {}, headers = {}) {
  sendJson(res, status, { ok: status < 300, state, message: MESSAGES[state], ...extra }, headers);
}
const send = (res, r) => reply(res, r.status, r.state, r.extra, r.headers);

// Recent create results by operation, held in this instance's memory. Bounded (least
// recently used entries go first) and time-limited; not shared across instances.
export function createReplayCache({ ttlMs = 60_000, max = 5000, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      entries.delete(key);
      if (now() - e.at >= ttlMs) return undefined;
      entries.set(key, e);
      return e.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, at: now() });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    delete(key) { entries.delete(key); },
    get size() { return entries.size; },
  };
}

// Reports an event to Meta at most once per key on this instance. The key is held while
// the send is in flight and kept only once Meta accepted the event; a skipped (GPC, no
// token, ceiling) or failed send releases it, so a later eligible request still reports.
// Never throws: measurement must not affect the response that was already sent.
function reportOnce(sent, key, send) {
  try {
    if (sent.get(key)) return;
    sent.set(key, true);
    Promise.resolve(send()).then(r => { if (r?.ok !== true) sent.delete(key); }, () => sent.delete(key));
  } catch {
    try { sent.delete(key); } catch { /* ignore */ }
  }
}

// Meta deduplicates the browser and server Purchase only within 48 hours, and a receipt
// link can be reopened at any later time, so only a deposit paid within this window is
// reported (by the server, and by the browser via the "fresh" flag).
export const PURCHASE_REPORT_WINDOW_MS = 48 * 60 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;

// When Stripe took the payment (unix seconds): the charge, else the PaymentIntent.
export function paidAtSeconds(session) {
  const pi = session?.payment_intent;
  const t = pi?.latest_charge?.created ?? pi?.created;
  return Number.isInteger(t) && t > 0 ? t : null;
}
const isFresh = (paidAt, nowMs) => paidAt !== null && nowMs - paidAt * 1000 <= PURCHASE_REPORT_WINDOW_MS && paidAt * 1000 <= nowMs + CLOCK_SKEW_MS;

// Results that stay true for the operation: a session that is complete or expired never
// changes back, and an open one is re-read before a replay is answered. Anything uncertain
// or failed is never kept, so a later replay always asks Stripe again.
const REPLAYABLE = new Set(['redirect', 'complete', 'expired']);

export function createCheckoutHandler({
  getEnv = () => process.env,
  providerFactory = defaultProviderFactory,
  log = makeLogger(),
  limiter = createInstanceRateLimiter({ limit: 20, windowMs: 60_000 }),
  // Per-instance ceiling across all callers on creates that will call Stripe (counted
  // only after the token, age and binding checks, and never for replays of an operation
  // this instance answered recently): bounds Stripe call amplification even when client
  // addresses rotate. Not shared across instances (see DEPOSIT-CHECKOUT.md). Free
  // requests (start, rejected tokens, replays) never use it up. `start` (an HMAC, no
  // Stripe call) is limited per IP only.
  globalLimiter = createInstanceRateLimiter({ limit: 120, windowMs: 60_000 }),
  // Replays of an open session re-read its state (one retrieve). This ceiling bounds
  // those reads; once used up, replays are answered from the cache alone.
  replayRefreshLimiter = createInstanceRateLimiter({ limit: 240, windowMs: 60_000 }),
  now = () => Date.now(),
  replays = createReplayCache({ now }),
  // Meta Conversions API (lib/meta-capi.js): fired after the reply, never awaited.
  metaCapi = createMetaCapi({ log }),
  // Operations this instance already reported as InitiateCheckout (replays do not resend).
  reportedCheckouts = createReplayCache({ ttlMs: OPERATION_MAX_AGE_S * 1000, now }),
} = {}) {
  // Keep only replayable results; drop the entry otherwise (including after a throw).
  function remember(key, result) {
    if (result && REPLAYABLE.has(result.state)) replays.set(key, { result });
    else replays.delete(key);
  }

  // Routes the visitor by the session's CURRENT state.
  async function currentState(provider, cfg, id) {
    let session;
    try {
      session = await provider.retrieveCheckoutSession(id);
    } catch (e) {
      // 404: Stripe says the returned session does not exist for this account, so it
      // can never be paid and nobody is sent to it. Anything else: state unknown.
      const missing = e instanceof StripeCallError && e.status === 404;
      log('deposit_session_retrieve_error', { state: missing ? 'unavailable' : 'uncertain', ...errFields(e) });
      return missing ? { status: 502, state: 'unavailable' } : { status: 503, state: 'uncertain' };
    }
    const problem = sessionProblem(session, cfg) || (session.id !== id ? 'session_id_changed' : null);
    if (problem) {
      log('deposit_session_rejected', { reason: problem });
      return { status: 502, state: 'unavailable' };
    }
    if (session.status === 'complete') {
      return { status: 200, state: 'complete', extra: { reservationUrl: `/reservation.html?session_id=${encodeURIComponent(session.id)}` }, sessionId: session.id };
    }
    if (session.status === 'expired') return { status: 410, state: 'expired', sessionId: session.id };
    const presentation = presentationProblem(session);
    if (presentation) {
      // Session exists but would show unapproved payment methods or another merchant
      // name. Never send the visitor there; it expires unpaid on its own.
      log('deposit_session_rejected', { reason: presentation });
      return { status: 502, state: 'unavailable' };
    }
    if (session.status !== 'open' || typeof session.url !== 'string' || !session.url.startsWith(`${STRIPE_CHECKOUT_ORIGIN}/`)) {
      log('deposit_session_rejected', { reason: 'session_url' });
      return { status: 502, state: 'unavailable' };
    }
    log('deposit_session_ready', { state: 'redirect' });
    return { status: 200, state: 'redirect', extra: { url: session.url }, sessionId: session.id };
  }

  async function createOrReplay(provider, cfg, op) {
    // 1. Verify the merchant account and the exact deposit price before any write.
    try {
      const [account, price] = await Promise.all([provider.getAccount(), provider.getPrice(cfg.priceId)]);
      const problem = accountProblem(account, cfg) || priceProblem(price, cfg);
      if (problem) {
        log('deposit_merchant_verification_failed', { reason: problem });
        return { status: 503, state: 'unavailable' };
      }
    } catch (e) {
      const f = preWriteFailure(e);
      log('deposit_merchant_verification_error', { state: f.state, ...errFields(e) });
      return f;
    }

    // 2. Create, or replay, the session for this operation. Stripe replays the SAVED
    //    first response for a key (the session as created), so the result only proves
    //    which session belongs to this operation, not its current state.
    let created;
    try {
      created = await provider.createCheckoutSession(checkoutSessionParams(cfg, op), idempotencyKeyFor(op));
    } catch (e) {
      const f = createFailure(e);
      log('deposit_session_create_error', { state: f.state, ...errFields(e) });
      return f;
    }
    const createdProblem = sessionProblem(created, cfg);
    if (createdProblem) {
      // Stripe returned a session that is not this deposit; never show it to anyone.
      log('deposit_session_rejected', { reason: createdProblem });
      return { status: 502, state: 'unavailable' };
    }

    // 3. Read the session's CURRENT state before routing the visitor.
    return currentState(provider, cfg, created.id);
  }

  // A replay of an operation this instance answered recently. Never uses the create
  // ceiling, so one self-issued token replayed from many addresses cannot lock anyone out.
  async function replayed(key, entry, cfg) {
    // Duplicate of a create still in flight: share its outcome (one Stripe flow).
    if (entry.pending) return entry.pending;
    const { result } = entry;
    if (result.state !== 'redirect') return result; // complete / expired are final
    // An open session can be paid at any moment, so re-read it (one retrieve: no
    // merchant re-verification, no create) and never hide a payment. If the read budget
    // is used up, answer from the cache: at worst that points this operation's holder at
    // its own session that was paid seconds ago, which cannot take a second payment.
    if (!replayRefreshLimiter('all').ok) return result;
    let fresh;
    try {
      fresh = await currentState(providerFactory(cfg), cfg, result.sessionId);
    } finally {
      remember(key, fresh);
    }
    return fresh;
  }

  return async function checkoutHandler(req, res) {
    const env = getEnv();
    if (req.method === 'GET' || req.method === 'HEAD') {
      const checkout = readCheckoutConfig(env);
      const stripe = readStripeConfig(env);
      // `configured` is a no-network configuration check, not provider readiness:
      // Stripe acceptance is only proven by a real create (see DEPOSIT-CHECKOUT.md).
      // siteOrigin lets the page refuse to offer checkout on a non-canonical host.
      return sendJson(res, 200, {
        ok: true,
        configured: checkout.ok,
        siteOrigin: checkout.ok ? checkout.config.siteOrigin : null,
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
      return reply(res, 400, 'invalid_body');
    }
    const allowed = typeof body.step === 'string' ? FIELDS.get(body.step) : undefined;
    if (!allowed) return reply(res, 400, 'invalid_step');
    if (Object.keys(body).some(k => !allowed.has(k))) return reply(res, 400, 'unexpected_field');
    if (body.termsAccepted !== true) return reply(res, 400, 'terms_required');
    if (body.termsVersion !== DEPOSIT.termsVersion) return reply(res, 409, 'terms_changed');

    const rl = limiter(rateLimitKey(clientIp(req)));
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
      return reply(res, 400, 'invalid_operation', { message: MESSAGES.reconcile, preWrite: true });
    }
    const op = read.op;
    if (op.ageS > OPERATION_MAX_AGE_S || op.binding !== bindingDigest(cfg)) {
      log('deposit_operation_reconcile', { reason: op.ageS > OPERATION_MAX_AGE_S ? 'aged' : 'binding_changed' });
      // preWrite: nothing was sent to Stripe in THIS request (the token may have been
      // used before; only the browser knows whether it ever sent it).
      return reply(res, 409, 'reconcile', { preWrite: true });
    }

    // Reply first; only an opened checkout is reported to Meta, once per operation, with
    // the operation id the browser pixel also uses as its InitiateCheckout event id.
    const finish = result => {
      send(res, result);
      if (result?.state === 'redirect') {
        reportOnce(reportedCheckouts, op.id, () => metaCapi.track(env, req, { name: 'InitiateCheckout', eventId: op.id, sourceUrl: `${cfg.siteOrigin}/`, mode: cfg.mode }));
      }
    };
    const key = idempotencyKeyFor(op);
    const seen = replays.get(key);
    if (seen) return finish(await replayed(key, seen, cfg));

    const gl = globalLimiter('all');
    if (!gl.ok) return reply(res, 429, 'rate_limited', {}, { 'Retry-After': String(gl.retryAfter) });

    const pending = createOrReplay(providerFactory(cfg), cfg, op);
    replays.set(key, { pending });
    let result;
    try {
      result = await pending;
    } finally {
      remember(key, result);
    }
    return finish(result);
  };
}

// Receipt/status lookup. Returns only state, fixed amount and a payment reference.
// "confirmed" means Stripe holds this paid, unrefunded, undisputed deposit. It is not
// an order, shipment, queue position or marketing enrolment.
export function lookupState(session, cfg) {
  try {
    return lookupStateUnsafe(session, cfg);
  } catch {
    return { state: 'not_recognized', reason: 'malformed' };
  }
}

function lookupStateUnsafe(session, cfg) {
  const problem = sessionProblem(session, cfg);
  if (problem) return { state: 'not_recognized', reason: problem };
  const items = session.line_items?.data;
  if (!Array.isArray(items) || items.length !== 1 || !isObj(items[0]) || items[0].price?.id !== cfg.priceId || items[0].quantity !== DEPOSIT.quantity) {
    return { state: 'not_recognized', reason: 'session_line_items' };
  }
  if (session.status === 'open') return { state: 'not_completed' };
  if (session.status === 'expired') return { state: 'expired' };
  if (session.status !== 'complete') return { state: 'not_recognized', reason: 'session_status' };
  if (session.payment_status !== 'paid') return { state: 'processing' };

  const pi = session.payment_intent;
  if (!isObj(pi) || pi.status !== 'succeeded' || pi.amount_received !== DEPOSIT.amount || pi.currency !== DEPOSIT.currency || pi.livemode !== cfg.live) {
    return { state: 'not_recognized', reason: 'payment_intent' };
  }
  const charge = isObj(pi.latest_charge) ? pi.latest_charge : null;
  if (!charge || charge.paid !== true || charge.status !== 'succeeded') return { state: 'not_recognized', reason: 'charge' };
  if (typeof charge.amount_refunded !== 'number' || typeof charge.refunded !== 'boolean') return { state: 'not_recognized', reason: 'charge' };
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
  // Only well-formed ids reach the limiters, and each of those calls Stripe, so this
  // ceiling already counts Stripe lookups only.
  globalLimiter = createInstanceRateLimiter({ limit: 240, windowMs: 60_000 }),
  now = () => Date.now(),
  metaCapi = createMetaCapi({ log }),
  // Paid sessions this instance already reported to Meta, so receipt reloads do not
  // resend. Meta also deduplicates by event id across instances.
  reportedPurchases = createReplayCache({ ttlMs: PURCHASE_REPORT_WINDOW_MS, now }),
} = {}) {
  // The event id uses the session id from the receipt URL, exactly as the browser pixel
  // does; event_time is the payment time.
  function reportPurchase(env, req, sessionId, session, cfg, paidAt) {
    const eventId = `deposit_${sessionId}`;
    reportOnce(reportedPurchases, eventId, () => {
      const origin = parseOrigin(typeof env.REVIVEX_SITE_ORIGIN === 'string' ? env.REVIVEX_SITE_ORIGIN.trim() : '', cfg.mode);
      const email = typeof session.customer_details?.email === 'string' ? session.customer_details.email : undefined;
      return metaCapi.track(env, req, { name: 'Purchase', eventId, sourceUrl: origin ? `${origin}/reservation.html` : undefined, email, eventTime: paidAt, mode: cfg.mode });
    });
  }

  return async function reservationHandler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, state: 'method_not_allowed' }, { Allow: 'GET' });
    const env = getEnv();
    const stripe = readStripeConfig(env);
    if (!stripe.ok) return sendJson(res, 503, { ok: false, state: 'unavailable' });
    const cfg = stripe.config;

    // The session id is only a lookup handle; every other query parameter is ignored.
    const sessionId = new URL(req.url, 'http://local').searchParams.get('session_id') || '';
    const m = SESSION_ID_RE.exec(sessionId);
    if (!m || m[1] !== cfg.mode) return sendJson(res, 404, { ok: false, state: 'not_found' });

    const rl = limiter(rateLimitKey(clientIp(req)));
    if (!rl.ok) return sendJson(res, 429, { ok: false, state: 'rate_limited' }, { 'Retry-After': String(rl.retryAfter) });
    const gl = globalLimiter('all');
    if (!gl.ok) return sendJson(res, 429, { ok: false, state: 'rate_limited' }, { 'Retry-After': String(gl.retryAfter) });

    const provider = providerFactory(cfg);
    let account, session;
    try {
      [account, session] = await Promise.all([provider.getAccount(), provider.retrieveCheckoutSession(sessionId)]);
    } catch (e) {
      if (e instanceof StripeCallError && e.status === 404) return sendJson(res, 404, { ok: false, state: 'not_found' });
      log('deposit_lookup_error', errFields(e));
      return sendJson(res, 503, { ok: false, state: 'retry' });
    }
    if (accountProblem(account, cfg) === 'account_id') {
      log('deposit_lookup_rejected', { reason: 'account_id' });
      return sendJson(res, 503, { ok: false, state: 'unavailable' });
    }
    const result = lookupState(session, cfg);
    if (result.reason) log('deposit_lookup_rejected', { reason: result.reason });
    // fresh: a confirmed deposit paid recently enough to report to Meta. Measurement only.
    const paidAt = result.state === 'confirmed' ? paidAtSeconds(session) : null;
    const fresh = isFresh(paidAt, now());
    sendJson(res, 200, {
      ok: true,
      state: result.state,
      amount: DEPOSIT.amount,
      currency: DEPOSIT.currency,
      reference: result.reference || null,
      mode: cfg.mode,
      fresh,
    });
    // Same rule as the receipt page: only a confirmed, recently paid deposit is a Purchase.
    if (fresh) reportPurchase(env, req, sessionId, session, cfg, paidAt);
  };
}
