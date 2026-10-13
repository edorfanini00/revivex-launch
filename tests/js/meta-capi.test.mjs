// Meta Conversions API (lib/meta-capi.js) and its hooks in the deposit handlers.
// LOCAL/MOCK only: Meta and Stripe are fakes; no network request leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CAPI_SENDS_PER_MINUTE, CAPI_TIMEOUT_MS, GRAPH_API_VERSION, createMetaCapi, hashEmail, readCookie, userData } from '../../lib/meta-capi.js';
import { PURCHASE_REPORT_WINDOW_MS, checkoutSessionParams, createCheckoutHandler, createReservationHandler } from '../../lib/deposit-handlers.js';
import { DEPOSIT, readCheckoutConfig } from '../../lib/deposit-config.js';
import { readOperation } from '../../lib/operation-token.js';
import { createInstanceRateLimiter, makeLogger } from '../../lib/http.js';
import { META_PIXEL_ID } from '../../public/meta-pixel-id.js';
import { ENV, ORIGIN, SIGNING, createBody, fakeKey, fakeProvider, logSink, paidSession, price, req, res, session, startBody } from '../fixtures/deposit-fixtures.mjs';

const PIXEL = '123456789012345';
const TOKEN = 'EAAG' + 'FAKECAPITOKEN'.repeat(4);
const META_ENV = Object.freeze({ ...ENV, META_CAPI_ACCESS_TOKEN: TOKEN });
// Live mode deposits are the only ones reported to Meta (S3); test mode stays silent.
const LIVE_NO_TOKEN = Object.freeze({ ...ENV, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: fakeKey('sk', 'live'), REVIVEX_LIVE_APPROVED_TERMS_VERSION: DEPOSIT.termsVersion });
const LIVE_ENV = Object.freeze({ ...LIVE_NO_TOKEN, META_CAPI_ACCESS_TOKEN: TOKEN });
const LIVE = { mode: 'live' };
const FBP = 'fb.1.1700000000000.1234567890';
const FBC = 'fb.1.1700000000000.IwAR2abc_DEF-ghi';
const UA = 'Mozilla/5.0 (Macintosh) SyntheticTestBrowser/1.0';
const SID = 'cs_live_SYNTHPAID0001abcdef';
const T0 = 1_760_000_000_000; // fixed clock for handler tests (ms)
const PAID_AT = T0 / 1000 - 600; // paid ten minutes earlier (unix seconds)
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function fakeMeta(respond = () => new Response('{"events_received":1}', { status: 200 })) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return respond(url, init); };
  return { calls, fetchImpl };
}
const browserHeaders = (o = {}) => ({ 'user-agent': UA, cookie: `other=1; _fbp=${FBP}; _fbc=${FBC}`, 'x-real-ip': '203.0.113.7', ...o });
const settle = () => new Promise(r => setTimeout(r, 0));

// ---------------- library ----------------

test('no-op without META_CAPI_ACCESS_TOKEN or with the placeholder pixel id (no request at all)', async () => {
  const meta = fakeMeta();
  const withId = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl });
  for (const env of [ENV, { ...ENV, META_CAPI_ACCESS_TOKEN: '' }, { ...ENV, META_CAPI_ACCESS_TOKEN: '   ' }, undefined]) {
    assert.deepEqual(await withId.track(env, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x' }), { ok: false, skipped: 'unconfigured' });
  }
  const placeholder = createMetaCapi({ pixelId: 'REVIVEX_PIXEL_ID_PLACEHOLDER', fetchImpl: meta.fetchImpl });
  assert.deepEqual(await placeholder.track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x' }), { ok: false, skipped: 'unconfigured' });
  assert.equal(meta.calls.length, 0);
});

test('server default pixel id is the shared constant from public/meta-pixel-id.js', async () => {
  const meta = fakeMeta();
  const r = await createMetaCapi({ fetchImpl: meta.fetchImpl }).track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x', ...LIVE });
  if (META_PIXEL_ID === 'REVIVEX_PIXEL_ID_PLACEHOLDER') return assert.deepEqual(r, { ok: false, skipped: 'unconfigured' });
  assert.deepEqual(r, { ok: true });
  assert.equal(meta.calls[0].url, `https://graph.facebook.com/${GRAPH_API_VERSION}/${META_PIXEL_ID}/events`);
});

test('Global Privacy Control (Sec-GPC: 1): nothing is sent to Meta', async () => {
  const meta = fakeMeta();
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl });
  const r = await capi.track(META_ENV, req({ headers: browserHeaders({ 'sec-gpc': '1' }) }), { name: 'Purchase', eventId: 'deposit_x', ...LIVE });
  assert.deepEqual(r, { ok: false, skipped: 'gpc' });
  assert.equal(meta.calls.length, 0);
});

