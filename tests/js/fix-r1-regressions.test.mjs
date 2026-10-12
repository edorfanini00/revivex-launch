// Fix round 1 regressions for findings in checkout/reviews/{security,correctness}-r1.md
// and checkout/sandbox/RESULT.md. LOCAL/MOCK: the provider is the Stripe-faithful
// SYNTHETIC fake (saved first responses incl. 500s, endive param rejection), not Stripe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { createCheckoutHandler, createReservationHandler, checkoutSessionParams, lookupState, MESSAGES } from '../../lib/deposit-handlers.js';
import { readCheckoutConfig, DEPOSIT, KNOWN_TERMS_VERSIONS } from '../../lib/deposit-config.js';
import { readOperation } from '../../lib/operation-token.js';
import { createInstanceRateLimiter, makeLogger } from '../../lib/http.js';
import { createStripeRestProvider } from '../../lib/stripe-rest.js';
import { createSyntheticStripe } from '../fixtures/synthetic-provider.mjs';
import { ENV, ORIGIN, SIGNING, req, res, logSink, paidSession } from '../fixtures/deposit-fixtures.mjs';

const TV = DEPOSIT.termsVersion;
const ROOT = new URL('../../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, ROOT), 'utf8');

function setup({ env = ENV, now } = {}) {
  const synth = createSyntheticStripe({ accountId: ENV.STRIPE_EXPECTED_ACCOUNT_ID, priceId: ENV.STRIPE_DEPOSIT_PRICE_ID, productId: ENV.STRIPE_DEPOSIT_PRODUCT_ID });
  const sink = logSink();
  const deps = { getEnv: () => env, providerFactory: () => synth.provider, log: makeLogger(sink), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }), ...(now ? { now } : {}) };
  return { synth, sink, checkout: createCheckoutHandler(deps), reservation: createReservationHandler(deps) };
}
async function call(h, body, opts = {}) { const r = res(); await h(req({ body, ...opts }), r); return r; }
const startBody = o => ({ step: 'start', termsAccepted: true, termsVersion: TV, ...o });
const createBody = op => ({ step: 'create', operation: op, termsAccepted: true, termsVersion: TV });
async function start(s) { const r = await call(s.checkout, startBody()); assert.equal(r.json().state, 'started', r.body); return r.json().operation; }

// ---- security F-1 / correctness F1: unapproved refund cutoff ----
test('no refund cutoff or conversion condition anywhere in served copy or Stripe custom text', () => {
  const files = ['public/index.html', 'public/deposit-terms.html', 'public/privacy.html', 'public/reservation.html', 'public/reservation.js', 'public/app.js', 'lib/deposit-handlers.js', 'DEPOSIT-CHECKOUT.md'];
  const cutoff = /\b(before|until|prior to)\b[^.]{0,40}\b(convert|conversion|final order|order is placed|ships?)\b|\bconvert(ing|ed)?\b[^.]{0,30}\bfinal order\b/i;
  for (const f of files) assert.doesNotMatch(read(f), cutoff, f);
  const msg = checkoutSessionParams(readCheckoutConfig(ENV).config, { id: 'x'.repeat(22), binding: 'b', attribution: {} }).custom_text.submit.message;
  assert.doesNotMatch(msg, cutoff);
  for (const f of ['public/index.html', 'public/deposit-terms.html']) {
    const s = read(f);
    assert.match(s, /fully refundable/i, f);
    assert.match(s, /No automatic balance charge/, f);
    assert.match(s, /applied to the final machine price/i, f);
  }
  assert.match(read('public/index.html'), /\$100 USD today\.<\/b> Fully refundable\. Applied to the final machine price\. No automatic balance charge\./);
});

test('terms version bumped for the corrected terms; prior version stays recognised for lookups', () => {
  assert.equal(TV, 'deposit-terms-v2');
  assert.deepEqual([...KNOWN_TERMS_VERSIONS].sort(), ['deposit-terms-v1', 'deposit-terms-v2']);
  assert.match(read('public/deposit-terms.html'), /deposit-terms-v2/);
  assert.match(read('public/app.js') + read('public/index.html'), /termsVersion|deposit-terms/);
});

