// Meta Conversions API (lib/meta-capi.js) and its hooks in the deposit handlers.
// LOCAL/MOCK only: Meta and Stripe are fakes; no network request leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CAPI_TIMEOUT_MS, GRAPH_API_VERSION, createMetaCapi, hashEmail, readCookie, userData } from '../../lib/meta-capi.js';
import { checkoutSessionParams, createCheckoutHandler, createReservationHandler } from '../../lib/deposit-handlers.js';
import { readCheckoutConfig } from '../../lib/deposit-config.js';
import { readOperation } from '../../lib/operation-token.js';
import { createInstanceRateLimiter, makeLogger } from '../../lib/http.js';
import { META_PIXEL_ID } from '../../public/meta-pixel-id.js';
import { ENV, ORIGIN, SIGNING, createBody, fakeProvider, logSink, paidSession, req, res, session, startBody } from '../fixtures/deposit-fixtures.mjs';

const PIXEL = '123456789012345';
const TOKEN = 'EAAG' + 'FAKECAPITOKEN'.repeat(4);
const META_ENV = Object.freeze({ ...ENV, META_CAPI_ACCESS_TOKEN: TOKEN });
const FBP = 'fb.1.1700000000000.1234567890';
const FBC = 'fb.1.1700000000000.IwAR2abc_DEF-ghi';
const UA = 'Mozilla/5.0 (Macintosh) SyntheticTestBrowser/1.0';
const SID = 'cs_test_SYNTHPAID0001abcdef';
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
  const r = await createMetaCapi({ fetchImpl: meta.fetchImpl }).track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x' });
  if (META_PIXEL_ID === 'REVIVEX_PIXEL_ID_PLACEHOLDER') return assert.deepEqual(r, { ok: false, skipped: 'unconfigured' });
  assert.deepEqual(r, { ok: true });
  assert.equal(meta.calls[0].url, `https://graph.facebook.com/${GRAPH_API_VERSION}/${META_PIXEL_ID}/events`);
});

test('Global Privacy Control (Sec-GPC: 1): nothing is sent to Meta', async () => {
  const meta = fakeMeta();
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl });
  const r = await capi.track(META_ENV, req({ headers: browserHeaders({ 'sec-gpc': '1' }) }), { name: 'Purchase', eventId: 'deposit_x' });
  assert.deepEqual(r, { ok: false, skipped: 'gpc' });
  assert.equal(meta.calls.length, 0);
});

test('payload: dedup event id, deposit value, fbp/fbc/IP/UA, SHA-256 email; no raw PII, token only in the body', async () => {
  const meta = fakeMeta();
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl, now: () => 1_760_000_000_123 });
  const r = await capi.track(META_ENV, req({ method: 'GET', url: '/api/reservation', headers: browserHeaders() }), { name: 'Purchase', eventId: `deposit_${SID}`, sourceUrl: `${ORIGIN}/reservation.html`, email: '  Buyer-PII@Example.TEST ' });
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
  await capi.track({ ...META_ENV, META_TEST_EVENT_CODE: 'TEST12345' }, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x' });
  await capi.track({ ...META_ENV, META_TEST_EVENT_CODE: 'bogus value' }, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x' });
  assert.equal(meta.calls[0].body.test_event_code, 'TEST12345');
  assert.equal(meta.calls[1].body.test_event_code, undefined);
});

test('timeout: a hung Meta request is aborted quickly, never throws, and the token is never logged', async () => {
  const sink = logSink();
  let aborted = false;
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
  const capi = createMetaCapi({ pixelId: PIXEL, fetchImpl, timeoutMs: 40, log: makeLogger(sink) });
  const t0 = Date.now();
  const r = await capi.track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x', email: 'buyer-pii@example.test' });
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
  assert.deepEqual(await capi.track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x' }), { ok: false, status: 400 });
  capi = createMetaCapi({ pixelId: PIXEL, fetchImpl: async () => { throw new Error(`boom ${TOKEN}`); }, log: makeLogger(sink) });
  assert.deepEqual(await capi.track(META_ENV, req({ headers: browserHeaders() }), { name: 'Purchase', eventId: 'deposit_x' }), { ok: false, kind: 'network' });
  assert.ok(!sink.lines.join('\n').includes(TOKEN));
  assert.ok(!sink.lines.join('\n').includes('OAuth'));
});

// ---------------- handlers ----------------

function checkoutSetup({ env = META_ENV, fetchImpl, timeoutMs } = {}) {
  const meta = fetchImpl ? { calls: [], fetchImpl } : fakeMeta();
  const provider = fakeProvider();
  const sink = logSink();
  const scheduled = [];
  const metaCapi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl, schedule: p => scheduled.push(p), ...(timeoutMs ? { timeoutMs } : {}) });
  const handler = createCheckoutHandler({ getEnv: () => env, providerFactory: () => provider, log: makeLogger(sink), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }), metaCapi });
  return { meta, provider, handler, scheduled, sink };
}
async function call(h, rq) { const r = res(); await h(rq, r); return r; }

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
  s.provider.createCheckoutSession = async () => paidSession({ id: 'cs_test_SYNTHDONE0001abcdef' });
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
  for (const env of [ENV, META_ENV]) {
    const s = checkoutSetup({ env });
    const token = (await call(s.handler, req({ body: startBody(), headers: browserHeaders() }))).json().operation;
    const r = await call(s.handler, req({ body: createBody(token), headers: browserHeaders() }));
    const created = s.provider.calls.find(c => c[0] === 'create');
    bodies.push({ status: r.statusCode, keys: Object.keys(r.json()).sort(), state: r.json().state, params: created[1], key: created[2].length });
    await Promise.all(s.scheduled);
    assert.equal(s.meta.calls.length, env === ENV ? 0 : 1);
  }
  assert.equal(JSON.stringify(bodies[0].keys), JSON.stringify(bodies[1].keys));
  assert.equal(bodies[0].state, bodies[1].state);
  assert.deepEqual(Object.keys(bodies[0].params.metadata).sort(), Object.keys(bodies[1].params.metadata).sort());
});