test('payload: dedup event id, deposit value, fbp/fbc/IP/UA, SHA-256 email; no raw PII, token only in the body', async () => {
  const meta = fakeMeta();
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl, now: () => 1_760_000_000_123 });
  const r = await capi.track(META_ENV, req({ method: 'GET', url: '/api/reservation', headers: browserHeaders() }), { name: 'Purchase', eventId: `deposit_${SID}`, sourceUrl: `${ORIGIN}/reservation.html`, email: '  Buyer-PII@Example.TEST ', ...LIVE });
  assert.deepEqual(r, { ok: true });
  assert.equal(meta.calls.length, 1);
  const { url, init, body } = meta.calls[0];
  assert.equal(url, `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL}/events`);
  assert.ok(!url.includes(TOKEN), 'token never in the URL');
  assert.equal(init.method, 'POST');
  assert.equal(body.access_token, TOKEN);
  assert.equal(body.test_event_code, undefined);
  assert.deepEqual(body.data, [{
    event_name: 'Purchase',
    event_time: 1_760_000_000,
    event_id: `deposit_${SID}`,
    action_source: 'website',
    event_source_url: `${ORIGIN}/reservation.html`,
    user_data: { client_ip_address: '203.0.113.7', client_user_agent: UA, fbp: FBP, fbc: FBC, em: [sha('buyer-pii@example.test')] },
    custom_data: { content_name: 'Revivex machine preorder deposit', value: 100, currency: 'USD' },
  }]);
  assert.ok(!init.body.toLowerCase().includes('buyer-pii'), 'raw email never sent');
  assert.match(body.data[0].user_data.em[0], /^[0-9a-f]{64}$/);
});

test('email hashing and cookie parsing rules', () => {
  assert.equal(hashEmail('A@B.co'), sha('a@b.co'));
  for (const bad of [undefined, null, '', 'not-an-email', 'a b@c.d', 42]) assert.equal(hashEmail(bad), null, String(bad));
  assert.equal(readCookie('a=1; _fbp=fb.1.2.3', '_fbp'), 'fb.1.2.3');
  assert.equal(readCookie('x_fbp=1', '_fbp'), null);
  // Malformed or oversized cookies are dropped; no email -> no em field; non-IP -> no IP.
  const ud = userData(req({ method: 'GET', headers: { cookie: '_fbp=<script>; _fbc=fb.1.1700000000000.' + 'a'.repeat(500), 'x-real-ip': 'unknown' } }));
  assert.deepEqual(ud, {});
});

test('optional META_TEST_EVENT_CODE is passed only when well formed', async () => {
  const meta = fakeMeta();
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl });
  await capi.track({ ...META_ENV, META_TEST_EVENT_CODE: 'TEST12345' }, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x', ...LIVE });
  await capi.track({ ...META_ENV, META_TEST_EVENT_CODE: 'bogus value' }, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x', ...LIVE });
  assert.equal(meta.calls[0].body.test_event_code, 'TEST12345');
  assert.equal(meta.calls[1].body.test_event_code, undefined);
});

