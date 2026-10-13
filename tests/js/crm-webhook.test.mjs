// Stripe webhook -> preorders: signature, idempotency, one email, refunds/disputes, guards.
// LOCAL: real SQL on PGlite, fake Stripe provider and fake Resend sender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createStripeWebhookHandler, readRawBody } from '../../lib/stripe-webhook.js';
import { createCrmStore } from '../../lib/crm-store.js';
import { signatureHeader, verifyStripeSignature } from '../../lib/stripe-signature.js';
import { ENV, paidSession, res, logSink } from '../fixtures/deposit-fixtures.mjs';
import { createTestDb } from '../fixtures/pglite-db.mjs';

const WHSEC = `whsec_${'T3st'.repeat(8)}`;
export const CRM_ENV = Object.freeze({
  ...ENV,
  STRIPE_WEBHOOK_SECRET: WHSEC,
  DATABASE_URL: 'postgres://user:pass@local.test/db',
  RESEND_API_KEY: 're_FAKEKEY_12345678',
  RESEND_FROM: 'Revivex <preorders@updates.healthrevivex.com>',
  RESEND_REPLY_TO: 'support@revivex.store',
  REVIVEX_CRM_SIGNING_SECRET: 'crm-signing-secret-0123456789abcdefghijkl',
});

function rawReq(raw, headers = {}) {
  const r = Readable.from([Buffer.from(raw)]);
  r.method = 'POST';
  r.url = '/api/stripe-webhook';
  r.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)), ...headers };
  r.socket = { remoteAddress: '127.0.0.1' };
  return r;
}

let evtSeq = 0;
function event(type, object, o = {}) {
  evtSeq += 1;
  return { id: `evt_TEST${String(evtSeq).padStart(8, '0')}`, object: 'event', type, livemode: false, created: 1791900000, data: { object }, ...o };
}
const checkoutObj = (id, o = {}) => ({ id, object: 'checkout.session', mode: 'payment', metadata: { purpose: 'revivex_preorder_deposit' }, ...o });