// ---- security F-2: Vercel lazy req.body getter throws on invalid JSON ----
test('a throwing req.body getter (Vercel helpers, invalid JSON) becomes 400 invalid_json, never a crash', async () => {
  const s = setup();
  const r = res();
  const rq = new Readable({ read() { this.push(null); } });
  rq.resume();
  await new Promise(done => rq.on('end', done));
  Object.assign(rq, { method: 'POST', url: '/api/checkout', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-length': '8' }, socket: {} });
  Object.defineProperty(rq, 'body', { get() { const e = new Error('Invalid JSON'); e.statusCode = 400; throw e; } });
  await s.checkout(rq, r);
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().state, 'invalid_json');
});

// ---- correctness F2: saved create response replays the ORIGINAL open session ----
test('after payment, re-pressing Reserve with the same operation routes to the receipt (retrieves current state)', async () => {
  const s = setup();
  const op = await start(s);
  let r = await call(s.checkout, createBody(op));
  assert.equal(r.json().state, 'redirect');
  const id = s.synth.control.state().sessions[0].id;
  s.synth.control.pay(id);
  r = await call(s.checkout, createBody(op));
  assert.equal(r.json().state, 'complete');
  assert.equal(r.json().reservationUrl, `/reservation.html?session_id=${id}`);
  assert.equal(s.synth.control.state().sessionCount, 1);
});

test('after expiry, the same operation reports expired (not a redirect to a dead session)', async () => {
  const s = setup();
  const op = await start(s);
  await call(s.checkout, createBody(op));
  s.synth.control.expire(s.synth.control.state().sessions[0].id);
  const r = await call(s.checkout, createBody(op));
  assert.equal(r.statusCode, 410);
  assert.equal(r.json().state, 'expired');
});

// ---- security F-4 / correctness F3: Stripe-saved 500 ----
test('a Stripe-saved 500 goes straight to the bounded reconcile path, never an endless uncertain loop', async () => {
  const s = setup();
  const op = await start(s);
  s.synth.control.failNext('save500');
  for (let i = 0; i < 3; i++) {
    const r = await call(s.checkout, createBody(op));
    assert.equal(r.json().state, 'reconcile', `attempt ${i}`);
    assert.equal(r.json().message, MESSAGES.reconcile);
  }
  assert.equal(s.synth.control.state().sessionCount, 0);
});

// ---- correctness F4: reconcile copy must not depend on a receipt email ----
test('reconcile and uncertain copy point to card statement and support, not only a receipt email', () => {
  for (const m of [MESSAGES.reconcile, MESSAGES.uncertain]) {
    assert.match(m, /card statement|bank/i);
    assert.doesNotMatch(m, /No payment|not charged|were not charged/i);
  }
  assert.match(MESSAGES.reconcile, /support@revivex\.store/);
});

// ---- security F-5: 2xx with an unusable body is uncertain ----
test('2xx malformed, truncated, empty or oversized create responses are uncertain, not "did not open"', async () => {
  for (const make of [() => new Response('not json', { status: 200 }), () => new Response('{"id":"cs_test_', { status: 200 }), () => new Response('', { status: 201 }), () => new Response('x'.repeat(1024 * 1024 + 5), { status: 200 })]) {
    const synth = createSyntheticStripe({ accountId: ENV.STRIPE_EXPECTED_ACCOUNT_ID, priceId: ENV.STRIPE_DEPOSIT_PRICE_ID, productId: ENV.STRIPE_DEPOSIT_PRODUCT_ID });
    const rest = createStripeRestProvider({ secretKey: ENV.STRIPE_SECRET_KEY, fetchImpl: async () => make() });
    const provider = { ...synth.provider, createCheckoutSession: rest.createCheckoutSession };
    const h = createCheckoutHandler({ getEnv: () => ENV, providerFactory: () => provider, log: makeLogger(logSink()), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }) });
    const op = (await call(h, startBody())).json().operation;
    const r = await call(h, createBody(op));
    assert.equal(r.json().state, 'uncertain');
    assert.doesNotMatch(r.json().message, /did not open/);
  }
});

// ---- security F-6: malformed provider structures fail closed without throwing ----
test('null / malformed line items, intents and charges map to not_recognized without throwing', () => {
  const cfg = { mode: 'test', live: false, priceId: ENV.STRIPE_DEPOSIT_PRICE_ID };
  const variants = [
    paidSession({ line_items: { data: [null] } }), paidSession({ line_items: null }), paidSession({ line_items: { data: 'x' } }),
    paidSession({ line_items: { data: [{ price: null, quantity: 1 }] } }), paidSession({ metadata: null }), paidSession({ payment_intent: { latest_charge: 7 } }),
    paidSession({}, { latest_charge: { paid: true, status: 'succeeded', amount_refunded: 'lots' } }), null, 42, 'str', [],
  ];
  for (const v of variants) {
    let out;
    assert.doesNotThrow(() => { out = lookupState(v, cfg); });
    assert.ok(['not_recognized'].includes(out.state), JSON.stringify(out));
  }
});

// ---- sandbox blocker: payment_method_types rejected by endive; scoped card-only ----
test('create params use allowed_payment_method_types card-only and branding display name, never payment_method_types', () => {
  const p = checkoutSessionParams(readCheckoutConfig(ENV).config, { id: 'y'.repeat(22), binding: 'b', attribution: {} });
  assert.equal(p.payment_method_types, undefined);
  assert.deepEqual(p.allowed_payment_method_types, ['card']);
  assert.deepEqual(p.branding_settings, { display_name: 'Revivex' });
});

test('handler creates against the endive-faithful fake and redirects only when the session is card-only and branded Revivex', async () => {
  const s = setup();
  const r = await call(s.checkout, createBody(await start(s)));
  assert.equal(r.json().state, 'redirect', r.body);
  const sess = s.synth.control.state().sessions[0];
  assert.deepEqual(sess.allowed, ['card']);
  assert.equal(sess.displayName, 'Revivex');
});