test('timeout: a hung Meta request is aborted quickly, never throws, and the token is never logged', async () => {
  const sink = logSink();
  let aborted = false;
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl, timeoutMs: 40, log: makeLogger(sink) });
  const t0 = Date.now();
  const r = await capi.track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x', email: 'buyer-pii@example.test', ...LIVE });
  assert.deepEqual(r, { ok: false, kind: 'timeout' });
  assert.ok(aborted);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(CAPI_TIMEOUT_MS <= 2000, 'default timeout stays short');
  const logged = sink.lines.join('\n');
  assert.match(logged, /meta_capi_failed/);
  assert.ok(!logged.includes(TOKEN) && !logged.includes('buyer-pii'), logged);
});

test('Meta error responses and network failures resolve quietly (no token or body in logs)', async () => {
  const sink = logSink();
  const leaky = () => new Response(JSON.stringify({ error: { message: `Invalid OAuth access token ${TOKEN}` } }), { status: 400 });
  let capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: fakeMeta(leaky).fetchImpl, log: makeLogger(sink) });
  assert.deepEqual(await capi.track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x', ...LIVE }), { ok: false, status: 400 });
  capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: async () => { throw new Error(`boom ${TOKEN}`); }, log: makeLogger(sink) });
  assert.deepEqual(await capi.track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x', ...LIVE }), { ok: false, kind: 'network' });
  assert.ok(!sink.lines.join('\n').includes(TOKEN));
  assert.ok(!sink.lines.join('\n').includes('OAuth'));
});

test('S3: test mode (or unknown mode) deposits are never sent to the live dataset', async () => {
  const meta = fakeMeta();
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl });
  for (const mode of ['test', undefined, '', 'LIVE']) {
    assert.deepEqual(await capi.track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x', mode }), { ok: false, skipped: 'test_mode' }, String(mode));
  }
  assert.equal(meta.calls.length, 0);
});

test('S1: event_time is the payment time when given', async () => {
  const meta = fakeMeta();
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl, now: () => T0 });
  await capi.track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x', eventTime: PAID_AT, ...LIVE });
  await capi.track(META_ENV, req({ headers: browserHeaders() }), { name: 'InitiateCheckout', eventId: 'op', ...LIVE });
  assert.equal(meta.calls[0].body.data[0].event_time, PAID_AT);
  assert.equal(meta.calls[1].body.data[0].event_time, T0 / 1000);
});

test('S2: per-instance ceiling on CAPI sends per minute', async () => {
  const meta = fakeMeta();
  let t = T0;
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl, now: () => t });
  assert.ok(CAPI_SENDS_PER_MINUTE >= 10 && CAPI_SENDS_PER_MINUTE <= 120, 'small ceiling, above real deposit traffic');
  const send = i => capi.track(META_ENV, req({ headers: browserHeaders({ 'x-real-ip': `203.0.113.${i % 250}` }) }), { name: 'InitiateCheckout', eventId: `op${i}`, ...LIVE });
  const first = await Promise.all(Array.from({ length: CAPI_SENDS_PER_MINUTE + 25 }, (_, i) => send(i)));
  assert.equal(meta.calls.length, CAPI_SENDS_PER_MINUTE);
  assert.equal(first.filter(r => r.skipped === 'rate_limited').length, 25);
  t += 60_000;
  assert.deepEqual(await send(999), { ok: true }, 'next minute sends again');
});

// ---------------- handlers ----------------

// Live mode Stripe stand-ins: a live price, live sessions, and a payment taken at PAID_AT.
const livePrice = () => price({ livemode: true });
let liveSeq = 0;
const liveOpen = () => session({ id: `cs_live_SYNTHOPEN${String(++liveSeq).padStart(4, '0')}abcdef`, livemode: true });
const live = (s, paidAt = PAID_AT) => ({
  ...s,
  livemode: true,
  payment_intent: s.payment_intent && { ...s.payment_intent, livemode: true, created: paidAt - 5, latest_charge: s.payment_intent.latest_charge && { created: paidAt, ...s.payment_intent.latest_charge } },
});
const livePaid = (id, paidAt = PAID_AT, chargeOverrides = {}) => live(paidSession({ id }, {}, chargeOverrides), paidAt);