async function setup({ env = CRM_ENV, sessions = {}, sendImpl } = {}) {
  const db = await createTestDb();
  const sent = [];
  const calls = [];
  const sink = logSink();
  const provider = {
    retrieveCheckoutSession: async id => { calls.push(['retrieve', id]); return sessions[id] || paidSession({ id, customer_details: { email: 'buyer-pii@example.test', name: 'Pat Example', address: { country: 'US', postal_code: '33131' } }, metadata: { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v2', operation: 'op123', utm_source: 'instagram' } }); },
    listCheckoutSessions: async q => { calls.push(['list', q]); const pi = q.find(([k]) => k === 'payment_intent')[1]; const s = Object.values(sessions).find(x => x.payment_intent?.id === pi); return { data: s ? [s] : [] }; },
  };
  const handler = createStripeWebhookHandler({
    getEnv: () => env,
    providerFactory: () => provider,
    storeFactory: () => createCrmStore(db.query),
    sendMail: async (cfg, msg, opts) => { if (sendImpl) await sendImpl(cfg, msg, opts); sent.push({ cfg, msg, opts }); return { id: `re_${sent.length}` }; },
    log: (e, f = {}) => sink.log(JSON.stringify({ e, ...f })),
    nowS: () => 1791900000,
  });
  async function deliver(ev, { secret = WHSEC, ts = 1791900000, header } = {}) {
    const raw = JSON.stringify(ev);
    const r = res();
    await handler(rawReq(raw, { 'stripe-signature': header ?? signatureHeader(secret, raw, ts) }), r);
    return r;
  }
  return { db, sent, calls, sink, deliver, handler, close: () => db.close() };
}

test('signature: valid passes; wrong secret, tampered body, expired and malformed headers fail', () => {
  const raw = Buffer.from('{"id":"evt_1"}');
  const now = 1791900000;
  assert.equal(verifyStripeSignature(raw, signatureHeader(WHSEC, raw, now), WHSEC, { nowS: now }).ok, true);
  assert.equal(verifyStripeSignature(raw, signatureHeader(`${WHSEC}x`, raw, now), WHSEC, { nowS: now }).reason, 'signature');
  assert.equal(verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), signatureHeader(WHSEC, raw, now), WHSEC, { nowS: now }).reason, 'signature');
  assert.equal(verifyStripeSignature(raw, signatureHeader(WHSEC, raw, now - 301), WHSEC, { nowS: now }).reason, 'timestamp');
  assert.equal(verifyStripeSignature(raw, signatureHeader(WHSEC, raw, now + 301), WHSEC, { nowS: now }).reason, 'timestamp');
  assert.equal(verifyStripeSignature(raw, signatureHeader(WHSEC, raw, now - 299), WHSEC, { nowS: now }).ok, true);
  assert.equal(verifyStripeSignature(raw, 'garbage', WHSEC, { nowS: now }).reason, 'malformed_header');
  assert.equal(verifyStripeSignature(raw, undefined, WHSEC, { nowS: now }).reason, 'missing_header');
  assert.equal(verifyStripeSignature(raw, `t=${now},v0=${'a'.repeat(64)}`, WHSEC, { nowS: now }).reason, 'malformed_header');
  // Secret rotation: Stripe may send several v1 signatures; any valid one is accepted.
  const good = signatureHeader(WHSEC, raw, now).split(',')[1];
  assert.equal(verifyStripeSignature(raw, `t=${now},v1=${'0'.repeat(64)},${good}`, WHSEC, { nowS: now }).ok, true);
});

test('bad or expired signatures are rejected with 400 and nothing is stored', async () => {
  const s = await setup();
  try {
    const ev = event('checkout.session.completed', checkoutObj('cs_test_BADSIG00001'));
    assert.equal((await s.deliver(ev, { secret: `${WHSEC}x` })).statusCode, 400);
    assert.equal((await s.deliver(ev, { ts: 1791900000 - 400 })).statusCode, 400);
    assert.equal((await s.deliver(ev, { header: '' })).statusCode, 400);
    assert.equal((await s.db.query('select count(*)::int as n from webhook_events'))[0].n, 0);
    assert.equal((await s.db.query('select count(*)::int as n from preorders'))[0].n, 0);
    assert.equal(s.calls.length, 0);
  } finally { await s.close(); }
});

test('paid deposit: one row with customer details, customer merged as transactional, one confirmation', async () => {
  const s = await setup();
  try {
    const r = await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_PAID0000001')));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().outcome, 'email_sent');
    const [row] = await s.db.query('select * from preorders');
    assert.equal(row.stripe_session_id, 'cs_test_PAID0000001');
    assert.equal(row.status, 'paid');
    assert.equal(row.email, 'buyer-pii@example.test');
    assert.equal(row.name, 'Pat Example');
    assert.equal(row.country, 'US');
    assert.equal(row.postal_code, '33131');
    assert.equal(row.amount_cents, 10000);
    assert.deepEqual(row.utm, { utm_source: 'instagram' });
    assert.equal(row.operation_id, 'op123');
    assert.equal(row.confirmation_email_id, 're_1');
    assert.ok(row.confirmation_sent_at);
    assert.equal(s.sent.length, 1);
    const { msg, opts, cfg } = s.sent[0];
    assert.equal(msg.to, 'buyer-pii@example.test');
    assert.equal(msg.subject, 'Your Revivex preorder is confirmed');
    assert.equal(opts.idempotencyKey, 'preorder-confirmation/cs_test_PAID0000001');
    assert.equal(cfg.replyTo, 'support@revivex.store');
    assert.match(msg.html, /Thank you, Pat\. We received your \$100&nbsp;deposit\./);
    assert.ok(msg.text.length > 200);
    const [sub] = await s.db.query('select * from subscribers');
    assert.equal(sub.email, 'buyer-pii@example.test');
    assert.equal(sub.consent_marketing, false);
    assert.equal(sub.source, 'preorder');
    const [ee] = await s.db.query('select * from email_events');
    assert.equal(ee.status, 'sent');
    assert.equal(ee.kind, 'preorder_confirmation');
  } finally { await s.close(); }
});

test('idempotency: the same event twice, and completed + async_payment_succeeded, give one row and one email', async () => {
  const s = await setup();
  try {
    const ev = event('checkout.session.completed', checkoutObj('cs_test_DUP00000001'));
    assert.equal((await s.deliver(ev)).json().outcome, 'email_sent');
    const again = await s.deliver(ev);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().outcome, 'duplicate');
    const async = await s.deliver(event('checkout.session.async_payment_succeeded', checkoutObj('cs_test_DUP00000001')));
    assert.equal(async.json().outcome, 'stored_paid');
    assert.equal((await s.db.query('select count(*)::int as n from preorders'))[0].n, 1);
    assert.equal((await s.db.query('select count(*)::int as n from webhook_events where processed_at is not null'))[0].n, 2);
    assert.equal(s.sent.length, 1);
  } finally { await s.close(); }
});

test('concurrent deliveries for the same session send one email', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const s = await setup({ sendImpl: () => gate });
  try {
    const a = s.deliver(event('checkout.session.completed', checkoutObj('cs_test_RACE0000001')));
    const b = s.deliver(event('checkout.session.async_payment_succeeded', checkoutObj('cs_test_RACE0000001')));
    setTimeout(release, 50);
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.statusCode, rb.statusCode], [200, 200]);
    assert.deepEqual([ra.json().outcome, rb.json().outcome].sort(), ['email_already_handled', 'email_sent']);
    assert.equal(s.sent.length, 1);
  } finally { await s.close(); }
});

