// LOCAL/MOCK tests of the actual Vercel handler code with a fake Stripe provider.
// They prove handler logic only; they are not Stripe sandbox acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutHandler, checkoutSessionParams, MESSAGES } from '../../lib/deposit-handlers.js';
import { idempotencyKeyFor, readOperation, issueOperation, OPERATION_MAX_AGE_S } from '../../lib/operation-token.js';
import { readCheckoutConfig } from '../../lib/deposit-config.js';
import { makeLogger, createInstanceRateLimiter } from '../../lib/http.js';
import { StripeCallError } from '../../lib/stripe-rest.js';
import { ENV, ORIGIN, SECRET, SIGNING, account, price, product, session, fakeProvider, req, res, startBody, createBody, logSink } from '../fixtures/deposit-fixtures.mjs';

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

function setup({ env = ENV, provider = fakeProvider(), limiter, clock } = {}) {
  const sink = logSink();
  let factoryCalls = 0;
  const time = clock || { t: T0 };
  const handler = createCheckoutHandler({
    getEnv: () => (typeof env === 'function' ? env() : env),
    providerFactory: () => { factoryCalls += 1; return provider; },
    log: makeLogger(sink),
    limiter: limiter || createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }),
    now: () => time.t,
  });
  return { handler, provider, sink, time, factoryCalls: () => factoryCalls };
}

async function call(h, body, opts = {}) {
  const r = res();
  await h.handler(req({ body, ...opts }), r);
  return r;
}
async function start(h, o = {}) {
  const r = await call(h, startBody(o));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().state, 'started');
  return r.json().operation;
}
const creates = p => p.calls.filter(c => c[0] === 'create');

test('start issues a signed operation without any Stripe call', async () => {
  const h = setup();
  const token = await start(h);
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.factoryCalls(), 0);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const read = readOperation(token, SIGNING, T0);
  assert.equal(read.ok, true);
  assert.equal(read.op.ageS, 0);
  for (const leak of [SECRET, 'acct_', 'price_', 'prod_']) assert.ok(!Buffer.from(token.split('.')[0], 'base64url').toString().includes(leak), `token payload exposes ${leak}`);
});

