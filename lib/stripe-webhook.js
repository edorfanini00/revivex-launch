// POST /api/stripe-webhook: Stripe is the source of truth for paid deposits.
//
// 1. Read the raw body (bounded) and verify Stripe-Signature before parsing anything.
// 2. Record the event id (webhook_events) so a redelivered, already processed event is
//    acknowledged without work.
// 3. Treat the event as a trigger only: retrieve the Checkout Session from Stripe and
//    derive the preorder state with the same rules as the receipt page (lookupState),
//    so events arriving out of order or twice always converge on Stripe's current state.
// 4. Upsert the preorder, merge the customer into subscribers (transactional only), and
//    for a newly paid preorder send the confirmation email exactly once (claim, send with
//    an Idempotency-Key, record; release the claim on failure and answer 500 so Stripe
//    retries).
// Anything that is not a Revivex deposit is acknowledged and ignored.
import { DEPOSIT, readStripeConfig } from './deposit-config.js';
import { lookupState, paidAtSeconds } from './deposit-handlers.js';
import { createStripeRestProvider, StripeCallError } from './stripe-rest.js';
import { makeLogger, sendJson } from './http.js';
import { readDatabaseUrl, readEmailConfig, readLinkOrigin, readWebhookSecret } from './crm-config.js';
import { sqlClient } from './db.js';
import { createCrmStore } from './crm-store.js';
import { verifyStripeSignature } from './stripe-signature.js';
import { sanitizeAttribution } from './operation-token.js';
import { renderPreorderConfirmation } from './email/index.js';
import { sendEmail } from './resend.js';
import { greetingName } from './email/shared.js';

export const WEBHOOK_BODY_LIMIT = 512 * 1024;
export const HANDLED_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'charge.refunded',
  'charge.dispute.created',
]);
const CHECKOUT_EVENTS = new Set(HANDLED_EVENTS.slice(0, 2));
const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{8,250}$/;
const PI_RE = /^pi_[A-Za-z0-9]{8,250}$/;
const STATUS_FOR_STATE = { confirmed: 'paid', refunded: 'refunded', partially_refunded: 'partially_refunded', disputed: 'disputed' };

export class RawBodyError extends Error {
  constructor(status, state) { super(state); this.status = status; this.state = state; }
}

// Raw bytes exactly as Stripe sent them. A body that a framework already parsed into an
// object cannot be verified and is refused.
export async function readRawBody(req, limit = WEBHOOK_BODY_LIMIT) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new RawBodyError(413, 'payload_too_large');
  let raw = Buffer.alloc(0);
  if (!req.readableEnded && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new RawBodyError(413, 'payload_too_large');
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks);
  }
  if (!raw.length) {
    let pre;
    try { pre = req.body; } catch { throw new RawBodyError(400, 'invalid_body'); }
    if (Buffer.isBuffer(pre)) raw = pre;
    else if (typeof pre === 'string') raw = Buffer.from(pre, 'utf8');
    else if (pre !== undefined && pre !== null) throw new RawBodyError(400, 'raw_body_unavailable');
  }
  if (raw.length > limit) throw new RawBodyError(413, 'payload_too_large');
  return raw;
}

// The fields kept for a preorder. Contact details come from Checkout, with the charge's
// billing details as a fallback.
export function preorderFromSession(session, status, { origin = 'webhook', notes = null, eventAt = null } = {}) {
  const cd = session.customer_details || {};
  const pi = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const billing = pi?.latest_charge?.billing_details || {};
  const address = cd.address || billing.address || {};
  const paidAt = paidAtSeconds(session);
  const utm = sanitizeAttribution(session.metadata);
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  return {
    sessionId: session.id,
    paymentIntent: pi?.id || (typeof session.payment_intent === 'string' ? session.payment_intent : null),
    livemode: session.livemode === true,
    email: str(cd.email, 254) || str(billing.email, 254),
    name: str(cd.name, 200) || str(billing.name, 200),
    phone: str(cd.phone, 40),
    amountCents: session.amount_total,
    currency: session.currency,
    status,
    country: str(address.country, 2),
    postalCode: str(address.postal_code, 20),
    utm: Object.keys(utm).length ? utm : null,
    operationId: str(session.metadata?.operation, 64),
    origin,
    notes,
    paidAt: paidAt ? new Date(paidAt * 1000).toISOString() : null,
    eventAt,
  };
}

const errFields = e => ({ kind: e?.kind, status: e?.status, code: e?.code, type: e?.type, requestId: e?.requestId });

