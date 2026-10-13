// LOCAL/MOCK tests: Stripe REST request encoding against a fake fetch, the real
// default Vercel exports with production-like (empty) env, the closed signup route
// and vercel.json routing. No network request leaves this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStripeRestProvider, encodeForm, StripeCallError } from '../../lib/stripe-rest.js';
import { checkoutSessionParams } from '../../lib/deposit-handlers.js';
import { issueOperation, readOperation } from '../../lib/operation-token.js';
import { readCheckoutConfig, STRIPE_API_VERSION } from '../../lib/deposit-config.js';
import { ENV, SECRET, SIGNING, req, res, startBody, createBody } from '../fixtures/deposit-fixtures.mjs';

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  f.calls = calls;
  return f;
}
const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('create sends form-encoded exact params, pinned API version and Idempotency-Key', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { id: 'cs_test_x', object: 'checkout.session' }));
  const p = createStripeRestProvider({ secretKey: SECRET, fetchImpl });
  const cfg = readCheckoutConfig(ENV).config;
  const op = readOperation(issueOperation(cfg, { now: Date.now, attribution: { utm_source: 'x', utm_campaign: 'morning_simplified_preorder' } }), SIGNING, Date.now()).op;
  await p.createCheckoutSession(checkoutSessionParams(cfg, op), 'rvx-deposit-v1-abc');
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(init.headers['Stripe-Version'], STRIPE_API_VERSION);
  assert.equal(init.headers['Idempotency-Key'], 'rvx-deposit-v1-abc');
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(init.body);
  assert.equal(form.get('mode'), 'payment');
  assert.equal(form.get('line_items[0][price]'), 'price_TESTDEPOSIT01');
  assert.equal(form.get('line_items[0][quantity]'), '1');
  assert.equal(form.get('payment_method_types[0]'), null, 'rejected by API 2026-09-30.endive');
  assert.equal(form.get('allowed_payment_method_types[0]'), 'card');
  assert.equal(form.get('allowed_payment_method_types[1]'), null);
  assert.equal(form.get('branding_settings[display_name]'), 'Revivex');
  assert.equal(form.get('adaptive_pricing[enabled]'), 'false');
  assert.equal(form.get('success_url'), 'https://revivex-launch.vercel.app/reservation.html?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(form.get('metadata[terms_version]'), 'deposit-terms-v2');
  assert.equal(form.get('payment_intent_data[metadata][purpose]'), 'revivex_preorder_deposit');
  assert.equal(form.get('metadata[utm_campaign]'), 'morning_simplified_preorder');
  assert.equal(form.get('payment_intent_data[metadata][utm_source]'), 'x');
  assert.ok(![...form.keys()].some(k => /amount|price_data|setup_future_usage|automatic_tax|shipping|discount|subscription|gclid|fbclid|referrer|email/.test(k)), [...form.keys()].join());
});

test('GET calls expand the objects needed for verification and send no idempotency key', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { id: 'x' }));
  const p = createStripeRestProvider({ secretKey: SECRET, fetchImpl });
  await p.getAccount();
  await p.getPrice('price_TESTDEPOSIT01');
  await p.retrieveCheckoutSession('cs_test_abcdefgh');
  const urls = fetchImpl.calls.map(c => decodeURIComponent(c.url));
  assert.deepEqual(urls, [
    'https://api.stripe.com/v1/account',
    'https://api.stripe.com/v1/prices/price_TESTDEPOSIT01?expand[]=product&expand[]=currency_options',
    'https://api.stripe.com/v1/checkout/sessions/cs_test_abcdefgh?expand[]=line_items&expand[]=payment_intent.latest_charge',
  ]);
  for (const c of fetchImpl.calls) { assert.equal(c.init.method, 'GET'); assert.equal(c.init.headers['Idempotency-Key'], undefined); assert.equal(c.init.body, undefined); }
});

