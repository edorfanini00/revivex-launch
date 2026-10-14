// $50 deposit with 20% off the final machine price (deposit-terms-v3), and the
// historical $100 deposits (v1/v2) that must keep reading correctly.
// LOCAL/MOCK fixtures only; real Stripe test mode evidence is recorded separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createCheckoutHandler, createReservationHandler, checkoutSessionParams, lookupState, priceProblem, MESSAGES } from '../../lib/deposit-handlers.js';
import { DEPOSIT, OFFERS, PREVIOUS_OFFER, readCheckoutConfig, readStripeConfig } from '../../lib/deposit-config.js';
import { bindingDigest, idempotencyKeyFor, readOperation } from '../../lib/operation-token.js';
import { createInstanceRateLimiter, makeLogger } from '../../lib/http.js';
import { LOOKUP_KEY, priceIssues, priceParams } from '../../scripts/create-deposit-price.mjs';
import { ENV, LEGACY_PRICE, SIGNING, createBody, fakeProvider, legacyPaidSession, logSink, paidSession, price, req, res, session, startBody } from '../fixtures/deposit-fixtures.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = f => fs.readFileSync(new URL(f, ROOT), 'utf8');
const CFG = readCheckoutConfig(ENV).config;
const SCFG = readStripeConfig(ENV).config;

function setup(overrides = {}, env = ENV) {
  const provider = fakeProvider(overrides);
  const sink = logSink();
  const handler = createCheckoutHandler({ getEnv: () => env, providerFactory: () => provider, log: makeLogger(sink), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }) });
  return { provider, handler, sink };
}
async function call(handler, body) { const r = res(); await handler(req({ body }), r); return r; }
async function start(h) { const r = await call(h.handler, startBody()); assert.equal(r.json().state, 'started', r.body); return r.json().operation; }
const creates = p => p.calls.filter(c => c[0] === 'create');

// A token exactly as the previous release issued it (signed with the same secret).
function tokenWithBinding(binding, iat = Math.floor(Date.now() / 1000) - 60) {
  const payload = Buffer.from(JSON.stringify({ v: 1, id: crypto.randomBytes(16).toString('base64url'), iat, b: binding, a: {} })).toString('base64url');
  const mac = crypto.createHmac('sha256', SIGNING).update(`rvx-op-v1.${payload}`).digest('base64url');
  return `${payload}.${mac}`;
}
const previousBinding = (cfg = CFG) => bindingDigest(cfg, { priceId: LEGACY_PRICE, termsVersion: PREVIOUS_OFFER.termsVersion, paramsVersion: PREVIOUS_OFFER.paramsVersion });

async function lookup(s, env = ENV) {
  const handler = createReservationHandler({ getEnv: () => env, providerFactory: () => fakeProvider({ retrieveCheckoutSession: async () => s }), log: makeLogger(logSink()), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }) });
  const r = res();
  await handler(req({ method: 'GET', url: `/api/reservation?session_id=${s.id}` }), r);
  return r.json();
}

test('offer registry: v3 is $50 with 20% machine discount and the only creatable offer; v1/v2 stay $100 with no discount', () => {
  assert.deepEqual({ amount: DEPOSIT.amount, currency: DEPOSIT.currency, quantity: DEPOSIT.quantity, termsVersion: DEPOSIT.termsVersion, machineDiscountPercent: DEPOSIT.machineDiscountPercent }, { amount: 5000, currency: 'usd', quantity: 1, termsVersion: 'deposit-terms-v3', machineDiscountPercent: 20 });
  assert.deepEqual(Object.entries(OFFERS).map(([v, o]) => [v, o.amount, o.machineDiscountPercent, o.current]), [
    ['deposit-terms-v1', 10000, null, false],
    ['deposit-terms-v2', 10000, null, false],
    ['deposit-terms-v3', 5000, 20, true],
  ]);
  assert.equal(OFFERS[DEPOSIT.termsVersion].amount, DEPOSIT.amount);
});