function checkoutSetup({ env = LIVE_ENV, getEnv = () => env, fetchImpl, timeoutMs, metaCapi: injected } = {}) {
  const meta = fetchImpl ? { calls: [], fetchImpl } : fakeMeta();
  const provider = fakeProvider({ getPrice: async () => livePrice(), createCheckoutSession: async () => liveOpen() });
  if (getEnv().STRIPE_MODE === 'test') Object.assign(provider, fakeProvider());
  const sink = logSink();
  const scheduled = [];
  const metaCapi = injected || createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl, schedule: p => scheduled.push(p), ...(timeoutMs ? { timeoutMs } : {}) });
  const handler = createCheckoutHandler({ getEnv, providerFactory: () => provider, log: makeLogger(sink), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }), metaCapi });
  return { meta, provider, handler, scheduled, sink };
}
async function call(h, rq) { const r = res(); await h(rq, r); return r; }
async function openCheckout(s, headers = browserHeaders()) {
  const token = (await call(s.handler, req({ body: startBody(), headers }))).json().operation;
  const r = await call(s.handler, req({ body: createBody(token), headers }));
  return { token, r, opId: readOperation(token, SIGNING, Date.now()).op.id };
}

test('checkout: InitiateCheckout sent once checkout opens, event id = operation id, value 100 USD', async () => {
  const s = checkoutSetup();
  const start = await call(s.handler, req({ body: startBody(), headers: browserHeaders() }));
  assert.equal(s.meta.calls.length, 0, 'issuing a token is not InitiateCheckout');
  const token = start.json().operation;
  const opId = readOperation(token, SIGNING, Date.now()).op.id;
  const r = await call(s.handler, req({ body: createBody(token), headers: browserHeaders() }));
  assert.equal(r.json().state, 'redirect');
  await Promise.all(s.scheduled);
  assert.equal(s.meta.calls.length, 1);
  const ev = s.meta.calls[0].body.data[0];
  assert.equal(ev.event_name, 'InitiateCheckout');
  assert.equal(ev.event_id, opId);
  assert.equal(ev.event_source_url, `${ORIGIN}/`);
  assert.deepEqual(ev.custom_data, { content_name: 'Revivex machine preorder deposit', value: 100, currency: 'USD' });
  assert.deepEqual(ev.user_data, { client_ip_address: '203.0.113.7', client_user_agent: UA, fbp: FBP, fbc: FBC });
});

test('checkout: no InitiateCheckout when checkout does not open (complete, unavailable, rejected token)', async () => {
  // complete: paying routes to the receipt instead of Stripe
  let s = checkoutSetup();
  const done = livePaid('cs_live_SYNTHDONE0001abcdef');
  s.provider.createCheckoutSession = async () => done;
  s.provider.retrieveCheckoutSession = async () => done;
  let token = (await call(s.handler, req({ body: startBody() }))).json().operation;
  assert.equal((await call(s.handler, req({ body: createBody(token), headers: browserHeaders() }))).json().state, 'complete');
  // unavailable: merchant verification fails
  const s2 = checkoutSetup();
  s2.provider.getAccount = async () => ({ id: 'acct_OTHER0000001', charges_enabled: true });
  token = (await call(s2.handler, req({ body: startBody() }))).json().operation;
  assert.equal((await call(s2.handler, req({ body: createBody(token), headers: browserHeaders() }))).json().state, 'unavailable');
  await call(s2.handler, req({ body: createBody('forged.token'), headers: browserHeaders() }));
  await settle();
  assert.equal(s.meta.calls.length + s2.meta.calls.length, 0);
});