test('classifies timeout, network and API errors (with request id) and never retries a write', async () => {
  let fetchImpl = fakeFetch((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  let p = createStripeRestProvider({ secretKey: SECRET, fetchImpl, timeoutMs: 30, createTimeoutMs: 30 });
  await assert.rejects(p.createCheckoutSession({ mode: 'payment' }, 'k'), e => e instanceof StripeCallError && e.kind === 'timeout');
  assert.equal(fetchImpl.calls.length, 1, 'no automatic retry of create');

  fetchImpl = fakeFetch(() => { throw new TypeError('fetch failed'); });
  p = createStripeRestProvider({ secretKey: SECRET, fetchImpl });
  await assert.rejects(p.getAccount(), e => e.kind === 'network');

  fetchImpl = fakeFetch(() => jsonResponse(400, { error: { type: 'idempotency_error', message: `secret ${SECRET}` } }, { 'request-id': 'req_abc' }));
  p = createStripeRestProvider({ secretKey: SECRET, fetchImpl });
  await assert.rejects(p.createCheckoutSession({}, 'k'), e => e.kind === 'api' && e.status === 400 && e.type === 'idempotency_error' && e.requestId === 'req_abc' && !e.message.includes(SECRET));

  fetchImpl = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
  p = createStripeRestProvider({ secretKey: SECRET, fetchImpl });
  await assert.rejects(p.getAccount(), e => e.kind === 'api' && e.status === 502);
});

test('encodeForm handles nested objects and arrays like Stripe expects', () => {
  assert.equal(encodeForm({ a: [{ b: 1 }], c: { d: { e: 'x y' } }, skip: undefined, n: null, f: false }).toString(), 'a%5B0%5D%5Bb%5D=1&c%5Bd%5D%5Be%5D=x+y&f=false');
});

test('real default Vercel exports fail closed with an unconfigured (production) environment and make no network call', async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(STRIPE_|REVIVEX_)/.test(k)) delete process.env[k];
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('network forbidden in tests'); };
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const { default: checkout } = await import('../../api/checkout.js');
    const { default: reservation } = await import('../../api/reservation.js');
    let r = res();
    await checkout(req({ body: startBody() }), r);
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().operation, undefined);
    r = res();
    await checkout(req({ body: createBody('a.b') }), r);
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().state, 'unavailable');
    assert.equal(r.json().url, undefined);
    r = res();
    await checkout(req({ method: 'GET' }), r);
    assert.equal(r.json().configured, false);
    r = res();
    await reservation(req({ method: 'GET', url: '/api/reservation?session_id=cs_test_abcdefghij' }), r);
    assert.equal(r.statusCode, 503);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    process.env = saved;
  }
});

test('legacy signup route never reports success and never logs the address', async () => {
  const { default: signup } = await import('../../api/signup.js');
  const logs = [];
  const realLog = console.log, realErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    const r = res();
    await signup(req({ url: '/api/signup', body: { email: 'pii-person@example.test', consent: true, website: '', source: 'landing-v11' } }), r);
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().ok, false);
    assert.doesNotMatch(r.body, /interest is saved|on the list/i);
    assert.match(r.body, /Nothing was saved/);
    const g = res();
    await signup(req({ method: 'GET', url: '/api/signup' }), g);
    assert.equal(g.statusCode, 405);
    assert.equal(logs.join('').includes('pii-person'), false);
  } finally { console.log = realLog; console.error = realErr; }
});

test('vercel.json routes new APIs before the static catch-all with no-store headers', () => {
  const v = JSON.parse(fs.readFileSync(new URL('../../vercel.json', import.meta.url)));
  const srcs = v.routes.map(r => r.src);
  const catchAll = srcs.indexOf('/(.*)');
  for (const [src, dest] of [['/api/checkout', '/api/checkout.js'], ['/api/reservation', '/api/reservation.js'], ['/api/signup', '/api/signup.js']]) {
    const i = srcs.indexOf(src);
    assert.ok(i > -1 && i < catchAll, src);
    assert.equal(v.routes[i].dest, dest);
  }
  for (const src of ['/api/checkout', '/api/reservation', '/reservation\\.html']) {
    assert.equal(v.routes[srcs.indexOf(src)].headers['Cache-Control'], 'no-store');
  }
  assert.ok(v.builds.some(b => b.src === 'api/*.js' && b.use === '@vercel/node'));
});