test('config: pinned legacy price ids are optional, must be well formed, distinct and never the current price', () => {
  const { STRIPE_LEGACY_DEPOSIT_PRICE_IDS: _, ...noLegacy } = ENV;
  assert.deepEqual(readStripeConfig(noLegacy).config.legacyPriceIds, []);
  assert.deepEqual(readStripeConfig({ ...ENV, STRIPE_LEGACY_DEPOSIT_PRICE_IDS: ' price_TESTLEGACY100 , price_TESTLEGACY200 ' }).config.legacyPriceIds, ['price_TESTLEGACY100', 'price_TESTLEGACY200']);
  for (const bad of ['nope', 'price_TESTLEGACY100,', `price_TESTLEGACY100,${ENV.STRIPE_DEPOSIT_PRICE_ID}`, 'price_TESTLEGACY100,price_TESTLEGACY100']) {
    const r = readStripeConfig({ ...ENV, STRIPE_LEGACY_DEPOSIT_PRICE_IDS: bad });
    assert.equal(r.ok, false, bad);
    assert.ok(r.problems.includes('STRIPE_LEGACY_DEPOSIT_PRICE_IDS'), bad);
  }
  // Live checkout needs the explicit v3 sign-off; the v2 sign-off no longer opens checkout.
  const live = { ...ENV, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: ENV.STRIPE_SECRET_KEY.replace('_test_', '_live_'), REVIVEX_SITE_ORIGIN: 'https://reserve.example' };
  assert.ok(readCheckoutConfig({ ...live, REVIVEX_LIVE_APPROVED_TERMS_VERSION: 'deposit-terms-v2' }).problems.includes('REVIVEX_LIVE_APPROVED_TERMS_VERSION'));
  assert.equal(readCheckoutConfig({ ...live, REVIVEX_LIVE_APPROVED_TERMS_VERSION: 'deposit-terms-v3' }).ok, true);
});

test('new checkout: exactly one $50 line item from the pinned price; terms, discount metadata and hosted text agree', async () => {
  const h = setup();
  const r = await call(h.handler, createBody(await start(h)));
  assert.equal(r.json().state, 'redirect', r.body);
  const [[, params]] = creates(h.provider);
  assert.deepEqual(params.line_items, [{ price: ENV.STRIPE_DEPOSIT_PRICE_ID, quantity: 1 }]);
  assert.equal(params.metadata.terms_version, 'deposit-terms-v3');
  assert.equal(params.metadata.machine_discount_percent, '20');
  assert.deepEqual(params.payment_intent_data.metadata, params.metadata);
  assert.equal(params.payment_intent_data.description, 'Revivex fully refundable preorder deposit (deposit-terms-v3)');
  const msg = params.custom_text.submit.message;
  assert.match(msg, /^\$50 USD fully refundable preorder deposit/);
  assert.match(msg, /20% off the final machine price, then your \$50 is credited toward the rest/);
  assert.doesNotMatch(msg, /\$100/);
  // GET probe: the browser learns $50, v3 and the discount, nothing else.
  const g = res();
  await h.handler(req({ method: 'GET' }), g);
  assert.equal(g.json().amount, 5000);
  assert.equal(g.json().termsVersion, 'deposit-terms-v3');
  assert.equal(g.json().machineDiscountPercent, 20);
  assert.equal(g.json().legacyPinned, true);
  const { STRIPE_LEGACY_DEPOSIT_PRICE_IDS: _, ...noLegacy } = ENV;
  const g2 = res();
  await setup({}, noLegacy).handler(req({ method: 'GET' }), g2);
  assert.equal(g2.json().legacyPinned, false, 'the probe shows when historical receipts cannot be read');
});

test('the 20% is never applied to the deposit: no coupon/discount/promotion parameters, a $40 price is refused, the receipt says $50', async () => {
  const p = checkoutSessionParams(CFG, { id: 'x'.repeat(22), binding: 'b', attribution: {} });
  for (const k of ['discounts', 'coupon', 'promotion_code', 'price_data', 'amount', 'line_items_override']) assert.equal(p[k], undefined, k);
  assert.equal(p.allow_promotion_codes, false);
  assert.equal(p.line_items.length, 1);
  assert.equal(priceProblem(price({ unit_amount: 4000 }), CFG), 'price_amount');
  assert.equal(priceProblem(price({ unit_amount: 5000 }), CFG), null);
  const d = await lookup(paidSession());
  assert.equal(d.amount, 5000);
  assert.equal(d.machineDiscountPercent, 20);
});