test('checkout: a hung Meta request never delays the response', async () => {
  const hang = () => new Promise(() => {});
  const s = checkoutSetup({ fetchImpl: hang, timeoutMs: 400 });
  const token = (await call(s.handler, req({ body: startBody() }))).json().operation;
  const t0 = Date.now();
  const r = await call(s.handler, req({ body: createBody(token), headers: browserHeaders() }));
  assert.ok(Date.now() - t0 < 150, `took ${Date.now() - t0}ms`);
  assert.equal(r.ended, true);
  assert.equal(r.json().state, 'redirect');
  assert.equal(s.scheduled.length, 1, 'send handed to waitUntil, not awaited');
  assert.deepEqual(await s.scheduled[0], { ok: false, kind: 'timeout' });
});

test('checkout: Stripe session params carry no Meta data; responses are identical with and without the token', async () => {
  const params = checkoutSessionParams(readCheckoutConfig(ENV).config, { id: 'x'.repeat(22), binding: 'b', attribution: {} });
  assert.doesNotMatch(JSON.stringify(params), /fbp|fbc|_fb|facebook/i);
  const bodies = [];
  for (const env of [LIVE_NO_TOKEN, LIVE_ENV]) {
    const s = checkoutSetup({ env });
    let created;
    const create = s.provider.createCheckoutSession;
    s.provider.createCheckoutSession = async (params, key) => { created = { params, key }; return create(params, key); };
    const { r } = await openCheckout(s);
    bodies.push({ status: r.statusCode, keys: Object.keys(r.json()).sort(), state: r.json().state, params: created.params, key: created.key.length });
    await Promise.all(s.scheduled);
    assert.equal(s.meta.calls.length, env === LIVE_NO_TOKEN ? 0 : 1);
  }
  assert.equal(JSON.stringify(bodies[0].keys), JSON.stringify(bodies[1].keys));
  assert.equal(bodies[0].state, bodies[1].state);
  assert.deepEqual(Object.keys(bodies[0].params.metadata).sort(), Object.keys(bodies[1].params.metadata).sort());
});

test('S2: replays of one operation send InitiateCheckout at most once per instance', async () => {
  const s = checkoutSetup();
  const { token, r } = await openCheckout(s);
  assert.equal(r.json().state, 'redirect');
  for (let i = 0; i < 40; i++) {
    const again = await call(s.handler, req({ body: createBody(token), headers: browserHeaders({ 'x-real-ip': `198.51.100.${i}` }) }));
    assert.equal(again.json().state, 'redirect');
  }
  await Promise.all(s.scheduled);
  assert.equal(s.meta.calls.length, 1, `${s.meta.calls.length} Graph API posts for one operation`);
});

test('S2: a failed InitiateCheckout send is retried by a later replay, then cached', async () => {
  let fail = true;
  const meta = fakeMeta(() => new Response('{}', { status: fail ? 500 : 200 }));
  const s = checkoutSetup({ fetchImpl: meta.fetchImpl });
  const { token } = await openCheckout(s);
  await Promise.all(s.scheduled);
  fail = false;
  for (let i = 0; i < 3; i++) {
    await call(s.handler, req({ body: createBody(token), headers: browserHeaders() }));
    await Promise.all(s.scheduled);
  }
  assert.equal(meta.calls.length, 2, 'one failed + one successful send, then cached');
});

test('S3: test mode checkout and receipt send nothing to Meta even with the token set', async () => {
  const c = checkoutSetup({ env: META_ENV });
  const { r } = await openCheckout(c);
  assert.equal(r.json().state, 'redirect');
  const v = reservationSetup({ env: META_ENV, sessionFor: id => paidSession({ id }, { created: PAID_AT }, { created: PAID_AT }) });
  const receipt = await v.view('cs_test_SYNTHPAID0001abcdef');
  assert.equal(receipt.json().state, 'confirmed');
  await settle();
  assert.equal(c.meta.calls.length + v.meta.calls.length, 0);
  assert.equal(c.scheduled.length + v.scheduled.length, 0, 'nothing scheduled');
});