test('create uses exact server-controlled amount, price, quantity and redirects', async () => {
  const h = setup();
  const r = await call(h, createBody(await start(h)));
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.equal(d.state, 'redirect');
  assert.match(d.url, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  assert.equal(r.headers['cache-control'], 'no-store, max-age=0');

  const [[, params, key]] = creates(h.provider);
  assert.equal(params.mode, 'payment');
  assert.deepEqual(params.line_items, [{ price: 'price_TESTDEPOSIT01', quantity: 1 }]);
  assert.deepEqual(params.payment_method_types, ['card']);
  assert.deepEqual(params.adaptive_pricing, { enabled: false });
  assert.equal(params.allow_promotion_codes, false);
  assert.equal(params.success_url, `${ORIGIN}/reservation.html?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(params.cancel_url, `${ORIGIN}/#reserve`);
  assert.equal(params.metadata.purpose, 'revivex_preorder_deposit');
  assert.equal(params.metadata.terms_version, 'deposit-terms-v1');
  assert.deepEqual(params.payment_intent_data.metadata, params.metadata);
  for (const k of ['automatic_tax', 'shipping_address_collection', 'shipping_options', 'discounts', 'subscription_data', 'setup_intent_data', 'customer_email', 'consent_collection', 'invoice_creation', 'saved_payment_method_options']) assert.equal(params[k], undefined, k);
  assert.equal(params.payment_intent_data.setup_future_usage, undefined);
  assert.equal(params.payment_intent_data.capture_method, undefined);
  assert.ok(params.custom_text.submit.message.length <= 1200);
  assert.match(params.custom_text.submit.message, /refundable/);
  assert.match(params.custom_text.submit.message, /No automatic balance charge/);
  assert.match(key, /^rvx-deposit-v1-[0-9a-f]{48}$/);
});

test('rejects client attempts to supply amount, price, currency, quantity, redirect, PII or unknown steps', async () => {
  const h = setup();
  const token = await start(h);
  for (const extra of [{ amount: 1 }, { price: 'price_evil' }, { currency: 'eur' }, { quantity: 3 }, { success_url: 'https://evil.example' }, { cancel_url: 'https://evil.example' }, { email: 'a@b.co' }, { mode: 'subscription' }, { attribution: { utm_source: 'x' } }]) {
    const r = await call(h, createBody(token, extra));
    assert.equal(r.statusCode, 400, JSON.stringify(extra));
    assert.equal(r.json().state, 'unexpected_field');
  }
  for (const extra of [{ operation: token }, { amount: 1 }, { email: 'a@b.co' }]) {
    const r = await call(h, startBody(extra));
    assert.equal(r.statusCode, 400);
  }
  for (const step of [undefined, 'pay', 'refund', '__proto__', 'constructor']) {
    const r = await call(h, { step, termsAccepted: true, termsVersion: 'deposit-terms-v1' });
    assert.equal(r.statusCode, 400, String(step));
    assert.equal(r.json().state, 'invalid_step');
  }
  assert.equal(h.provider.calls.length, 0, 'no Stripe call for forbidden input');
});

test('terms acceptance and version are required for start and create', async () => {
  const h = setup();
  const token = await start(h);
  for (const make of [startBody, o => createBody(token, o)]) {
    for (const [o, status, state] of [[{ termsAccepted: 'true' }, 400, 'terms_required'], [{ termsAccepted: false }, 400, 'terms_required'], [{ termsVersion: 'deposit-terms-v0' }, 409, 'terms_changed']]) {
      const r = await call(h, make(o));
      assert.equal(r.statusCode, status, state);
      assert.equal(r.json().state, state);
    }
  }
  assert.equal(h.provider.calls.length, 0);
});

test('forged, tampered, malformed and future-dated operation tokens never reach Stripe', async () => {
  const h = setup();
  const token = await start(h);
  const [payload, mac] = token.split('.');
  const json = JSON.parse(Buffer.from(payload, 'base64url'));
  const tampered = Buffer.from(JSON.stringify({ ...json, iat: json.iat + 999 })).toString('base64url');
  const otherSecretCfg = { ...readCheckoutConfig(ENV).config, operationSecret: 'another-secret-another-secret-12345' };
  const futureCfg = readCheckoutConfig(ENV).config;
  const bad = [
    `${tampered}.${mac}`,
    `${payload}.${mac.slice(0, -2)}AA`,
    issueOperation(otherSecretCfg, { now: () => T0, attribution: {} }),
    issueOperation(futureCfg, { now: () => T0 + 3600_000, attribution: {} }),
    'abc', '', 'a.b.c', `${payload}.`, 'x'.repeat(800), 42, null,
  ];
  for (const t of bad) {
    const r = await call(h, createBody(t));
    assert.equal(r.statusCode, 400, String(t).slice(0, 30));
    assert.equal(r.json().state, 'invalid_operation');
    assert.equal(r.json().message, MESSAGES.reconcile, 'unknown operation is pointed at reconciliation, not "no payment"');
  }
  assert.equal(h.provider.calls.length, 0);
});

test('operation older than Stripe idempotency retention is never re-sent; asks to reconcile', async () => {
  const h = setup();
  const token = await start(h);
  h.time.t = T0 + (OPERATION_MAX_AGE_S - 60) * 1000;
  let r = await call(h, createBody(token));
  assert.equal(r.json().state, 'redirect', 'still valid inside the window');
  h.time.t = T0 + (OPERATION_MAX_AGE_S + 1) * 1000;
  r = await call(h, createBody(token));
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().state, 'reconcile');
  assert.match(r.json().message, /could not confirm the status of your earlier checkout attempt/);
  assert.match(r.json().message, /support@revivex\.store/);
  assert.doesNotMatch(r.json().message, /No payment|not charged/i);
  h.time.t = T0 + 25 * 3600 * 1000;
  r = await call(h, createBody(token));
  assert.equal(r.json().state, 'reconcile');
  assert.equal(creates(h.provider).length, 1, 'aged operation never re-sent to Stripe');
});

test('price, product, account, mode, terms or origin changed during an uncertain attempt: reconcile, never re-key', async () => {
  const changes = [
    { STRIPE_DEPOSIT_PRICE_ID: 'price_NEWPRICE0001' },
    { STRIPE_DEPOSIT_PRODUCT_ID: 'prod_NEWPRODUCT01' },
    { STRIPE_EXPECTED_ACCOUNT_ID: 'acct_NEWACCOUNT01' },
    { REVIVEX_SITE_ORIGIN: 'https://reserve.example.com' },
  ];
  for (const change of changes) {
    let env = ENV;
    const provider = fakeProvider({ createCheckoutSession: async (p, k) => { provider.calls.push(['create', p, k]); throw new StripeCallError('timeout'); } });
    const h = setup({ env: () => env, provider });
    const token = await start(h);
    let r = await call(h, createBody(token));
    assert.equal(r.json().state, 'uncertain');
    env = { ...ENV, ...change };
    const origin = env.REVIVEX_SITE_ORIGIN;
    r = await call(h, createBody(token), { headers: { origin } });
    assert.equal(r.statusCode, 409, JSON.stringify(change));
    assert.equal(r.json().state, 'reconcile');
    assert.equal(creates(provider).length, 1, 'no second create with a different binding or key');
  }
});

test('Stripe idempotency_error (params differ for a used key) is reconcile, not a silent restart', async () => {
  const h = setup({ provider: fakeProvider({ createCheckoutSession: async () => { throw new StripeCallError('api', { status: 400, type: 'idempotency_error' }); } }) });
  const r = await call(h, createBody(await start(h)));
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().state, 'reconcile');
  assert.equal(r.json().message, MESSAGES.reconcile);
});