test('a session that would offer non-card methods or another display name is never redirected to', async () => {
  for (const tamper of [v => ({ ...v, payment_method_types: ['card', 'klarna'] }), v => ({ ...v, allowed_payment_method_types: null }), v => ({ ...v, branding_settings: { display_name: 'Individual' } }), v => ({ ...v, payment_method_types: [] })]) {
    const s = setup();
    const orig = s.synth.provider.retrieveCheckoutSession;
    s.synth.provider.retrieveCheckoutSession = async id => tamper(await orig(id));
    const r = await call(s.checkout, createBody(await start(s)));
    assert.equal(r.json().state, 'unavailable');
    assert.equal(r.json().url, undefined);
    assert.match(s.sink.lines.join('\n'), /session_payment_methods|session_branding/);
  }
});

test('Stripe error param is logged (non-secret) for diagnosability; message text is not', async () => {
  const s = setup();
  s.synth.provider.createCheckoutSession = async () => { const { StripeCallError } = await import('../../lib/stripe-rest.js'); throw new StripeCallError('api', { status: 400, type: 'invalid_request_error', param: 'payment_method_types', requestId: 'req_x' }); };
  await call(s.checkout, createBody(await start(s)));
  assert.match(s.sink.lines.join('\n'), /"param":"payment_method_types"/);
});

// ---- security F-3 / correctness F5: configuration is not readiness; canonical origin ----
test('GET reports configured (not available) and the canonical origin; no provider claim', async () => {
  const s = setup();
  const r = res();
  await s.checkout(req({ method: 'GET' }), r);
  const d = r.json();
  assert.equal(d.configured, true);
  assert.equal(d.available, undefined);
  assert.equal(d.siteOrigin, ORIGIN);
  const u = setup({ env: {} });
  const r2 = res();
  await u.checkout(req({ method: 'GET' }), r2);
  assert.equal(r2.json().configured, false);
  assert.equal(r2.json().siteOrigin, null);
});

// ---- security F-7: limiter clear loophole ----
test('limiter never clears all entries: a throttled key stays throttled while many other keys arrive', () => {
  let t = 0;
  const take = createInstanceRateLimiter({ limit: 2, windowMs: 60_000, now: () => t, maxKeys: 5 });
  take('victim'); take('victim');
  assert.equal(take('victim').ok, false);
  for (let i = 0; i < 50; i++) take(`spoof-${i}`);
  assert.equal(take('victim').ok, false, 'clear() loophole closed');
  t = 61_000;
  assert.equal(take('victim').ok, true, 'window still expires normally');
});

test('per-instance global ceiling bounds Stripe amplification even with rotating IPs', async () => {
  const synth = createSyntheticStripe({ accountId: ENV.STRIPE_EXPECTED_ACCOUNT_ID, priceId: ENV.STRIPE_DEPOSIT_PRICE_ID, productId: ENV.STRIPE_DEPOSIT_PRODUCT_ID });
  const h = createCheckoutHandler({ getEnv: () => ENV, providerFactory: () => synth.provider, log: makeLogger(logSink()), globalLimiter: createInstanceRateLimiter({ limit: 3, windowMs: 60_000 }) });
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(h, startBody(), { headers: { 'x-real-ip': `198.51.100.${i}` } })).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 429, 429, 429]);
});

// ---- security F-9 / F-10 ----
test('non-canonical MAC encodings are rejected', async () => {
  const s = setup();
  const op = await start(s);
  const [p, mac] = op.split('.');
  assert.equal(readOperation(op, SIGNING, Date.now()).ok, true);
  for (const variant of [`${p}.${mac}=`, `${p}.${mac.slice(0, -1)}${mac.slice(-1) === 'A' ? 'B' : 'A'}`, `${p}.${mac}A`]) {
    assert.equal(readOperation(variant, SIGNING, Date.now()).ok, false, variant.slice(-6));
  }
});

test('obviously weak signing secrets are refused', () => {
  for (const w of ['a'.repeat(40), 'ab'.repeat(20), '0123456789'.repeat(4).slice(0, 32).replace(/[2-9]/g, '1')]) {
    assert.equal(readCheckoutConfig({ ...ENV, REVIVEX_OPERATION_SIGNING_SECRET: w }).ok, false, w);
  }
  assert.equal(readCheckoutConfig(ENV).ok, true);
});

// ---- security F-11: CSP / frame-ancestors ----
test('HTML responses carry a CSP with frame-ancestors none', () => {
  const v = JSON.parse(read('vercel.json'));
  for (const src of ['/(.*)', '/reservation.html']) {
    const route = v.routes.find(r => r.src === src);
    const csp = route?.headers?.['Content-Security-Policy'] || '';
    assert.match(csp, /frame-ancestors 'none'/, src);
    assert.match(csp, /default-src 'self'/, src);
    assert.doesNotMatch(csp, /unsafe-eval/);
  }
});