test('N5: a throwing Meta client never rejects the handler or changes the reply', async () => {
  for (const track of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('boom')), () => undefined]) {
    const metaCapi = { track };
    const c = checkoutSetup({ metaCapi });
    const token = (await call(c.handler, req({ body: startBody() }))).json().operation;
    const r = await call(c.handler, req({ body: createBody(token), headers: browserHeaders() }));
    assert.equal(r.json().state, 'redirect');
    const v = reservationSetup({ metaCapi });
    assert.equal((await v.view()).json().state, 'confirmed');
    await settle();
  }
});

function reservationSetup({ env = LIVE_ENV, getEnv = () => env, sessionFor = id => livePaid(id), fetchImpl, timeoutMs, now = () => T0, metaCapi: injected } = {}) {
  const meta = fetchImpl ? { calls: [], fetchImpl } : fakeMeta();
  const provider = fakeProvider({ retrieveCheckoutSession: async id => sessionFor(id) });
  const scheduled = [];
  const metaCapi = injected || createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl, schedule: p => scheduled.push(p), now, ...(timeoutMs ? { timeoutMs } : {}) });
  const handler = createReservationHandler({ getEnv, providerFactory: () => provider, log: makeLogger(logSink()), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }), now, metaCapi });
  const view = (id = SID, headers = browserHeaders()) => call(handler, req({ method: 'GET', url: `/api/reservation?session_id=${id}`, headers }));
  return { meta, handler, scheduled, view };
}

test('receipt: confirmed paid deposit sends Purchase deposit_<session id> with hashed email, once per instance', async () => {
  const s = reservationSetup();
  const r = await s.view();
  assert.equal(r.json().state, 'confirmed');
  assert.equal(r.json().fresh, true);
  await Promise.all(s.scheduled);
  assert.equal(s.meta.calls.length, 1);
  const ev = s.meta.calls[0].body.data[0];
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.event_id, `deposit_${SID}`);
  assert.equal(ev.event_time, PAID_AT, 'event_time is the payment time');
  assert.equal(ev.event_source_url, `${ORIGIN}/reservation.html`, 'no session id in the source URL');
  assert.deepEqual(ev.custom_data, { content_name: 'Revivex machine preorder deposit', value: 100, currency: 'USD' });
  assert.deepEqual(ev.user_data.em, [sha('buyer-pii@example.test')]);
  assert.equal(ev.user_data.fbp, FBP);
  assert.ok(!JSON.stringify(s.meta.calls[0].body).includes('buyer-pii'), 'raw email never sent');
  assert.ok(!JSON.stringify(s.meta.calls[0].body).includes('Pat Example'), 'name never sent');
  await s.view();
  await s.view();
  await Promise.all(s.scheduled);
  assert.equal(s.meta.calls.length, 1, 'reloads of the receipt do not resend');
});

test('receipt: no email from Stripe -> no em field', async () => {
  const s = reservationSetup({ sessionFor: id => ({ ...livePaid(id), customer_details: null }) });
  await s.view();
  await Promise.all(s.scheduled);
  assert.equal(s.meta.calls[0].body.data[0].user_data.em, undefined);
});

test('receipt: no Purchase unless the server confirms paid', async () => {
  const states = {
    processing: id => live(paidSession({ id, payment_status: 'unpaid' })),
    not_completed: id => live(session({ id, line_items: paidSession().line_items })),
    refunded: id => livePaid(id, PAID_AT, { refunded: true, amount_refunded: 10000 }),
    partially_refunded: id => livePaid(id, PAID_AT, { amount_refunded: 100 }),
    disputed: id => livePaid(id, PAID_AT, { disputed: true }),
    not_recognized: id => live(paidSession({ id, amount_total: 1 })),
  };
  for (const [state, sessionFor] of Object.entries(states)) {
    const s = reservationSetup({ sessionFor });
    const r = await s.view();
    assert.equal(r.json().state, state);
    assert.equal(r.json().fresh, false, state);
    await settle();
    assert.equal(s.meta.calls.length, 0, state);
  }
});

