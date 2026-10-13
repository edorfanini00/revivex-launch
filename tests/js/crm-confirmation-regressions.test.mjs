// Deterministic offline regressions: real migrated PostgreSQL in PGlite, fake providers.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createTestDb } from '../fixtures/pglite-db.mjs';
import { ENV, paidSession, req, res } from '../fixtures/deposit-fixtures.mjs';
import { createCrmStore } from '../../lib/crm-store.js';
import { createStripeWebhookHandler } from '../../lib/stripe-webhook.js';
import { createSignupHandler, createUnsubscribeHandler } from '../../lib/signup.js';
import { signatureHeader } from '../../lib/stripe-signature.js';
import { unsubscribeToken } from '../../lib/unsubscribe-token.js';
import { migrate } from '../../scripts/crm/migrate.mjs';

const NOW = 1791900000;
const SECRET = 'whsec_FIX1_offline_only_01234567890123456789';
const ENVIRONMENT = { ...ENV, STRIPE_WEBHOOK_SECRET: SECRET,
  DATABASE_URL: 'postgres://synthetic:synthetic@local.test/offline',
  RESEND_API_KEY: 're_FAKEKEY_12345678', RESEND_FROM: 'Revivex <test@example.test>',
  RESEND_REPLY_TO: 'support@revivex.store', REVIVEX_CRM_SIGNING_SECRET: 'offline-signing-secret-01234567890123456789' };
const SID = 'cs_test_FIX1RACE00001';
const PI = 'pi_FIX1RACE00001';
const session = (charge = {}) => paidSession({ id: SID, customer_details: { email: 'buyer@example.test', name: 'Test Buyer' } }, { id: PI }, charge);
const checkout = (id = 'evt_FIX1CHECKOUT01', type = 'checkout.session.completed') => ({ id, type, livemode: false, created: NOW,
  data: { object: { id: SID, mode: 'payment', metadata: { purpose: 'revivex_preorder_deposit' } } } });
