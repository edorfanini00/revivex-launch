// LOCAL/MOCK tests of the receipt/status handler with a fake Stripe provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservationHandler } from '../../lib/deposit-handlers.js';
import { makeLogger, createInstanceRateLimiter } from '../../lib/http.js';
import { StripeCallError } from '../../lib/stripe-rest.js';
import { ENV, SECRET, account, session, paidSession, fakeProvider, req, res, logSink } from '../fixtures/deposit-fixtures.mjs';

const ID = 'cs_test_SYNTHPAID0001';

function setup({ env = ENV, provider = fakeProvider(), limiter } = {}) {
  const sink = logSink();
  const handler = createReservationHandler({
    getEnv: () => env, providerFactory: () => provider, log: makeLogger(sink),
    limiter: limiter || createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }),
  });
  return { handler, provider, sink };
}
async function get(h, query = `session_id=${ID}`, method = 'GET') {
  const r = res();
  await h.handler(req({ method, url: `/api/reservation?${query}` }), r);
  return r;
}
const withSession = s => fakeProvider({ retrieveCheckoutSession: async () => s });

test('paid, verified session returns only state, its paid amount and terms, the machine discount, reference, mode and the measurement fresh flag', async () => {
  const h = setup({ provider: withSession(paidSession({ id: ID })) });
  const r = await get(h);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, state: 'confirmed', amount: 5000, amountRefunded: null, currency: 'usd', termsVersion: 'deposit-terms-v3', machineDiscountPercent: 20, reference: 'pi_TESTPAID000001', mode: 'test', fresh: false });
  assert.equal(r.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  for (const leak of ['buyer-pii', 'Pat Example', 'cs_secret', 'owner@example', 'checkout.stripe.com', SECRET]) assert.ok(!r.body.includes(leak), leak);
});

test('unpaid, open, expired, refunded and processing sessions are never reported as confirmed', async () => {
  const cases = [
    [session({ id: ID, line_items: paidSession().line_items }), 'not_completed'],
    [session({ id: ID, status: 'expired', url: null, line_items: paidSession().line_items }), 'expired'],
    [paidSession({ id: ID, payment_status: 'unpaid' }), 'processing'],
    [paidSession({ id: ID }, {}, { refunded: true, amount_refunded: 5000 }), 'refunded'],
    [paidSession({ id: ID }, {}, { amount_refunded: 2500 }), 'partially_refunded'],
    [paidSession({ id: ID }, {}, { disputed: true }), 'disputed'],
    [paidSession({ id: ID }, {}, { disputed: true, refunded: true, amount_refunded: 5000 }), 'disputed'],
  ];
  for (const [s, state] of cases) {
    const r = await get(setup({ provider: withSession(s) }));
    assert.equal(r.json().state, state);
    if (['refunded', 'partially_refunded', 'disputed'].includes(state)) assert.equal(r.json().reference, 'pi_TESTPAID000001');
    else assert.equal(r.json().reference, null);
    assert.notEqual(r.json().state, 'confirmed');
    assert.equal(r.json().machineDiscountPercent, null, `${state}: no benefit unless confirmed`);
  }
});

test('foreign or tampered sessions are not recognised (amount, currency, metadata, terms, price, quantity, intent)', async () => {
  const bad = [
    paidSession({ id: ID, amount_total: 100 }),
    paidSession({ id: ID, currency: 'eur' }),
    paidSession({ id: ID, livemode: true }),
    paidSession({ id: ID, mode: 'subscription' }),
    paidSession({ id: ID, metadata: {} }),
    paidSession({ id: ID, metadata: { purpose: 'other_product', terms_version: 'deposit-terms-v1' } }),
    paidSession({ id: ID, metadata: { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v99' } }),
    paidSession({ id: ID, line_items: { data: [{ price: { id: 'price_SOMEOTHER' }, quantity: 1 }] } }),
    paidSession({ id: ID, line_items: { data: [{ price: { id: 'price_TESTDEPOSIT01' }, quantity: 2 }] } }),
    paidSession({ id: ID, line_items: { data: [] } }),
    paidSession({ id: ID }, { status: 'requires_payment_method' }),
    paidSession({ id: ID }, { amount_received: 100 }),
    paidSession({ id: ID }, { currency: 'eur' }),
    paidSession({ id: ID }, { livemode: true }),
    paidSession({ id: ID, payment_intent: 'pi_notexpanded' }),
    paidSession({ id: ID }, {}, { paid: false, status: 'failed' }),
    paidSession({ id: ID }, { latest_charge: null }),
  ];
  for (const s of bad) {
    const h = setup({ provider: withSession(s) });
    const r = await get(h);
    assert.equal(r.json().state, 'not_recognized', JSON.stringify(s).slice(0, 120));
    assert.equal(r.json().reference, null);
    assert.match(h.sink.lines.join('\n'), /deposit_lookup_rejected/);
  }
});

test('session from another Stripe account (pinned account mismatch) is refused', async () => {
  const h = setup({ provider: fakeProvider({ getAccount: async () => account({ id: 'acct_OTHERACCOUNT' }) }) });
  const r = await get(h);
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().state, 'unavailable');
});

test('Stripe 404 is not_found; timeouts are retry; never confirmed', async () => {
  let r = await get(setup({ provider: fakeProvider({ retrieveCheckoutSession: async () => { throw new StripeCallError('api', { status: 404, type: 'invalid_request_error', code: 'resource_missing' }); } }) }));
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().state, 'not_found');
  r = await get(setup({ provider: fakeProvider({ retrieveCheckoutSession: async () => { throw new StripeCallError('timeout'); } }) }));
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().state, 'retry');
});

test('query parameters are not payment evidence; malformed or wrong-mode ids never reach Stripe', async () => {
  const provider = withSession(session({ id: ID, line_items: paidSession().line_items }));
  const h = setup({ provider });
  let r = await get(h, `session_id=${ID}&paid=true&status=complete&payment_status=paid&amount=10000`);
  assert.equal(r.json().state, 'not_completed', 'extra params ignored; Stripe says open');
  const before = provider.calls.length;
  for (const q of ['', 'session_id=', 'session_id=cs_live_SYNTHPAID0001', 'session_id=pi_123', 'session_id=cs_test_../../v1/charges', 'session_id=cs_test_abc%2F..%2Fx', `session_id=cs_test_${'a'.repeat(300)}`]) {
    r = await get(h, q);
    assert.equal(r.statusCode, 404, q);
    assert.equal(r.json().state, 'not_found');
  }
  assert.equal(provider.calls.length, before, 'no Stripe calls for invalid ids');
});

test('fails closed without Stripe config; GET only; rate limited', async () => {
  let r = await get(setup({ env: {} }));
  assert.equal(r.statusCode, 503);
  r = await get(setup(), `session_id=${ID}`, 'POST');
  assert.equal(r.statusCode, 405);
  const h = setup({ limiter: createInstanceRateLimiter({ limit: 1, windowMs: 60_000 }) });
  await get(h);
  r = await get(h);
  assert.equal(r.statusCode, 429);
});

test('lookup still works while new checkout is paused (existing depositors)', async () => {
  const r = await get(setup({ env: { ...ENV, REVIVEX_CHECKOUT_ENABLED: 'false', REVIVEX_OPERATION_SIGNING_SECRET: '' } }));
  assert.equal(r.json().state, 'confirmed');
});