test('strict content type, body size and JSON shape', async () => {
  const h = setup();
  let r = await call(h, startBody(), { headers: { 'content-type': 'text/plain' } });
  assert.equal(r.statusCode, 415);
  r = await call(h, 'step=start', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.statusCode, 415);
  r = await call(h, startBody({ pad: 'x'.repeat(3000) }));
  assert.equal(r.statusCode, 413);
  r = await call(h, JSON.stringify(startBody()).padEnd(2500, ' '), { headers: { 'content-length': undefined } });
  assert.equal(r.statusCode, 413, 'stream limit applies without content-length');
  r = await call(h, '{not json');
  assert.equal(r.statusCode, 400);
  r = await call(h, '[1,2]');
  assert.equal(r.statusCode, 400);
  assert.equal(h.provider.calls.length, 0);
});

test('same-origin protection: wrong or missing Origin and cross-site fetch metadata are refused', async () => {
  for (const headers of [{ origin: 'https://evil.example' }, { origin: undefined }, { origin: 'http://revivex-launch.vercel.app' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    const h = setup();
    const r = await call(h, startBody(), { headers });
    assert.equal(r.statusCode, 403, JSON.stringify(headers));
  }
  const h = setup();
  const r = await call(h, startBody(), { headers: { 'sec-fetch-site': undefined } });
  assert.equal(r.statusCode, 200, 'older browsers without Sec-Fetch-Site still pass on exact Origin');
});

test('missing or inconsistent configuration fails closed with no Stripe request', async () => {
  const variants = [
    {}, // nothing configured (current production)
    { ...ENV, REVIVEX_CHECKOUT_ENABLED: 'false' },
    { ...ENV, STRIPE_SECRET_KEY: '' },
    { ...ENV, STRIPE_SECRET_KEY: 'sk_live_FAKEFAKEFAKEFAKEFAKE1234' },
    { ...ENV, STRIPE_MODE: 'live' },
    { ...ENV, STRIPE_EXPECTED_ACCOUNT_ID: '' },
    { ...ENV, STRIPE_DEPOSIT_PRICE_ID: 'prod_wrongtype' },
    { ...ENV, STRIPE_DEPOSIT_PRODUCT_ID: '' },
    { ...ENV, REVIVEX_SITE_ORIGIN: 'http://revivex-launch.vercel.app' },
    { ...ENV, REVIVEX_SITE_ORIGIN: 'https://revivex-launch.vercel.app/path' },
    { ...ENV, REVIVEX_OPERATION_SIGNING_SECRET: '' },
    { ...ENV, REVIVEX_OPERATION_SIGNING_SECRET: 'short' },
  ];
  for (const env of variants) {
    const h = setup({ env });
    for (const body of [startBody(), createBody('x.y')]) {
      const r = await call(h, body);
      assert.equal(r.statusCode, 503, JSON.stringify(Object.keys(env)));
      assert.equal(r.json().state, 'unavailable');
      assert.equal(r.json().operation, undefined);
    }
    assert.equal(h.factoryCalls(), 0);
  }
});

test('live mode requires explicit approval of this exact terms version', () => {
  const live = { ...ENV, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_FAKEFAKEFAKEFAKEFAKE1234' };
  assert.deepEqual(readCheckoutConfig(live).problems, ['REVIVEX_LIVE_APPROVED_TERMS_VERSION']);
  assert.equal(readCheckoutConfig({ ...live, REVIVEX_LIVE_APPROVED_TERMS_VERSION: 'deposit-terms-v0' }).ok, false);
  const ok = readCheckoutConfig({ ...live, REVIVEX_LIVE_APPROVED_TERMS_VERSION: 'deposit-terms-v1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.live, true);
  assert.equal(readCheckoutConfig({ ...live, REVIVEX_LIVE_APPROVED_TERMS_VERSION: 'deposit-terms-v1', REVIVEX_SITE_ORIGIN: 'http://127.0.0.1:4310' }).ok, false, 'no plain-HTTP origin in live mode');
  assert.equal(readCheckoutConfig({ ...ENV, REVIVEX_SITE_ORIGIN: 'http://127.0.0.1:4310' }).ok, true, 'loopback harness allowed in test mode');
});

test('wrong merchant account, disabled charges, or wrong mode/price/product fail closed before create', async () => {
  const bad = [
    { getAccount: async () => account({ id: 'acct_SOMEONEELSE' }) },
    { getAccount: async () => account({ charges_enabled: false }) },
    { getPrice: async () => price({ livemode: true }) },
    { getPrice: async () => price({ unit_amount: 9999 }) },
    { getPrice: async () => price({ unit_amount: 100 }) },
    { getPrice: async () => price({ currency: 'eur' }) },
    { getPrice: async () => price({ active: false }) },
    { getPrice: async () => price({ type: 'recurring', recurring: { interval: 'month' } }) },
    { getPrice: async () => price({ custom_unit_amount: { minimum: 100 } }) },
    { getPrice: async () => price({ billing_scheme: 'tiered' }) },
    { getPrice: async () => price({ currency_options: { usd: {}, eur: { unit_amount: 9000 } } }) },
    { getPrice: async () => price({ product: product({ id: 'prod_OTHER0001' }) }) },
    { getPrice: async () => price({ product: product({ active: false }) }) },
    { getPrice: async () => price({ product: 'prod_TESTDEPOSIT01' }) },
    { getPrice: async () => price({ id: 'price_OTHER00001' }) },
  ];
  for (const o of bad) {
    const provider = fakeProvider(o);
    const h = setup({ provider });
    const r = await call(h, createBody(await start(h)));
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().state, 'unavailable');
    assert.equal(r.json().message, MESSAGES.unavailable);
    assert.equal(creates(provider).length, 0, 'no session created');
    assert.match(h.sink.lines.join('\n'), /deposit_merchant_verification_failed/);
  }
});

test('created session must match amount, currency, mode, metadata and Stripe-hosted URL', async () => {
  const bad = [
    session({ amount_total: 100 }), session({ currency: 'eur' }), session({ livemode: true }),
    session({ id: 'cs_live_SYNTHabcdefgh' }), session({ mode: 'subscription' }),
    session({ metadata: { purpose: 'other', terms_version: 'deposit-terms-v1' } }),
    session({ url: 'https://evil.example/c/pay/cs_test_x' }), session({ url: 'https://checkout.stripe.com.evil.example/x' }),
    session({ url: null }), session({ object: 'payment_link' }),
  ];
  for (const s of bad) {
    const h = setup({ provider: fakeProvider({ createCheckoutSession: async () => s }) });
    const r = await call(h, createBody(await start(h)));
    assert.equal(r.statusCode, 502, JSON.stringify(s).slice(0, 80));
    assert.equal(r.json().state, 'unavailable');
    assert.equal(r.json().url, undefined, 'never redirect to an unverified URL');
  }
});

test('failure states: pre-write is retry/unavailable; after create is uncertain (never claims no payment)', async () => {
  const cases = [
    ['verify', new StripeCallError('api', { status: 401, type: 'invalid_request_error' }), 503, 'unavailable'],
    ['verify', new StripeCallError('timeout'), 503, 'retry'],
    ['verify', new StripeCallError('api', { status: 500, type: 'api_error' }), 503, 'retry'],
    ['create', new StripeCallError('timeout'), 503, 'uncertain'],
    ['create', new StripeCallError('network'), 503, 'uncertain'],
    ['create', new StripeCallError('api', { status: 500, type: 'api_error' }), 503, 'uncertain'],
    ['create', new StripeCallError('api', { status: 429, type: 'rate_limit_error' }), 503, 'uncertain'],
    ['create', new StripeCallError('api', { status: 409, type: 'idempotency_error' }), 503, 'uncertain'],
    ['create', new StripeCallError('api', { status: 400, type: 'invalid_request_error', code: 'parameter_unknown' }), 503, 'unavailable'],
    ['create', new Error('boom'), 503, 'uncertain'],
  ];
  for (const [where, err, status, state] of cases) {
    const o = where === 'verify' ? { getAccount: async () => { throw err; } } : { createCheckoutSession: async () => { throw err; } };
    const h = setup({ provider: fakeProvider(o) });
    const r = await call(h, createBody(await start(h)));
    assert.equal(r.statusCode, status, `${where} ${err.message}`);
    const d = r.json();
    assert.equal(d.state, state);
    assert.equal(d.ok, false);
    assert.equal(d.url, undefined);
    assert.equal(d.message, MESSAGES[state]);
    assert.doesNotMatch(d.message, /No payment has been taken|not been charged|were not charged/i);
    if (state === 'uncertain') assert.match(d.message, /Check your payment confirmation before trying again/);
  }
});

test('same operation always maps to the same idempotency key and identical params; operations differ', async () => {
  const keys = [];
  const bodies = [];
  const provider = fakeProvider({ createCheckoutSession: async (p, k) => { keys.push(k); bodies.push(JSON.stringify(p)); return session(); } });
  const h = setup({ provider });
  const a = await start(h);
  const b = await start(h);
  await call(h, createBody(a));
  h.time.t += 3600_000; // retry an hour later, e.g. after reload
  await call(h, createBody(a));
  await call(h, createBody(b));
  assert.equal(keys[0], keys[1]);
  assert.equal(bodies[0], bodies[1]);
  assert.notEqual(keys[0], keys[2]);
  const op = readOperation(a, SIGNING, T0).op;
  assert.equal(keys[0], idempotencyKeyFor(op));
  assert.equal(JSON.stringify(checkoutSessionParams(readCheckoutConfig(ENV).config, op)), bodies[0]);
});

test('concurrent duplicate clicks send identical idempotent creates (Stripe returns one session)', async () => {
  const byKey = new Map();
  const provider = fakeProvider({
    createCheckoutSession: async (p, k) => {
      if (byKey.has(k)) { const v = byKey.get(k); if (v === 'busy') throw new StripeCallError('api', { status: 409, type: 'idempotency_error' }); return v; }
      byKey.set(k, 'busy');
      await new Promise(r => setTimeout(r, 20));
      const s = session(); byKey.set(k, s); return s;
    },
  });
  const h = setup({ provider });
  const token = await start(h);
  const [a, b] = await Promise.all([call(h, createBody(token)), call(h, createBody(token))]);
  assert.deepEqual([a.json().state, b.json().state].sort(), ['redirect', 'uncertain']);
  const c = await call(h, createBody(token));
  assert.equal(c.json().url, a.json().url || b.json().url, 'retry replays the same session');
  assert.equal(byKey.size, 1);
});

test('replayed session that is already complete routes to the receipt; expired asks for a new attempt', async () => {
  let h = setup({ provider: fakeProvider({ createCheckoutSession: async () => session({ id: 'cs_test_DONE0000001', status: 'complete', payment_status: 'paid', url: null }) }) });
  let r = await call(h, createBody(await start(h)));
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().state, r.json().reservationUrl], ['complete', '/reservation.html?session_id=cs_test_DONE0000001']);
  h = setup({ provider: fakeProvider({ createCheckoutSession: async () => session({ status: 'expired', url: null }) }) });
  r = await call(h, createBody(await start(h)));
  assert.equal(r.statusCode, 410);
  assert.equal(r.json().state, 'expired');
});

test('attribution: allowlisted values bound at start into session + payment intent metadata', async () => {
  const h = setup();
  const token = await start(h, { attribution: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'morning_simplified_preorder', utm_content: 'angle_03' } });
  await call(h, createBody(token));
  const [[, params]] = creates(h.provider);
  for (const m of [params.metadata, params.payment_intent_data.metadata]) {
    assert.equal(m.utm_source, 'meta');
    assert.equal(m.utm_medium, 'paid_social');
    assert.equal(m.utm_campaign, 'morning_simplified_preorder');
    assert.equal(m.utm_content, 'angle_03');
    assert.equal(m.purpose, 'revivex_preorder_deposit', 'attribution cannot override purpose');
  }
});

test('attribution: malicious, oversize, unknown and non-allowlisted values are dropped, never rejected or stored', async () => {
  const h = setup();
  const token = await start(h, { attribution: {
    utm_source: 'https://evil.example/?email=a@b.co', utm_medium: 'cpc', utm_campaign: 'other_campaign', utm_content: 'x'.repeat(41),
    gclid: 'abc', fbclid: 'def', utm_term: 'blood_test', email: 'a@b.co', referrer: 'https://x', purpose: 'hijack', terms_version: 'v0', __proto__: { polluted: 1 },
  } });
  await call(h, createBody(token));
  const [[, params]] = creates(h.provider);
  assert.deepEqual(Object.keys(params.metadata).sort(), ['operation', 'purpose', 'terms_version']);
  assert.equal(params.metadata.purpose, 'revivex_preorder_deposit');
  for (const bad of ['UPPER', 'has space', 'semi;colon', '<script>', '../x', 'a@b.co', 'ünicode', '']) {
    const h2 = setup();
    const t = await start(h2, { attribution: { utm_source: bad, utm_content: bad } });
    await call(h2, createBody(t));
    assert.equal(creates(h2.provider)[0][1].metadata.utm_source, undefined, bad);
  }
  for (const attribution of ['meta', ['meta'], 42, null]) {
    const r = await call(setup(), startBody({ attribution }));
    assert.equal(r.json().state, 'started', 'bad attribution shape never blocks a deposit');
  }
});

test('attribution: changed later attribution cannot alter a started operation (no idempotency mismatch)', async () => {
  const keys = [], bodies = [];
  const provider = fakeProvider({ createCheckoutSession: async (p, k) => { keys.push(k); bodies.push(JSON.stringify(p)); return session(); } });
  const h = setup({ provider });
  const token = await start(h, { attribution: { utm_source: 'instagram', utm_medium: 'organic_social' } });
  await call(h, createBody(token));
  const r = await call(h, createBody(token, { attribution: { utm_source: 'x' } }));
  assert.equal(r.json().state, 'unexpected_field', 'create cannot carry new attribution');
  await call(h, createBody(token));
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[0]).metadata.utm_source, 'instagram');
});