const refund = type => ({ id: `evt_FIX1${type === 'charge.refunded' ? 'REFUND' : 'DISPUTE'}001`, type, livemode: false, created: NOW + 1,
  data: { object: { id: 'ch_FIX100000001', amount: 10000, currency: 'usd', payment_intent: PI } } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let db;
const originalFetch = globalThis.fetch;
before(async () => {
  globalThis.fetch = async () => { throw new Error('FIX1: outbound network forbidden'); };
  db = await createTestDb();
});
after(async () => { await db?.close(); globalThis.fetch = originalFetch; });
beforeEach(async () => { await db.query('truncate email_events, webhook_events, preorders, subscribers'); });

function setup({ send, query = db.query, retrieve } = {}) {
  let current = session();
  const attempts = [], accepted = new Map();
  const store = createCrmStore(query);
  const handler = createStripeWebhookHandler({ getEnv: () => ENVIRONMENT, storeFactory: () => store,
    providerFactory: () => ({ retrieveCheckoutSession: async () => retrieve ? retrieve(current) : current,
      listCheckoutSessions: async () => ({ data: [current] }) }),
    sendMail: async (cfg, msg, opts) => {
      attempts.push({ msg, opts });
      if (send) await send(attempts.length);
      // Explicit fake of bounded provider idempotency: identical payload required.
      const key = opts.idempotencyKey, payload = JSON.stringify(msg);
      if (accepted.has(key)) assert.equal(accepted.get(key).payload, payload);
      else accepted.set(key, { payload, id: 're_FIX1_accepted' });
      return { id: accepted.get(key).id };
    }, log: () => {}, nowS: () => NOW });
  const deliver = async (event = checkout(), { raw = JSON.stringify(event), ts = NOW, signature } = {}) => {
    const request = Readable.from([Buffer.from(raw)]);
    request.method = 'POST'; request.url = '/api/stripe-webhook';
    request.headers = { 'stripe-signature': signature ?? signatureHeader(SECRET, raw, ts), 'content-length': String(Buffer.byteLength(raw)) };
    const response = res(); await handler(request, response); return response;
  };
  return { store, deliver, attempts, accepted, setSession: value => { current = value; } };
}
const row = async () => (await db.query('select * from preorders'))[0];
const eventRows = () => db.query('select * from webhook_events');

for (const failFirst of [true, false]) test(`FIX1 same-event retry storm, first sender ${failFirst ? 'fails' : 'succeeds'}`, async () => {
  const entered = deferred(), release = deferred();
  const s = setup({ send: async n => { if (n === 1) { entered.resolve(); await release.promise; if (failFirst) throw new Error('fake_send_failure'); } } });
  const first = s.deliver();
  let duplicates, pending;
  try {
    await entered.promise;
    duplicates = await Promise.all(Array.from({ length: 12 }, () => s.deliver()));
    pending = await eventRows();
  } finally { release.resolve(); }
  const result = await first;
  assert.ok(duplicates.every(r => r.statusCode === 500), 'active claim must ask Stripe to retry');
  assert.ok(pending.every(r => r.processed_at === null), 'active send cannot finish the event');
  assert.equal(result.statusCode, failFirst ? 500 : 200);
  const retry = await s.deliver();
  assert.equal(retry.statusCode, 200);
  assert.ok((await row()).confirmation_sent_at);
  assert.equal(s.accepted.size, 1);
  assert.equal(s.attempts.length, failFirst ? 2 : 1);
  assert.equal((await s.deliver()).json().outcome, 'duplicate');
  assert.equal(s.accepted.size, 1);
});

test('FIX1 different event IDs compete, then finish independently without another send', async () => {
  const entered = deferred(), release = deferred();
  const s = setup({ send: async () => { entered.resolve(); await release.promise; } });
  const a = checkout(), b = checkout('evt_FIX1ASYNC00001', 'checkout.session.async_payment_succeeded');
  const first = s.deliver(a);
  let second, pending;
  try { await entered.promise; second = await s.deliver(b); pending = await eventRows(); }
  finally { release.resolve(); }
  assert.equal((await first).statusCode, 200);
  assert.equal(second.statusCode, 500);
  assert.ok(pending.every(r => !r.processed_at));
  assert.equal((await s.deliver(b)).statusCode, 200);
  assert.equal(s.attempts.length, 1);
  assert.equal((await eventRows()).filter(r => r.processed_at).length, 2);
});

for (const operation of ['release', 'complete']) test(`FIX1 expired owner cannot ${operation} a replacement claim`, async () => {
  const s = setup();
  const p = await s.store.upsertPreorder({ sessionId: SID, livemode: false, status: 'paid', email: 'buyer@example.test', amountCents: 10000, currency: 'usd' });
  const old = await s.store.claimConfirmation(p.id);
  await db.query("update preorders set confirmation_claimed_at = now() - interval '10 minutes' where id = $1", [p.id]);
  const replacement = await s.store.claimConfirmation(p.id);
  assert.ok(replacement);
  if (operation === 'release') await s.store.releaseConfirmation(p.id, old.claim_token);
  else await s.store.completeConfirmation(p.id, 're_STALE', old.claim_token);
  const state = await row();
  assert.ok(state.confirmation_claimed_at, 'replacement lease must remain held');
  assert.equal(state.confirmation_sent_at, null, 'old owner cannot record completion');
  assert.equal(await s.store.claimConfirmation(p.id), null, 'third sender cannot enter');
  assert.equal(await s.store.completeConfirmation(p.id, 're_CURRENT', replacement.claim_token), true);
  assert.equal((await row()).confirmation_email_id, 're_CURRENT');
});

for (const terminal of ['refunded', 'partially_refunded', 'disputed']) test(`FIX1 ${terminal} survives an earlier paid snapshot finishing late`, async () => {
  const entered = deferred(), release = deferred();
  let hold = true;
  const s = setup({ retrieve: async current => { if (hold) { hold = false; entered.resolve(); await release.promise; } return current; } });
  const delayed = s.deliver();
  try {
    await entered.promise;
    s.setSession(session(terminal === 'disputed' ? { disputed: true } : { amount_refunded: terminal === 'refunded' ? 10000 : 2500, refunded: terminal === 'refunded' }));
    assert.equal((await s.deliver(refund(terminal === 'disputed' ? 'charge.dispute.created' : 'charge.refunded'))).statusCode, 200);
  } finally { release.resolve(); }
  assert.equal((await delayed).statusCode, 200);
  assert.equal((await row()).status, terminal);
  assert.equal(s.attempts.length, 0, 'delayed paid snapshot must not send after terminal state');
  assert.equal((await s.deliver(checkout('evt_FIX1LATEASYNC1', 'checkout.session.async_payment_succeeded'))).statusCode, 200);
  assert.equal(s.attempts.length, 0);
});

test('FIX1 accepted email plus DB completion failure retries the same provider key/payload', async () => {
  let fail = true;
  const s = setup({ query: async (sql, params) => {
    if (fail && sql.includes('set confirmation_sent_at')) { fail = false; throw new Error('injected DB finish failure'); }
    return db.query(sql, params);
  } });
  assert.equal((await s.deliver()).statusCode, 500);
  assert.equal(s.accepted.size, 1);
  assert.equal((await row()).confirmation_sent_at, null);
  assert.ok((await eventRows()).every(r => !r.processed_at));
  assert.equal((await s.deliver()).statusCode, 200);
  assert.equal(s.accepted.size, 1);
  assert.equal(s.attempts.length, 2);
  assert.equal(s.attempts[0].opts.idempotencyKey, `preorder-confirmation/${SID}`);
  assert.ok((await row()).confirmation_sent_at);
});

test('FIX1 crash after provider acceptance holds a fresh lease and recovers a stale lease', async () => {
  let crash = true;
  const s = setup({ query: async (sql, params) => {
    if (crash && (sql.includes('set confirmation_sent_at') || sql.includes('set confirmation_claimed_at = null'))) throw new Error('injected crash: DB unavailable');
    return db.query(sql, params);
  } });
  assert.equal((await s.deliver()).statusCode, 500);
  assert.equal(s.accepted.size, 1);
  assert.ok((await row()).confirmation_claimed_at);
  crash = false;
  assert.equal((await s.deliver()).statusCode, 500, 'fresh crash lease is retryable');
  assert.ok((await eventRows()).every(r => !r.processed_at));
  await db.query("update preorders set confirmation_claimed_at = now() - interval '10 minutes'");
  assert.equal((await s.deliver()).statusCode, 200);
  assert.equal(s.accepted.size, 1);
  assert.equal(s.attempts.length, 2);
});

test('FIX1 event finish failure after stored confirmation never sends again', async () => {
  let fail = true;
  const s = setup({ query: async (sql, params) => {
    if (fail && sql.startsWith('update webhook_events set processed_at')) { fail = false; throw new Error('injected event finish failure'); }
    return db.query(sql, params);
  } });
  assert.equal((await s.deliver()).statusCode, 500);
  assert.ok((await row()).confirmation_sent_at);
  assert.equal((await s.deliver()).statusCode, 200);
  assert.equal(s.attempts.length, 1);
});

test('FIX1 payment preserves opt out and never enrolls a new customer in marketing', async () => {
  const s = setup();
  assert.equal((await s.deliver()).statusCode, 200);
  let [sub] = await db.query('select * from subscribers');
  assert.equal(sub.consent_marketing, false);
  assert.equal(sub.consent_at, null);
  await s.store.subscribe({ email: sub.email, source: 'reserve', consentText: 'explicit opt in' });
  await s.store.unsubscribe(sub.id);
  const [before] = await db.query('select * from subscribers');
  await s.deliver(checkout('evt_FIX1AFTEROPTOUT'));
  [sub] = await db.query('select * from subscribers');
  assert.equal(sub.consent_marketing, false);
  assert.deepEqual(sub.unsubscribed_at, before.unsubscribed_at);
  assert.deepEqual(sub.consent_at, before.consent_at);
});

test('FIX1 signed unsubscribe authorizes only its subscriber; external callers cannot substitute IDs', async () => {
  const s = setup();
  const a = await s.store.subscribe({ email: 'a@example.test', source: 'reserve', consentText: 'yes' });
  const b = await s.store.subscribe({ email: 'b@example.test', source: 'reserve', consentText: 'yes' });
  const token = unsubscribeToken(ENVIRONMENT.REVIVEX_CRM_SIGNING_SECRET, a.id);
  const unsub = createUnsubscribeHandler({ getEnv: () => ENVIRONMENT, storeFactory: () => s.store, log: () => {} });
  const call = async (method, t) => {
    const r = res();
    await unsub(req({ method, url: `/api/unsubscribe?t=${encodeURIComponent(t)}&subscriberId=${b.id}`, body: { subscriberId: b.id }, headers: { origin: 'https://external.example' } }), r);
    return r;
  };
  assert.equal((await call('POST', token.replace(a.id, b.id))).statusCode, 400);
  assert.equal((await call('POST', b.id)).statusCode, 400);
  assert.equal((await call('GET', token)).statusCode, 200);
  assert.equal((await db.query('select count(*)::int n from subscribers where consent_marketing'))[0].n, 2);
  assert.equal((await call('POST', token)).statusCode, 200);
  assert.equal((await db.query('select consent_marketing from subscribers where id = $1', [b.id]))[0].consent_marketing, true);
  const signup = createSignupHandler({ getEnv: () => ENVIRONMENT, storeFactory: () => s.store, sendMail: async () => { throw new Error('must not send'); }, log: () => {} });
  const r = res();
  await signup(req({ url: '/api/signup', body: { email: 'a@example.test' }, headers: { origin: 'https://external.example' } }), r);
  assert.equal(r.statusCode, 403);
  assert.equal((await db.query('select consent_marketing from subscribers where id = $1', [a.id]))[0].consent_marketing, false);
});

test('FIX1 forged, altered raw body, and stale/future signed events cannot create CRM rows', async () => {
  const s = setup();
  for (const options of [{ signature: 't=1,v1=bad' }, { ts: NOW - 301 }, { ts: NOW + 301 },
    { raw: JSON.stringify(checkout()) + ' ', signature: signatureHeader(SECRET, JSON.stringify(checkout()), NOW) }]) {
    assert.equal((await s.deliver(checkout(), options)).statusCode, 400);
  }
  assert.equal((await eventRows()).length, 0);
  assert.equal((await db.query('select count(*)::int n from preorders'))[0].n, 0);
  assert.equal(s.attempts.length, 0);
});

test('FIX1 backfilled rows remain excluded after webhook delivery and repeat migration', async () => {
  const s = setup();
  await s.store.upsertPreorder({ sessionId: SID, livemode: false, status: 'paid', origin: 'backfill', email: 'buyer@example.test', amountCents: 10000, currency: 'usd' });
  await migrate(db.query);
  assert.equal((await s.deliver()).statusCode, 200);
  assert.equal((await row()).origin, 'backfill');
  assert.equal(s.attempts.length, 0);
  assert.equal(await s.store.claimConfirmation((await row()).id), null);
});