test('S1: only a recent payment (within 48 h) is reported; the receipt itself is unchanged', async () => {
  const H = 3600;
  const cases = [
    { paidAt: PAID_AT, fresh: true },
    { paidAt: T0 / 1000 - 47 * H, fresh: true },
    { paidAt: T0 / 1000 - 49 * H, fresh: false },
    { paidAt: T0 / 1000 - 10 * 24 * H, fresh: false },
    { paidAt: T0 / 1000 + 2 * H, fresh: false }, // future dated beyond clock skew
  ];
  for (const { paidAt, fresh } of cases) {
    const s = reservationSetup({ sessionFor: id => livePaid(id, paidAt) });
    const r = await s.view();
    const { fresh: f, ...rest } = r.json();
    assert.equal(f, fresh, String(paidAt));
    const { fresh: _, ...expected } = (await reservationSetup({ env: LIVE_NO_TOKEN, sessionFor: id => livePaid(id, paidAt) }).view()).json();
    assert.deepEqual(rest, expected);
    assert.equal(rest.state, 'confirmed', 'a late view still shows the deposit as received');
    await Promise.all(s.scheduled);
    assert.equal(s.meta.calls.length, fresh ? 1 : 0, String(paidAt));
    if (fresh) assert.equal(s.meta.calls[0].body.data[0].event_time, paidAt);
  }
  assert.ok(PURCHASE_REPORT_WINDOW_MS <= 48 * 3600_000);
  // No payment time from Stripe: fail closed.
  const none = reservationSetup({ sessionFor: id => paidSession({ id, livemode: true }, { livemode: true }) });
  const r = await none.view();
  assert.equal(r.json().state, 'confirmed');
  assert.equal(r.json().fresh, false);
  await settle();
  assert.equal(none.meta.calls.length, 0);
});

test('S1: a receipt reopened after the window on a cold or warm instance sends nothing', async () => {
  let t = T0;
  const s = reservationSetup({ now: () => t });
  await s.view();
  await Promise.all(s.scheduled);
  t += 25 * 3600_000; // the old 24 h per-instance cache would have expired here
  await s.view();
  t += 30 * 3600_000; // now 55 h after payment
  await s.view(SID, browserHeaders({ 'x-real-ip': '192.0.2.99' }));
  const cold = reservationSetup({ now: () => t });
  await cold.view(SID, browserHeaders({ 'x-real-ip': '192.0.2.99' }));
  await Promise.all([...s.scheduled, ...cold.scheduled]);
  assert.equal(s.meta.calls.length + cold.meta.calls.length, 1, 'only the original send');
});

test('C3: Sec-GPC: 1 on the instance that has a token sends nothing (checkout and receipt)', async () => {
  const GPC = browserHeaders({ 'sec-gpc': '1' });
  const c = checkoutSetup();
  const { token, r } = await openCheckout(c, GPC);
  assert.equal(r.json().state, 'redirect');
  await settle();
  assert.equal(c.meta.calls.length, 0, 'checkout: no send with GPC');
  assert.equal(c.scheduled.length, 0, 'checkout: nothing scheduled with GPC');

  const v = reservationSetup();
  assert.equal((await v.view(SID, GPC)).json().state, 'confirmed');
  await settle();
  assert.equal(v.meta.calls.length, 0, 'receipt: no send with GPC');
  assert.equal(v.scheduled.length, 0, 'receipt: nothing scheduled with GPC');

  // The same instances are live: a later request without GPC does report (see C2).
  await call(c.handler, req({ body: createBody(token), headers: browserHeaders() }));
  await v.view();
  await Promise.all([...c.scheduled, ...v.scheduled]);
  assert.equal(c.meta.calls.length, 1);
  assert.equal(v.meta.calls.length, 1);
});