test('best-effort instance rate limit returns 429 with Retry-After before calling Stripe', async () => {
  const provider = fakeProvider();
  const h = setup({ provider, limiter: createInstanceRateLimiter({ limit: 3, windowMs: 60_000 }) });
  const token = await start(h);
  await call(h, createBody(token)); await call(h, createBody(token));
  const r = await call(h, createBody(token));
  assert.equal(r.statusCode, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  assert.equal(creates(provider).length, 2);
});

test('GET status exposes availability and the official contact only; method gate', async () => {
  let h = setup();
  let r = res();
  await h.handler(req({ method: 'GET' }), r);
  assert.deepEqual(r.json(), { ok: true, available: true, mode: 'test', amount: 10000, currency: 'usd', termsVersion: 'deposit-terms-v1', supportEmail: 'support@revivex.store' });
  assert.ok(!r.body.includes(SECRET) && !r.body.includes('acct_') && !r.body.includes('price_') && !r.body.includes('signing'));
  assert.equal(h.provider.calls.length, 0);

  h = setup({ env: {} });
  r = res();
  await h.handler(req({ method: 'GET' }), r);
  assert.equal(r.json().available, false);
  assert.equal(r.json().mode, null);
  assert.equal(r.json().supportEmail, 'support@revivex.store', 'contact stays visible for existing depositors');

  for (const method of ['PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    r = res();
    await h.handler(req({ method }), r);
    assert.equal(r.statusCode, 405);
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS');
  }
});

test('logs contain event codes only: no secret, signing key, email, name, token, attribution or session URL', async () => {
  const lines = [];
  const run = async provider => {
    const h = setup({ provider });
    const token = await start(h, { attribution: { utm_source: 'linkedin', utm_content: 'founder_note' } });
    await call(h, createBody(token));
    await call(h, createBody(token.slice(0, -3) + 'AAA'));
    lines.push(...h.sink.lines);
    return token;
  };
  const tokens = [
    await run(fakeProvider({ createCheckoutSession: async () => { throw new StripeCallError('api', { status: 500, type: 'api_error', requestId: 'req_123' }); } })),
    await run(fakeProvider({ getAccount: async () => account({ id: 'acct_OTHER' }) })),
    await run(fakeProvider()),
  ];
  const all = lines.join('\n');
  assert.ok(all.length > 0);
  for (const forbidden of [SECRET, SIGNING, 'buyer-pii@example.test', 'Pat Example', 'owner@example.test', 'checkout.stripe.com', 'cs_secret', 'linkedin', 'founder_note', ...tokens, ...tokens.map(t => t.split('.')[1])]) {
    assert.ok(!all.includes(forbidden), `log leaked ${forbidden}`);
  }
  assert.match(all, /req_123/);
});