test('mismatched current price (old $100 price, other currency, wrong mode, recurring, wrong product) never creates', async () => {
  const bad = [
    price({ unit_amount: 10000 }),
    price({ currency: 'eur' }),
    price({ currency_options: { usd: { unit_amount: 5000 }, eur: { unit_amount: 4600 } } }),
    price({ livemode: true }),
    price({ type: 'recurring', recurring: { interval: 'month' } }),
    price({ id: LEGACY_PRICE }),
    price({ product: { id: 'prod_OTHER0001', active: true } }),
    price({ active: false }),
  ];
  for (const p of bad) {
    const h = setup({ getPrice: async () => p });
    const r = await call(h.handler, createBody(await start(h)));
    assert.equal(r.json().state, 'unavailable', JSON.stringify(p).slice(0, 80));
    assert.equal(creates(h.provider).length, 0);
    assert.match(h.sink.lines.join('\n'), /deposit_merchant_verification_failed/);
  }
});

test('a created session that is not the current $50 offer is never shown (Stripe returned $100, v2, or no discount metadata)', async () => {
  const wrong = [
    session({ amount_total: 10000 }),
    session({ metadata: { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v2', operation: 'x' }, amount_total: 10000 }),
    session({ metadata: { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v3', operation: 'x' } }),
    session({ currency: 'eur' }),
  ];
  for (const s of wrong) {
    const h = setup({ createCheckoutSession: async () => s, retrieveCheckoutSession: async () => s });
    const r = await call(h.handler, createBody(await start(h)));
    assert.equal(r.json().state, 'unavailable', JSON.stringify(s.metadata) + s.amount_total);
    assert.equal(r.json().url, undefined);
  }
});

test('cached old page: a request without the displayed $50, or showing $100 or v2 terms, must reload; no Stripe call', async () => {
  const h = setup();
  const token = await start(h);
  for (const body of [
    { step: 'start', termsAccepted: true, termsVersion: DEPOSIT.termsVersion, attribution: {} },
    startBody({ displayedAmount: 10000 }),
    startBody({ displayedAmount: '5000' }),
    startBody({ termsVersion: 'deposit-terms-v2' }),
    { step: 'create', operation: token, termsAccepted: true, termsVersion: DEPOSIT.termsVersion },
    createBody(token, { displayedAmount: 10000 }),
    createBody(token, { termsVersion: 'deposit-terms-v2', displayedAmount: 10000 }),
  ]) {
    const r = await call(h.handler, body);
    assert.equal(r.statusCode, 409, JSON.stringify(body));
    assert.equal(r.json().state, 'terms_changed');
  }
  assert.equal(h.provider.calls.length, 0);
});

test('old signed operation from the $100 offer: offer_changed, never re-sent to Stripe, so no $100 session is reopened', async () => {
  const h = setup();
  const r = await call(h.handler, createBody(tokenWithBinding(previousBinding())));
  assert.equal(r.statusCode, 409);
  assert.deepEqual({ state: r.json().state, preWrite: r.json().preWrite }, { state: 'offer_changed', preWrite: true });
  assert.equal(r.json().message, MESSAGES.offer_changed);
  assert.match(r.json().message, /^The deposit is now \$50\. If you paid an earlier \$100 deposit, it stays valid and fully refundable\./);
  assert.equal(h.provider.calls.length, 0, 'no retrieve, no create: the old idempotency key is never replayed');
  assert.match(h.sink.lines.join('\n'), /previous_offer/);

  // Without the pinned legacy price the server cannot tell, and falls back to reconcile.
  const { STRIPE_LEGACY_DEPOSIT_PRICE_IDS: _, ...noLegacy } = ENV;
  const h2 = setup({}, noLegacy);
  assert.equal((await call(h2.handler, createBody(tokenWithBinding(previousBinding())))).json().state, 'reconcile');
  // An aged previous token, or any other drifted binding, is a plain reconcile.
  assert.equal((await call(h.handler, createBody(tokenWithBinding(previousBinding(), Math.floor(Date.now() / 1000) - 24 * 3600)))).json().state, 'reconcile');
  assert.equal((await call(h.handler, createBody(tokenWithBinding('x'.repeat(32))))).json().state, 'reconcile');
  assert.equal(h.provider.calls.length + h2.provider.calls.length, 0);
});

test('the app treats offer_changed like reconcile: silent fresh start only if never sent, otherwise ask first', () => {
  const app = read('public/app.js');
  assert.match(app, /const stopped = d\.state === 'reconcile' \|\| d\.state === 'invalid_operation' \|\| d\.state === 'offer_changed';/);
  assert.match(app, /if \(stopped && d\.preWrite === true && !wasAttempted && fresh === 0\)/);
  assert.match(app, /if \(stopped\) \{[\s\S]{0,200}restart\.hidden = false;/);
  // Uncertain and reconcile copy no longer names an amount (an earlier attempt may have been $100).
  for (const m of [MESSAGES.uncertain, MESSAGES.reconcile]) assert.doesNotMatch(m, /\$\d/);
  assert.doesNotMatch(app.match(/const UNCERTAIN = [^\n]+/)[0] + app.match(/const RECONCILE = [^\n]+/)[0], /\$\d/);
});

test('old operation retry and duplicate submit: one Stripe session per operation, identical key and parameters', async () => {
  const h = setup();
  const token = await start(h);
  const [a, b] = await Promise.all([call(h.handler, createBody(token)), call(h.handler, createBody(token))]);
  assert.equal(a.json().state, 'redirect');
  assert.equal(b.json().url, a.json().url);
  assert.equal(creates(h.provider).length, 1, 'concurrent duplicates share one create');
  // A retry after the replay window sends byte-identical parameters under the same key.
  const h2 = setup();
  const t2 = await start(h2);
  const op = readOperation(t2, SIGNING, Date.now()).op;
  const p1 = JSON.stringify(checkoutSessionParams(CFG, op));
  const p2 = JSON.stringify(checkoutSessionParams(CFG, op));
  assert.equal(p1, p2);
  assert.match(idempotencyKeyFor(op), /^rvx-deposit-v1-[0-9a-f]{48}$/);
  assert.notEqual(op.binding, previousBinding(), 'the v3 binding differs from the $100 binding');
});

test('$50 receipts: paid shows $50 and 20%; refunded/partly refunded/disputed show actual amounts and no benefit', async () => {
  assert.deepEqual(lookupState(paidSession(), SCFG), { state: 'confirmed', reference: 'pi_TESTPAID000001', amount: 5000, termsVersion: 'deposit-terms-v3', machineDiscountPercent: 20 });
  assert.deepEqual(lookupState(paidSession({}, {}, { refunded: true, amount_refunded: 5000 }), SCFG), { state: 'refunded', reference: 'pi_TESTPAID000001', amount: 5000, termsVersion: 'deposit-terms-v3', amountRefunded: 5000 });
  assert.deepEqual(lookupState(paidSession({}, {}, { amount_refunded: 2500 }), SCFG), { state: 'partially_refunded', reference: 'pi_TESTPAID000001', amount: 5000, termsVersion: 'deposit-terms-v3', amountRefunded: 2500 });
  assert.deepEqual(lookupState(paidSession({}, {}, { disputed: true }), SCFG), { state: 'disputed', reference: 'pi_TESTPAID000001', amount: 5000, termsVersion: 'deposit-terms-v3' });
  const d = await lookup(paidSession({}, {}, { refunded: true, amount_refunded: 5000 }));
  assert.deepEqual([d.state, d.amount, d.amountRefunded, d.machineDiscountPercent], ['refunded', 5000, 5000, null]);
});

test('historical $100 receipts (v2, pinned legacy price) still validate with their real amount and original terms', async () => {
  assert.deepEqual(lookupState(legacyPaidSession(), SCFG), { state: 'confirmed', reference: 'pi_TESTPAID000001', amount: 10000, termsVersion: 'deposit-terms-v2', machineDiscountPercent: null });
  const refunded = await lookup(legacyPaidSession({}, {}, { refunded: true, amount_refunded: 10000 }));
  assert.deepEqual([refunded.state, refunded.amount, refunded.amountRefunded, refunded.termsVersion, refunded.machineDiscountPercent], ['refunded', 10000, 10000, 'deposit-terms-v2', null]);
  // v1 (never paid for real) reads the same way.
  assert.equal(lookupState(legacyPaidSession({ metadata: { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v1' } }), SCFG).amount, 10000);
  // Without the pinned legacy price, a $100 session is not recognised (fails closed, never shown as $50).
  const { STRIPE_LEGACY_DEPOSIT_PRICE_IDS: _, ...noLegacy } = ENV;
  assert.equal(lookupState(legacyPaidSession(), readStripeConfig(noLegacy).config).state, 'not_recognized');
});

test('a real Stripe test mode v2 session shape (ids and PII replaced) reads as refunded $100', () => {
  const s = JSON.parse(read('tests/fixtures/stripe-test-v2-refunded.json'));
  const cfg = readStripeConfig({ ...ENV, STRIPE_EXPECTED_ACCOUNT_ID: 'acct_TESTREVIVEX01', STRIPE_DEPOSIT_PRODUCT_ID: s.line_items.data[0].price.product, STRIPE_LEGACY_DEPOSIT_PRICE_IDS: s.line_items.data[0].price.id }).config;
  assert.deepEqual(lookupState(s, cfg), { state: 'refunded', reference: s.payment_intent.id, amount: 10000, termsVersion: 'deposit-terms-v2', amountRefunded: 10000 });
  const unrefunded = structuredClone(s);
  Object.assign(unrefunded.payment_intent.latest_charge, { refunded: false, amount_refunded: 0 });
  assert.deepEqual(lookupState(unrefunded, cfg), { state: 'confirmed', reference: s.payment_intent.id, amount: 10000, termsVersion: 'deposit-terms-v2', machineDiscountPercent: null });
  // The same session against the current $50 price only (no legacy pin) is not recognised.
  assert.equal(lookupState(s, { ...cfg, legacyPriceIds: [] }).state, 'not_recognized');
});

test('cross pairing of terms, amount and price is never recognised', () => {
  const v2meta = { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v2', operation: 'x' };
  const cases = [
    ['v3 metadata on the $100 legacy price', paidSession({ line_items: legacyPaidSession().line_items })],
    ['v3 metadata with a $100 total', paidSession({ amount_total: 10000 }, { amount_received: 10000 })],
    ['v2 metadata on the current $50 price', legacyPaidSession({ line_items: paidSession().line_items })],
    ['v2 metadata with a $50 total', legacyPaidSession({ amount_total: 5000 }, { amount_received: 5000 })],
    ['v3 without the discount metadata', paidSession({ metadata: { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v3', operation: 'x' } })],
    ['v3 claiming a different discount', paidSession({ metadata: { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v3', machine_discount_percent: '30', operation: 'x' } })],
    ['unknown terms version', paidSession({ metadata: { ...v2meta, terms_version: 'deposit-terms-v9' } })],
    ['inherited terms key', paidSession({ metadata: { ...v2meta, terms_version: 'constructor' } })],
    ['line item unit amount differs', paidSession({ line_items: { object: 'list', data: [{ price: { id: ENV.STRIPE_DEPOSIT_PRICE_ID, unit_amount: 4000 }, quantity: 1 }] } })],
    ['line item without unit amount', paidSession({ line_items: { object: 'list', data: [{ price: { id: ENV.STRIPE_DEPOSIT_PRICE_ID }, quantity: 1 }] } })],
    ['PaymentIntent received $40', paidSession({}, { amount_received: 4000 })],
    ['refund larger than the deposit', paidSession({}, {}, { amount_refunded: 10000 })],
    ['negative refund', paidSession({}, {}, { amount_refunded: -1 })],
  ];
  for (const [name, s] of cases) assert.equal(lookupState(s, SCFG).state, 'not_recognized', name);
});

test('canceled or unpaid checkouts never show an amount or the machine discount', async () => {
  for (const [s, state] of [
    [session({ line_items: paidSession().line_items }), 'not_completed'],
    [session({ status: 'expired', url: null, line_items: paidSession().line_items }), 'expired'],
    [paidSession({ payment_status: 'unpaid' }), 'processing'],
    [legacyPaidSession({ status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/x' }), 'not_completed'],
  ]) {
    const d = await lookup(s);
    assert.equal(d.state, state);
    assert.deepEqual([d.amount, d.amountRefunded, d.termsVersion, d.machineDiscountPercent, d.reference], [null, null, null, null, null], state);
  }
});

test('page, terms and receipt agree with the server offer', () => {
  const html = read('public/index.html');
  const panel = html.match(/<p class="deposit-panel" id="depositPanel"[^>]*>/)[0];
  assert.match(panel, new RegExp(`data-terms-version="${DEPOSIT.termsVersion}"`));
  assert.match(panel, new RegExp(`data-deposit-amount="${DEPOSIT.amount}"`));
  assert.match(read('public/deposit-terms.html'), new RegExp(`data-terms-version="${DEPOSIT.termsVersion}"`));
  assert.match(read('public/deposit-terms.html'), /the 20% comes off the final machine price first, and then your full \$50 deposit is credited toward what remains/);
  assert.match(read('public/deposit-terms.html'), /href="\/deposit-terms-v2\.html"/);
  // No invented final price, savings figure, delivery date, expiry or stacking rule.
  for (const f of ['public/index.html', 'public/deposit-terms.html', 'public/reservation.js']) {
    const t = read(f);
    assert.doesNotMatch(t, /\bexpir(es|y)\b.*discount|discount.*\bexpir|cannot be combined|stack|save \$|you save|ships (in|by)|deliver(y|ed) (in|by)/i, f);
  }
  // Customer copy uses no em or en dashes.
  for (const f of ['public/index.html', 'public/deposit-terms.html', 'public/reservation.html', 'public/reservation.js']) {
    const strings = read(f).split('\n').filter(l => !/^\s*(\/\/|\/?\*|<!--)/.test(l)).join('\n');
    assert.doesNotMatch(strings, /[\u2013\u2014]|&[mn]dash;/, f);
  }
  assert.doesNotMatch(read('public/index.html') + read('public/reservation.js') + read('public/deposit-terms.html'), /ReviveX/);
});

test('price script: creates only a one-time $50 USD price with a fixed lookup key, and rejects any other read back', () => {
  assert.equal(LOOKUP_KEY, 'revivex_deposit_usd_5000_v3');
  const params = priceParams('prod_TESTDEPOSIT01');
  assert.deepEqual(params, {
    product: 'prod_TESTDEPOSIT01', currency: 'usd', unit_amount: '5000', lookup_key: LOOKUP_KEY,
    nickname: 'Revivex preorder deposit $50 (deposit-terms-v3)',
    'metadata[purpose]': 'revivex_preorder_deposit', 'metadata[terms_version]': 'deposit-terms-v3', 'metadata[machine_discount_percent]': '20',
  });
  assert.ok(!Object.keys(params).some(k => /recurring|tiers|currency_options|transfer_lookup_key|custom_unit_amount/.test(k)));
  const good = { ...price(), lookup_key: LOOKUP_KEY, metadata: { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v3', machine_discount_percent: '20' }, product: 'prod_TESTDEPOSIT01' };
  assert.deepEqual(priceIssues(good, { productId: 'prod_TESTDEPOSIT01', live: false }), []);
  assert.deepEqual(priceIssues(good, { productId: 'prod_TESTDEPOSIT01', live: true }), ['livemode']);
  for (const [o, issue] of [[{ unit_amount: 10000 }, 'unit_amount'], [{ currency: 'eur' }, 'currency'], [{ type: 'recurring', recurring: { interval: 'month' } }, 'type'], [{ active: false }, 'active'], [{ product: 'prod_OTHER0001' }, 'product'], [{ currency_options: { usd: {}, eur: {} } }, 'currency_options'], [{ metadata: {} }, 'metadata.purpose']]) {
    assert.ok(priceIssues({ ...good, ...o }, { productId: 'prod_TESTDEPOSIT01', live: false }).includes(issue), issue);
  }
});