test('Resend failure releases the claim and answers 500; Stripe retry then sends exactly once', async () => {
  let fail = true;
  const s = await setup({ sendImpl: () => { if (fail) throw Object.assign(new Error('resend_api_500'), { kind: 'api', status: 500 }); } });
  try {
    const ev = event('checkout.session.completed', checkoutObj('cs_test_RETRY000001'));
    const r1 = await s.deliver(ev);
    assert.equal(r1.statusCode, 500);
    let [row] = await s.db.query('select * from preorders');
    assert.equal(row.confirmation_sent_at, null);
    assert.equal(row.confirmation_claimed_at, null, 'claim released');
    assert.equal((await s.db.query('select processed_at from webhook_events'))[0].processed_at, null, 'not marked processed');
    assert.equal((await s.db.query("select status from email_events"))[0].status, 'failed');
    fail = false;
    const r2 = await s.deliver(ev);
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().outcome, 'email_sent');
    [row] = await s.db.query('select * from preorders');
    assert.ok(row.confirmation_sent_at);
    assert.equal(s.sent.length, 1);
    assert.equal((await s.deliver(ev)).json().outcome, 'duplicate');
    assert.equal(s.sent.length, 1);
  } finally { await s.close(); }
});

test('a stale claim (crashed sender) can be reclaimed after the lease; a fresh one cannot', async () => {
  const s = await setup();
  try {
    const store = createCrmStore(s.db.query);
    const row = await store.upsertPreorder({ sessionId: 'cs_test_LEASE000001', livemode: false, email: 'a@example.test', amountCents: 10000, currency: 'usd', status: 'paid' });
    assert.ok(await store.claimConfirmation(row.id));
    assert.equal(await store.claimConfirmation(row.id), null);
    await s.db.query("update preorders set confirmation_claimed_at = now() - interval '10 minutes' where id = $1", [row.id]);
    assert.ok(await store.claimConfirmation(row.id));
  } finally { await s.close(); }
});

