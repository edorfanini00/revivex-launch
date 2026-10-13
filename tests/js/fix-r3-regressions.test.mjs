// Fix round 3 regressions for checkout/reviews/final-r3.md (R3-1..R3-4). The R3-1 and
// R3-2 tests replay the reviewer's R4/R5 probes through the real handler.
// LOCAL/MOCK: the provider is the Stripe-faithful SYNTHETIC fake, not Stripe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCheckoutHandler, checkoutSessionParams } from '../../lib/deposit-handlers.js';
import * as handlers from '../../lib/deposit-handlers.js';
import { readCheckoutConfig, DEPOSIT } from '../../lib/deposit-config.js';
import { createInstanceRateLimiter, makeLogger, rateLimitKey } from '../../lib/http.js';
import { createSyntheticStripe } from '../fixtures/synthetic-provider.mjs';
import { ENV, req, res, logSink } from '../fixtures/deposit-fixtures.mjs';

const TV = DEPOSIT.termsVersion;
const ROOT = new URL('../../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, ROOT), 'utf8');
const CFG = readCheckoutConfig(ENV).config;

// Default limiters unless a test overrides them: the regressions are about production config.
function setup(deps = {}) {
  const synth = createSyntheticStripe({ accountId: ENV.STRIPE_EXPECTED_ACCOUNT_ID, priceId: ENV.STRIPE_DEPOSIT_PRICE_ID, productId: ENV.STRIPE_DEPOSIT_PRODUCT_ID });
  const checkout = createCheckoutHandler({ getEnv: () => ENV, providerFactory: () => synth.provider, log: makeLogger(logSink()), ...deps });
  return { synth, checkout };
}
const from = ip => ({ headers: { 'x-vercel-forwarded-for': ip } });
async function call(h, body, opts = {}) { const r = res(); await h(req({ body, ...opts }), r); return r; }
const startBody = () => ({ step: 'start', termsAccepted: true, termsVersion: TV, attribution: {} });
const createBody = op => ({ step: 'create', operation: op, termsAccepted: true, termsVersion: TV });
const count = (s, kind) => s.synth.control.calls().filter(c => c === kind).length;
const wide = () => createInstanceRateLimiter({ limit: 100_000, windowMs: 60_000 });

// ---- R3-1: replays of one self-issued token must not use up the create ceiling ----
test('R3-1 (reviewer R4): one token per address replayed 19x from 10 addresses never locks out a new visitor', async () => {
  const s = setup();
  const legit = (await call(s.checkout, startBody(), from('198.51.100.7'))).json().operation;
  let accepted = 0;
  for (let i = 0; i < 10; i++) {
    const ip = `203.0.113.${100 + i}`;
    const tok = (await call(s.checkout, startBody(), from(ip))).json().operation;
    for (let j = 0; j < 19; j++) if ((await call(s.checkout, createBody(tok), from(ip))).json().state === 'redirect') accepted++;
  }
  assert.equal(accepted, 190, 'every replay is answered (no 429) and stays a redirect');
  assert.equal(count(s, 'create'), 10, 'one Stripe create per token, none per replay');
  assert.equal(count(s, 'getAccount'), 10, 'merchant verification once per token');
  assert.equal(s.synth.control.state().sessionCount, 10);
  const r = await call(s.checkout, createBody(legit), from('198.51.100.7'));
  assert.equal(r.json().state, 'redirect', r.body);
});

test('R3-1: replays of a seen operation do not consume the create ceiling; new operations still do', async () => {
  const s = setup({ limiter: wide(), globalLimiter: createInstanceRateLimiter({ limit: 1, windowMs: 60_000 }) });
  const a = (await call(s.checkout, startBody())).json().operation;
  const b = (await call(s.checkout, startBody())).json().operation;
  for (let i = 0; i < 5; i++) assert.equal((await call(s.checkout, createBody(a))).json().state, 'redirect', `replay ${i}`);
  const before = s.synth.control.calls().length;
  const r = await call(s.checkout, createBody(b));
  assert.equal(r.statusCode, 429, 'the ceiling still bounds Stripe-calling creates of new operations');
  assert.equal(s.synth.control.calls().length, before);
});

test('R3-1: concurrent duplicates of one operation share a single Stripe flow', async () => {
  const s = setup({ limiter: wide(), globalLimiter: createInstanceRateLimiter({ limit: 1, windowMs: 60_000 }) });
  const op = (await call(s.checkout, startBody())).json().operation;
  const all = await Promise.all(Array.from({ length: 19 }, () => call(s.checkout, createBody(op))));
  assert.deepEqual([...new Set(all.map(r => r.json().state))], ['redirect']);
  assert.equal(new Set(all.map(r => r.json().url)).size, 1);
  assert.equal(count(s, 'create'), 1);
  assert.equal(s.synth.control.state().sessionCount, 1);
});

test('R3-1: an uncertain result is never cached; the next replay asks Stripe and finds the session', async () => {
  const s = setup({ limiter: wide() });
  const op = (await call(s.checkout, startBody())).json().operation;
  s.synth.control.failNext('timeout'); // created + saved by Stripe, reply lost
  assert.equal((await call(s.checkout, createBody(op))).json().state, 'uncertain');
  const r = await call(s.checkout, createBody(op));
  assert.equal(r.json().state, 'redirect', r.body);
  assert.equal(count(s, 'create'), 2, 'the replay went back to Stripe');
  assert.equal(s.synth.control.state().sessionCount, 1);
});

test('R3-1: a cached redirect never hides a later payment (correctness F2 holds inside the cache window)', async () => {
  const s = setup({ limiter: wide() });
  const op = (await call(s.checkout, startBody())).json().operation;
  assert.equal((await call(s.checkout, createBody(op))).json().state, 'redirect');
  const id = s.synth.control.state().sessions[0].id;
  s.synth.control.pay(id);
  const calls = s.synth.control.calls().length;
  const r = await call(s.checkout, createBody(op));
  assert.equal(r.json().state, 'complete');
  assert.equal(r.json().reservationUrl, `/reservation.html?session_id=${id}`);
  assert.deepEqual(s.synth.control.calls().slice(calls), ['retrieve'], 'one status read, no create or merchant re-verification');
  // complete is terminal: further replays are served with no Stripe call at all
  assert.equal((await call(s.checkout, createBody(op))).json().state, 'complete');
  assert.equal(s.synth.control.calls().length, calls + 1);
});

test('R3-1: when the replay refresh budget is used up, replays are served from the cache with no Stripe call', async () => {
  const s = setup({ limiter: wide(), replayRefreshLimiter: createInstanceRateLimiter({ limit: 1, windowMs: 60_000 }) });
  const op = (await call(s.checkout, startBody())).json().operation;
  const first = (await call(s.checkout, createBody(op))).json();
  const calls = s.synth.control.calls().length;
  for (let i = 0; i < 5; i++) assert.deepEqual((await call(s.checkout, createBody(op))).json(), first);
  assert.equal(s.synth.control.calls().length, calls + 1, 'one refresh, then cache only');
});

test('R3-1: the replay cache expires after about 60 s', async () => {
  let t = Date.now();
  const s = setup({ limiter: wide(), now: () => t });
  const op = (await call(s.checkout, startBody())).json().operation;
  await call(s.checkout, createBody(op));
  await call(s.checkout, createBody(op));
  assert.equal(count(s, 'create'), 1);
  t += 61_000;
  assert.equal((await call(s.checkout, createBody(op))).json().state, 'redirect');
  assert.equal(count(s, 'create'), 2, 'after expiry the full verified flow runs again');
});

test('R3-1: replay cache is bounded (LRU) and time-limited', () => {
  assert.equal(typeof handlers.createReplayCache, 'function', 'createReplayCache is exported');
  let t = 0;
  const c = handlers.createReplayCache({ ttlMs: 60_000, max: 3, now: () => t });
  for (const k of ['a', 'b', 'c']) c.set(k, k);
  assert.equal(c.get('a'), 'a'); // a is now most recent
  c.set('d', 'd');
  assert.equal(c.size, 3);
  assert.equal(c.get('b'), undefined, 'least recently used entry evicted');
  assert.equal(c.get('a'), 'a');
  t += 60_000;
  assert.equal(c.get('a'), undefined, 'expired');
});

test('R3-1: runbook does not claim a per-IP Firewall rule controls distributed floods', () => {
  const doc = read('DEPOSIT-CHECKOUT.md');
  assert.doesNotMatch(doc, /Firewall rule below is the control for that/);
  assert.match(doc, /per-IP[^.]*does not (stop|control)[^.]*distributed/i);
  assert.match(doc, /bot protection|challenge/i);
  assert.match(doc, /POST \/api\/checkout/);
});

// ---- R3-2: start has no global ceiling (per-IP only) ----
test('R3-2 (reviewer R5): 40 addresses of free starts never deny a new visitor a token', async () => {
  const s = setup();
  let ok = 0;
  for (let ip = 0; ip < 40; ip++) for (let j = 0; j < 20; j++) if ((await call(s.checkout, startBody(), from(`203.0.113.${ip}`))).statusCode === 200) ok++;
  assert.equal(ok, 800);
  const r = await call(s.checkout, startBody(), from('198.51.100.7'));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(s.synth.control.calls().length, 0);
  assert.equal((await call(s.checkout, startBody(), from('203.0.113.0'))).statusCode, 429, 'per-IP limit still applies');
});

// ---- R3-3: expanded IPv4-mapped forms ----
test('R3-3: expanded IPv4-mapped dotted-tail forms key as the IPv4 client', () => {
  for (const f of ['0:0:0:0:0:ffff:1.2.3.4', '0000:0000:0000:0000:0000:FFFF:1.2.3.4', '[0:0:0:0:0:ffff:1.2.3.4]', '::0:ffff:1.2.3.4', '0:0:0:0:0:ffff:0102:0304']) {
    assert.equal(rateLimitKey(f), '1.2.3.4', f);
  }
  assert.equal(rateLimitKey('2001:db8:1:2:3:4:1.2.3.4'), '2001:db8:1:2::/64', 'non-mapped dotted tail stays /64');
  assert.equal(rateLimitKey('64:ff9b::1.2.3.4'), '64:ff9b:0:0::/64');
  assert.notEqual(rateLimitKey('0:0:0:0:0:ffff:1.2.3.4'), rateLimitKey('0:0:0:0:0:ffff:1.2.3.5'));
});

// ---- R3-4: "fully refundable" everywhere the visitor or a receipt sees it ----
test('R3-4: receipt copy and payment description say "fully refundable"', () => {
  const params = checkoutSessionParams(CFG, { id: 'x'.repeat(22), binding: 'b', attribution: {} });
  assert.equal(params.payment_intent_data.description, `Revivex fully refundable preorder deposit (${TV})`);
  assert.match(read('public/reservation.js'), /Stripe confirms your \$100 fully refundable deposit\./);
  for (const f of ['public/reservation.js', 'lib/deposit-handlers.js']) {
    const strings = read(f).split('\n').filter(l => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
    assert.doesNotMatch(strings, /(?<!fully )refundable (deposit|preorder)/i, f);
  }
});