export function createStripeWebhookHandler({
  getEnv = () => process.env,
  providerFactory = cfg => createStripeRestProvider({ secretKey: cfg.secretKey }),
  storeFactory = url => createCrmStore(sqlClient(url)),
  sendMail = sendEmail,
  log = makeLogger(),
  nowS = () => Math.floor(Date.now() / 1000),
} = {}) {
  // Which Checkout Session an event is about, or null when it is not a deposit.
  async function sessionIdFor(event, provider, store) {
    const obj = event.data?.object || {};
    if (CHECKOUT_EVENTS.has(event.type)) {
      if (obj.metadata?.purpose !== DEPOSIT.purpose || obj.mode !== 'payment') return null;
      return SESSION_ID_RE.test(String(obj.id)) ? obj.id : null;
    }
    if (obj.currency && obj.currency !== DEPOSIT.currency) return null;
    if (event.type === 'charge.refunded' && obj.amount !== DEPOSIT.amount) return null;
    const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
    if (!PI_RE.test(String(pi))) return null;
    const known = await store.findPreorderByPaymentIntent(pi);
    if (known) return known;
    const list = await provider.listCheckoutSessions([['payment_intent', pi], ['limit', '1']]);
    const s = list?.data?.[0];
    return s && s.metadata?.purpose === DEPOSIT.purpose && SESSION_ID_RE.test(String(s.id)) ? s.id : null;
  }

  async function sendConfirmation(store, row, env) {
    const emailCfg = readEmailConfig(env);
    if (!emailCfg) return 'email_unconfigured';
    const claim = await store.claimConfirmation(row.id);
    if (!claim) return 'email_already_handled';
    if (!claim.email) {
      await store.releaseConfirmation(row.id);
      return 'email_missing_address';
    }
    const msg = renderPreorderConfirmation({
      sessionId: claim.stripe_session_id, email: claim.email, name: claim.name, paidAt: claim.paid_at,
      amountCents: claim.amount_cents, currency: claim.currency, origin: readLinkOrigin(env),
    });
    try {
      const { id } = await sendMail(emailCfg, {
        to: claim.email, subject: msg.subject, html: msg.html, text: msg.text,
        tags: [{ name: 'category', value: 'preorder_confirmation' }],
      }, { idempotencyKey: `preorder-confirmation/${claim.stripe_session_id}` });
      await store.completeConfirmation(row.id, id);
      await store.logEmail({ preorderId: row.id, kind: 'preorder_confirmation', resendId: id, status: 'sent' }).catch(() => {});
      return 'email_sent';
    } catch (e) {
      await store.releaseConfirmation(row.id);
      await store.logEmail({ preorderId: row.id, kind: 'preorder_confirmation', status: 'failed', error: e?.message }).catch(() => {});
      log('crm_confirmation_email_error', { kind: e?.kind, status: e?.status });
      const err = new Error('email_failed');
      err.retry = true;
      throw err;
    }
  }

  async function process(event, cfg, store, env) {
    const provider = providerFactory(cfg);
    const sessionId = await sessionIdFor(event, provider, store);
    if (!sessionId) return 'ignored_not_deposit';
    if (!sessionId.startsWith(`cs_${cfg.mode}_`)) return 'ignored_mode';
    let session;
    try {
      session = await provider.retrieveCheckoutSession(sessionId);
    } catch (e) {
      if (e instanceof StripeCallError && e.status === 404) return 'ignored_session_missing';
      throw e;
    }
    const state = lookupState(session, cfg);
    const status = STATUS_FOR_STATE[state.state];
    if (!status) {
      if (state.reason) log('crm_webhook_session_rejected', { reason: state.reason });
      return `ignored_${state.state}`;
    }
    const eventAt = Number.isInteger(event.created) ? new Date(event.created * 1000).toISOString() : null;
    const row = await store.upsertPreorder(preorderFromSession(session, status, { eventAt }));
    await store.mergeCustomer({ email: row.email, firstName: greetingName(row.name) || null });
    if (CHECKOUT_EVENTS.has(event.type) && row.status === 'paid' && row.origin === 'webhook' && !row.confirmation_sent_at) {
      return sendConfirmation(store, row, env);
    }
    return `stored_${row.status}`;
  }

  return async function stripeWebhookHandler(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false }, { Allow: 'POST' });
    const env = getEnv();
    const secret = readWebhookSecret(env);
    const stripe = readStripeConfig(env);
    const dbUrl = readDatabaseUrl(env);
    if (!secret || !stripe.ok || !dbUrl) {
      log('crm_webhook_unconfigured', { reason: [!secret && 'STRIPE_WEBHOOK_SECRET', !stripe.ok && 'STRIPE', !dbUrl && 'DATABASE_URL'].filter(Boolean).join(',') });
      return sendJson(res, 503, { ok: false });
    }

    let raw;
    try {
      raw = await readRawBody(req);
    } catch (e) {
      return sendJson(res, e.status || 400, { ok: false });
    }
    const sig = verifyStripeSignature(raw, req.headers['stripe-signature'], secret, { nowS: nowS() });
    if (!sig.ok) {
      log('crm_webhook_signature_rejected', { reason: sig.reason });
      return sendJson(res, 400, { ok: false });
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { ok: false }); }
    if (!event || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]{8,250}$/.test(event.id) || typeof event.type !== 'string') {
      return sendJson(res, 400, { ok: false });
    }
    if (!HANDLED_EVENTS.includes(event.type)) return sendJson(res, 200, { ok: true, outcome: 'ignored_type' });
    if (event.livemode !== stripe.config.live) return sendJson(res, 200, { ok: true, outcome: 'ignored_mode' });

    const store = storeFactory(dbUrl);
    try {
      const begun = await store.beginEvent(event);
      if (begun.processed) return sendJson(res, 200, { ok: true, outcome: 'duplicate' });
      const outcome = await process(event, stripe.config, store, env);
      await store.finishEvent(event.id, outcome);
      log('crm_webhook_processed', { type: event.type, state: outcome });
      return sendJson(res, 200, { ok: true, outcome });
    } catch (e) {
      // Not recorded as processed, so Stripe's retry runs it again (idempotently).
      // Error text can echo row values, so only a category and codes are logged.
      log('crm_webhook_error', { type: event.type, reason: e?.retry ? 'email_failed' : e instanceof StripeCallError ? 'stripe' : 'store', ...errFields(e) });
      return sendJson(res, 500, { ok: false });
    }
  };
}