test('refund and dispute events update status and timestamps without sending email', async () => {
  const sessions = {};
  const s = await setup({ sessions });
  try {
    sessions.cs_test_REFUND00001 = paidSession({ id: 'cs_test_REFUND00001' }, { id: 'pi_TESTREFUND01' });
    assert.equal((await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_REFUND00001')))).json().outcome, 'email_sent');
    sessions.cs_test_REFUND00001 = paidSession({ id: 'cs_test_REFUND00001' }, { id: 'pi_TESTREFUND01' }, { refunded: true, amount_refunded: 10000 });
    const r = await s.deliver(event('charge.refunded', { id: 'ch_1', object: 'charge', amount: 10000, currency: 'usd', payment_intent: 'pi_TESTREFUND01' }));
    assert.equal(r.json().outcome, 'stored_refunded');
    let [row] = await s.db.query('select * from preorders');
    assert.equal(row.status, 'refunded');
    assert.ok(row.refunded_at);

    // Partial refund, then a dispute, on a session the database has not seen yet
    // (found through Stripe by payment intent).
    sessions.cs_test_DISPUTE0001 = paidSession({ id: 'cs_test_DISPUTE0001' }, { id: 'pi_TESTDISPUTE1' }, { amount_refunded: 2500 });
    const p = await s.deliver(event('charge.refunded', { id: 'ch_2', object: 'charge', amount: 10000, currency: 'usd', payment_intent: 'pi_TESTDISPUTE1' }));
    assert.equal(p.json().outcome, 'stored_partially_refunded');
    assert.ok(s.calls.some(c => c[0] === 'list'));
    sessions.cs_test_DISPUTE0001 = paidSession({ id: 'cs_test_DISPUTE0001' }, { id: 'pi_TESTDISPUTE1' }, { disputed: true, amount_refunded: 2500 });
    const d = await s.deliver(event('charge.dispute.created', { id: 'dp_1', object: 'dispute', amount: 7500, currency: 'usd', payment_intent: 'pi_TESTDISPUTE1' }));
    assert.equal(d.json().outcome, 'stored_disputed');
    [row] = await s.db.query("select * from preorders where stripe_session_id = 'cs_test_DISPUTE0001'");
    assert.equal(row.status, 'disputed');
    assert.ok(row.disputed_at);
    assert.ok(row.refunded_at, 'partial refund time kept');
    assert.equal(s.sent.length, 1, 'only the first paid checkout was emailed');
  } finally { await s.close(); }
});

test('guards: non deposit sessions, wrong amount, wrong price, other mode and other event types are ignored', async () => {
  const sessions = {
    cs_test_WRONGAMT001: paidSession({ id: 'cs_test_WRONGAMT001', amount_total: 5000 }),
    cs_test_WRONGPRICE1: paidSession({ id: 'cs_test_WRONGPRICE1', line_items: { object: 'list', data: [{ price: { id: 'price_OTHER0001' }, quantity: 1 }] } }),
    cs_test_UNPAID00001: paidSession({ id: 'cs_test_UNPAID00001', payment_status: 'unpaid' }),
  };
  const s = await setup({ sessions });
  try {
    const other = await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_OTHER000001', { metadata: { purpose: 'something_else' } })));
    assert.equal(other.json().outcome, 'ignored_not_deposit');
    assert.equal(s.calls.length, 0, 'no Stripe call for a non deposit session');
    assert.equal((await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_WRONGAMT001')))).json().outcome, 'ignored_not_recognized');
    assert.equal((await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_WRONGPRICE1')))).json().outcome, 'ignored_not_recognized');
    assert.equal((await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_UNPAID00001')))).json().outcome, 'ignored_processing');
    assert.equal((await s.deliver(event('charge.refunded', { id: 'ch_9', amount: 4900, currency: 'usd', payment_intent: 'pi_TESTOTHER001' }))).json().outcome, 'ignored_not_deposit');
    assert.equal((await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_LIVEMODE001'), { livemode: true }))).json().outcome, 'ignored_mode');
    assert.equal((await s.deliver(event('customer.created', { id: 'cus_1' }))).json().outcome, 'ignored_type');
    assert.equal((await s.db.query('select count(*)::int as n from preorders'))[0].n, 0);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
});

test('backfilled preorders are never emailed by later events; missing email config stores without sending', async () => {
  const s = await setup();
  try {
    const store = createCrmStore(s.db.query);
    await store.upsertPreorder({ sessionId: 'cs_test_BACKFILL001', livemode: false, email: 'old@example.test', amountCents: 10000, currency: 'usd', status: 'paid', origin: 'backfill', notes: 'backfill' });
    const r = await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_BACKFILL001')));
    assert.equal(r.json().outcome, 'stored_paid');
    const [row] = await s.db.query('select origin, confirmation_sent_at from preorders');
    assert.equal(row.origin, 'backfill');
    assert.equal(row.confirmation_sent_at, null);
    assert.equal(s.sent.length, 0);
  } finally { await s.close(); }
  const { RESEND_API_KEY, ...noMail } = CRM_ENV;
  const s2 = await setup({ env: noMail });
  try {
    const r = await s2.deliver(event('checkout.session.completed', checkoutObj('cs_test_NOMAIL00001')));
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().outcome, 'email_unconfigured');
    const [row] = await s2.db.query('select status, confirmation_sent_at, confirmation_claimed_at from preorders');
    assert.deepEqual([row.status, row.confirmation_sent_at, row.confirmation_claimed_at], ['paid', null, null]);
  } finally { await s2.close(); }
});

test('an existing marketing opt in is kept when that person pays', async () => {
  const s = await setup();
  try {
    await createCrmStore(s.db.query).subscribe({ email: 'BUYER-PII@example.test', firstName: 'Pat', source: 'reserve', consentText: 'x', utm: {}, ipHash: 'h' });
    await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_OPTIN000001')));
    const subs = await s.db.query('select consent_marketing, source from subscribers');
    assert.equal(subs.length, 1, 'citext: one subscriber regardless of case');
    assert.equal(subs[0].consent_marketing, true);
    assert.equal(subs[0].source, 'reserve');
  } finally { await s.close(); }
});

test('unconfigured webhook fails closed; logs never carry addresses or names', async () => {
  const { STRIPE_WEBHOOK_SECRET, ...noSecret } = CRM_ENV;
  const s = await setup({ env: noSecret });
  try {
    const r = await s.deliver(event('checkout.session.completed', checkoutObj('cs_test_NOSECRET01')));
    assert.equal(r.statusCode, 503);
  } finally { await s.close(); }
  const s2 = await setup();
  try {
    await s2.deliver(event('checkout.session.completed', checkoutObj('cs_test_LOGS0000001')));
    const logs = s2.sink.lines.join('\n');
    assert.doesNotMatch(logs, /buyer-pii|Pat Example|33131/);
  } finally { await s2.close(); }
});

test('raw body: stream bytes are used as is; a pre-parsed object body is refused; size is bounded', async () => {
  const r = Readable.from([Buffer.from('{"a": 1}')]);
  r.headers = {};
  assert.equal((await readRawBody(r)).toString(), '{"a": 1}');
  const parsed = Readable.from([]);
  parsed.headers = {};
  Object.defineProperty(parsed, 'body', { get: () => ({ a: 1 }) });
  await assert.rejects(readRawBody(parsed), e => e.state === 'raw_body_unavailable');
  const big = Readable.from([Buffer.alloc(600 * 1024)]);
  big.headers = {};
  await assert.rejects(readRawBody(big), e => e.status === 413);
});