test('no secret-looking values or test fixtures are committed into served/public code', () => {
  const files = ['public/app.js', 'public/legal.js', 'public/reservation.js', 'public/index.html', 'public/deposit-terms.html', 'public/privacy.html', 'public/reservation.html', 'lib/deposit-config.js', 'lib/deposit-handlers.js', 'lib/stripe-rest.js', 'lib/http.js', 'api/checkout.js', 'api/reservation.js', 'vercel.json'];
  for (const f of files) {
    const s = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/, f);
    assert.doesNotMatch(s, /whsec_[A-Za-z0-9]/, f);
    assert.doesNotMatch(s, /acct_[A-Za-z0-9]{6,}/, f);
    assert.doesNotMatch(s, /example\.test|synthetic/i, f);
  }
});

test('timeout covers the response body: a hung or trickling body is classified as timeout', async () => {
  const hung = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"id":')); /* never closes */ } }), { status: 200, headers: { 'request-id': 'req_hung' } });
  let fetchImpl = fakeFetch(hung);
  let p = createStripeRestProvider({ secretKey: SECRET, fetchImpl, timeoutMs: 40, createTimeoutMs: 40 });
  const t0 = Date.now();
  await assert.rejects(p.getAccount(), e => e instanceof StripeCallError && e.kind === 'timeout');
  await assert.rejects(p.createCheckoutSession({ mode: 'payment' }, 'k'), e => e.kind === 'timeout');
  assert.ok(Date.now() - t0 < 1000, 'bounded by the deadline, not the body');
  assert.equal(fetchImpl.calls.length, 2, 'no retry');
  assert.ok(fetchImpl.calls.every(c => c.init.signal.aborted), 'request aborted on timeout');

  // Slow headers then fast body still share one deadline.
  fetchImpl = fakeFetch(() => new Promise(r => setTimeout(() => r(hung()), 30)));
  p = createStripeRestProvider({ secretKey: SECRET, fetchImpl, timeoutMs: 50 });
  await assert.rejects(p.getAccount(), e => e.kind === 'timeout');

  // Oversized body is rejected without echoing content.
  fetchImpl = fakeFetch(() => new Response('x'.repeat(1024 * 1024 + 10), { status: 200 }));
  p = createStripeRestProvider({ secretKey: SECRET, fetchImpl });
  await assert.rejects(p.getAccount(), e => e.kind === 'api' && e.type === 'response_too_large');
});

test('Stripe error bodies (messages, PII) never reach the browser response or logs', async () => {
  const { createCheckoutHandler } = await import('../../lib/deposit-handlers.js');
  const { makeLogger } = await import('../../lib/http.js');
  const lines = [];
  const leaky = JSON.stringify({ error: { type: 'card_error', code: 'card_declined', message: 'Customer buyer-pii@example.test card 4242 declined', param: 'customer_email' } });
  const fetchImpl = async url => (String(url).includes('/v1/account')
    ? new Response(JSON.stringify({ id: 'acct_TESTREVIVEX01', object: 'account', charges_enabled: true }), { status: 200 })
    : String(url).includes('/v1/prices/')
      ? new Response(JSON.stringify({ id: 'price_TESTDEPOSIT01', object: 'price', active: true, livemode: false, type: 'one_time', billing_scheme: 'per_unit', currency: 'usd', unit_amount: 10000, product: { id: 'prod_TESTDEPOSIT01', active: true } }), { status: 200 })
      : new Response(leaky, { status: 402, headers: { 'request-id': 'req_leak' } }));
  const h = createCheckoutHandler({ getEnv: () => ENV, providerFactory: cfg => createStripeRestProvider({ secretKey: cfg.secretKey, fetchImpl }), log: makeLogger({ log: l => lines.push(l) }) });
  let r = res();
  await h(req({ body: startBody() }), r);
  const token = r.json().operation;
  r = res();
  await h(req({ body: createBody(token) }), r);
  assert.equal(r.json().state, 'unavailable');
  const out = r.body + lines.join('\n');
  for (const leak of ['buyer-pii', '4242', 'card 4242 declined', SECRET]) assert.ok(!out.includes(leak), leak);
  assert.ok(!r.body.includes('customer_email'), 'param name not sent to the browser');
  assert.match(lines.join('\n'), /card_declined/);
  assert.match(lines.join('\n'), /"param":"customer_email"/, 'parameter NAME is logged for diagnosis (never message text)');
});