test('C2: a skipped send (GPC, no token, ceiling, construction error) does not use up the dedup entry', async () => {
  // GPC view, then a normal view on the same instance.
  let s = reservationSetup();
  await s.view(SID, browserHeaders({ 'sec-gpc': '1' }));
  await s.view();
  await Promise.all(s.scheduled);
  assert.equal(s.meta.calls.length, 1, 'GPC then eligible');

  // Token missing, then configured, on the same instance.
  let env = LIVE_NO_TOKEN;
  s = reservationSetup({ getEnv: () => env });
  await s.view();
  await settle();
  env = LIVE_ENV;
  await s.view();
  await Promise.all(s.scheduled);
  assert.equal(s.meta.calls.length, 1, 'no token then token');

  // Ceiling reached, then room again.
  let room = false;
  const meta = fakeMeta();
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl, schedule: () => {}, sendLimiter: () => ({ ok: room }) });
  s = reservationSetup({ metaCapi: capi });
  await s.view();
  await settle();
  assert.equal(meta.calls.length, 0);
  room = true;
  await s.view();
  await settle();
  assert.equal(meta.calls.length, 1, 'ceiling then room');

  // A construction error (throwing client), then a working send.
  let broken = true;
  const ok = fakeMeta();
  const real = createMetaCapi({ pixelId: PIXEL, fetchImpl: ok.fetchImpl, schedule: () => {} });
  s = reservationSetup({ metaCapi: { track: (...a) => { if (broken) throw new Error('boom'); return real.track(...a); } } });
  await s.view();
  broken = false;
  await s.view();
  await settle();
  assert.equal(ok.calls.length, 1, 'error then eligible');
});

test('receipt: failed sends are retried on a later view', async () => {
  let fail = true;
  const meta = fakeMeta(() => new Response('{}', { status: fail ? 500 : 200 }));
  const s = reservationSetup({ fetchImpl: meta.fetchImpl });
  await s.view();
  await Promise.all(s.scheduled);
  fail = false;
  await s.view();
  await Promise.all(s.scheduled);
  await s.view();
  await Promise.all(s.scheduled);
  assert.equal(meta.calls.length, 2, 'one failed + one successful send, then cached');
});

test('receipt: a hung Meta request never delays the response, and the response body is unchanged', async () => {
  const plain = reservationSetup({ env: LIVE_NO_TOKEN });
  const expected = (await plain.view()).body;
  const s = reservationSetup({ fetchImpl: () => new Promise(() => {}), timeoutMs: 400 });
  const t0 = Date.now();
  const r = await s.view();
  assert.ok(Date.now() - t0 < 150, `took ${Date.now() - t0}ms`);
  assert.equal(r.body, expected);
  assert.deepEqual(await s.scheduled[0], { ok: false, kind: 'timeout' });
});

test('default handlers (real exports) stay silent without META_CAPI_ACCESS_TOKEN', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async url => { seen.push(String(url)); throw new Error('network disabled in test'); };
  try {
    const provider = fakeProvider({ retrieveCheckoutSession: async id => livePaid(id, Math.floor(Date.now() / 1000) - 60) });
    const h = createReservationHandler({ getEnv: () => LIVE_NO_TOKEN, providerFactory: () => provider, log: makeLogger(logSink()) });
    const r = res();
    await h(req({ method: 'GET', url: `/api/reservation?session_id=${SID}`, headers: browserHeaders() }), r);
    assert.equal(r.json().state, 'confirmed');
    assert.equal(r.json().fresh, true);
    await settle();
    assert.deepEqual(seen.filter(u => u.includes('facebook')), []);
  } finally { globalThis.fetch = realFetch; }
});