function reservationSetup({ env = META_ENV, sessionFor = id => paidSession({ id }), fetchImpl, timeoutMs } = {}) {
  const meta = fetchImpl ? { calls: [], fetchImpl } : fakeMeta();
  const provider = fakeProvider({ retrieveCheckoutSession: async id => sessionFor(id) });
  const scheduled = [];
  const metaCapi = createMetaCapi({ pixelId: PIXEL, fetchImpl: meta.fetchImpl, schedule: p => scheduled.push(p), ...(timeoutMs ? { timeoutMs } : {}) });
  const handler = createReservationHandler({ getEnv: () => env, providerFactory: () => provider, log: makeLogger(logSink()), limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }), metaCapi });
  const view = (id = SID, headers = browserHeaders()) => call(handler, req({ method: 'GET', url: `/api/reservation?session_id=${id}`, headers }));
  return { meta, handler, scheduled, view };
}

test('receipt: confirmed paid deposit sends Purchase deposit_<session id> with hashed email, once per instance', async () => {
  const s = reservationSetup();
  const r = await s.view();
  assert.equal(r.json().state, 'confirmed');
  await Promise.all(s.scheduled);
  assert.equal(s.meta.calls.length, 1);
  const ev = s.meta.calls[0].body.data[0];
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.event_id, `deposit_${SID}`);
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
  const s = reservationSetup({ sessionFor: id => paidSession({ id, customer_details: null }) });
  await s.view();
  await Promise.all(s.scheduled);
  assert.equal(s.meta.calls[0].body.data[0].user_data.em, undefined);
});

test('receipt: no Purchase unless the server confirms paid', async () => {
  const states = {
    processing: id => paidSession({ id, payment_status: 'unpaid' }),
    not_completed: id => session({ id, line_items: paidSession().line_items }),
    refunded: id => paidSession({ id }, {}, { refunded: true, amount_refunded: 10000 }),
    partially_refunded: id => paidSession({ id }, {}, { amount_refunded: 100 }),
    disputed: id => paidSession({ id }, {}, { disputed: true }),
    not_recognized: id => paidSession({ id, amount_total: 1 }),
  };
  for (const [state, sessionFor] of Object.entries(states)) {
    const s = reservationSetup({ sessionFor });
    const r = await s.view();
    assert.equal(r.json().state, state);
    await settle();
    assert.equal(s.meta.calls.length, 0, state);
  }
});

test('receipt: GPC and missing token send nothing; failed sends are retried on a later view', async () => {
  let s = reservationSetup();
  await s.view(SID, browserHeaders({ 'sec-gpc': '1' }));
  s = reservationSetup({ env: ENV });
  await s.view();
  await settle();
  assert.equal(s.meta.calls.length, 0);

  let fail = true;
  const meta = fakeMeta(() => new Response('{}', { status: fail ? 500 : 200 }));
  s = reservationSetup({ fetchImpl: meta.fetchImpl });
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
  const plain = reservationSetup({ env: ENV });
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
    const provider = fakeProvider();
    const h = createReservationHandler({ getEnv: () => ENV, providerFactory: () => provider, log: makeLogger(logSink()) });
    const r = res();
    await h(req({ method: 'GET', url: `/api/reservation?session_id=${SID}`, headers: browserHeaders() }), r);
    assert.equal(r.json().state, 'confirmed');
    await settle();
    assert.deepEqual(seen.filter(u => u.includes('facebook')), []);
  } finally { globalThis.fetch = realFetch; }
});
