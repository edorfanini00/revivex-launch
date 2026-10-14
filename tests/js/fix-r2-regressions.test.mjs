// Fix round 2 regressions for checkout/reviews/{security,correctness}-r2.md.
// LOCAL/MOCK: the provider is the Stripe-faithful SYNTHETIC fake, not Stripe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCheckoutHandler, createReservationHandler, checkoutSessionParams } from '../../lib/deposit-handlers.js';
import { readCheckoutConfig, DEPOSIT } from '../../lib/deposit-config.js';
import { issueOperation } from '../../lib/operation-token.js';
import * as http from '../../lib/http.js';
import { createSyntheticStripe } from '../fixtures/synthetic-provider.mjs';
import { ENV, req, res, logSink } from '../fixtures/deposit-fixtures.mjs';

const { createInstanceRateLimiter, makeLogger } = http;
const rateLimitKey = http.rateLimitKey || (() => { throw new Error('rateLimitKey is not exported'); });
const TV = DEPOSIT.termsVersion;
const ROOT = new URL('../../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, ROOT), 'utf8');
const CFG = readCheckoutConfig(ENV).config;

// Default limiters on purpose: the regression is about the production configuration.
function setup({ now = () => Date.now(), ...deps } = {}) {
  const synth = createSyntheticStripe({ accountId: ENV.STRIPE_EXPECTED_ACCOUNT_ID, priceId: ENV.STRIPE_DEPOSIT_PRICE_ID, productId: ENV.STRIPE_DEPOSIT_PRODUCT_ID });
  const common = { getEnv: () => ENV, providerFactory: () => synth.provider, log: makeLogger(logSink()), now, ...deps };
  return { synth, checkout: createCheckoutHandler(common), reservation: createReservationHandler(common) };
}
const from = ip => ({ headers: { 'x-vercel-forwarded-for': ip } });
async function call(h, body, opts = {}) { const r = res(); await h(req({ body, ...opts }), r); return r; }
const startBody = () => ({ step: 'start', termsAccepted: true, termsVersion: TV, displayedAmount: DEPOSIT.amount, attribution: {} });
const createBody = op => ({ step: 'create', operation: op, termsAccepted: true, termsVersion: TV, displayedAmount: DEPOSIT.amount });
const stripeCalls = s => s.synth.control.calls().length;

// ---- security N-1: the global ceiling must only count Stripe-calling creates ----
test('legitimate create still succeeds after 120 foreign start requests (0 Stripe calls)', async () => {
  const s = setup();
  const legit = (await call(s.checkout, startBody(), from('192.0.2.10'))).json().operation;
  for (let i = 0; i < 120; i++) {
    const r = await call(s.checkout, startBody(), from(`198.51.100.${Math.floor(i / 20)}`));
    assert.equal(r.statusCode, 200, `foreign start ${i}`);
  }
  assert.equal(stripeCalls(s), 0);
  const r = await call(s.checkout, createBody(legit), from('192.0.2.10'));
  assert.equal(r.json().state, 'redirect', r.body);
});

test('legitimate create still succeeds after forged, aged and binding-drifted creates', async () => {
  const s = setup();
  const legit = (await call(s.checkout, startBody(), from('192.0.2.10'))).json().operation;
  const aged = issueOperation(CFG, { now: () => Date.now() - 24 * 3600_000, attribution: {} });
  const drifted = issueOperation({ ...CFG, priceId: 'price_OTHERDEPOSIT' }, { now: () => Date.now(), attribution: {} });
  const forged = `${legit.split('.')[0]}.${'A'.repeat(43)}`;
  let n = 0;
  for (const op of [forged, aged, drifted]) {
    for (let i = 0; i < 60; i++, n++) {
      const r = await call(s.checkout, createBody(op), from(`198.51.${100 + Math.floor(n / 20)}.1`));
      assert.ok([400, 409].includes(r.statusCode), `${r.statusCode} ${r.body}`);
    }
  }
  assert.equal(stripeCalls(s), 0);
  const r = await call(s.checkout, createBody(legit), from('192.0.2.10'));
  assert.equal(r.json().state, 'redirect', r.body);
});

test('the global ceiling still bounds Stripe-calling creates, and is checked before any provider call', async () => {
  const s = setup({ limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }), globalLimiter: createInstanceRateLimiter({ limit: 2, windowMs: 60_000 }) });
  const ops = [];
  for (let i = 0; i < 3; i++) ops.push((await call(s.checkout, startBody())).json().operation);
  assert.equal((await call(s.checkout, createBody(ops[0]))).json().state, 'redirect');
  assert.equal((await call(s.checkout, createBody(ops[1]))).json().state, 'redirect');
  const before = stripeCalls(s);
  const r = await call(s.checkout, createBody(ops[2]));
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().state, 'rate_limited');
  assert.equal(stripeCalls(s), before, 'no provider call once the ceiling is reached');
});

// r3 (R3-2): start no longer has a global ceiling (per-IP only); the start-ceiling test
// was replaced by the reviewer's R5 probe in fix-r3-regressions.test.mjs.
test('start is never blocked by the create ceiling', async () => {
  const s = setup({ limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }), globalLimiter: createInstanceRateLimiter({ limit: 1, windowMs: 60_000 }) });
  const first = (await call(s.checkout, startBody(), from('192.0.2.10'))).json().operation;
  assert.equal((await call(s.checkout, createBody(first), from('192.0.2.10'))).json().state, 'redirect');
  for (let i = 0; i < 50; i++) assert.equal((await call(s.checkout, startBody(), from(`198.51.100.${i}`))).statusCode, 200);
});

test('reservation: malformed and cross-mode lookups never use up the global ceiling (it only counts Stripe lookups)', async () => {
  const s = setup({ limiter: createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 }), globalLimiter: createInstanceRateLimiter({ limit: 1, windowMs: 60_000 }) });
  const get = async id => { const r = res(); await s.reservation(req({ method: 'GET', url: `/api/reservation?session_id=${id}` }), r); return r; };
  for (const bad of ['', 'nope', 'cs_live_ABCDEFGH12345678', '../../etc', 'cs_test_' + 'a'.repeat(300)]) assert.equal((await get(bad)).statusCode, 404);
  assert.equal(stripeCalls(s), 0);
  assert.notEqual((await get('cs_test_ABCDEFGH12345678')).statusCode, 429, 'first real lookup is still allowed');
});

// ---- security N-2: IPv6 clients are keyed by /64, IPv4 by full address ----
test('rateLimitKey: IPv6 by /64 prefix, IPv4 by full address', () => {
  assert.equal(rateLimitKey('2001:db8:1:2::1'), rateLimitKey('2001:0db8:0001:0002:ffff:eeee:dddd:cccc'));
  assert.equal(rateLimitKey('2001:db8:1:2::1'), rateLimitKey('[2001:DB8:1:2::abcd]'));
  assert.notEqual(rateLimitKey('2001:db8:1:2::1'), rateLimitKey('2001:db8:1:3::1'));
  assert.equal(rateLimitKey('2001:db8::1'), rateLimitKey('2001:db8:0:0:1::1'));
  assert.notEqual(rateLimitKey('198.51.100.1'), rateLimitKey('198.51.100.2'));
  assert.equal(rateLimitKey('198.51.100.1'), '198.51.100.1');
  assert.equal(rateLimitKey('::ffff:198.51.100.1'), '198.51.100.1', 'IPv4-mapped IPv6 is the IPv4 client');
  assert.equal(rateLimitKey('fe80::1%en0'), rateLimitKey('fe80::2'));
  assert.equal(rateLimitKey('unknown'), 'unknown');
});

test('100 addresses inside one IPv6 /64 share one per-IP budget', async () => {
  const s = setup();
  let ok = 0;
  for (let i = 0; i < 100; i++) {
    const r = await call(s.checkout, startBody(), from(`2001:db8:aa:bb::${(i + 1).toString(16)}`));
    if (r.statusCode === 200) ok++;
  }
  assert.equal(ok, 20);
  assert.equal((await call(s.checkout, startBody(), from('2001:db8:aa:bc::1'))).statusCode, 200, 'another /64 is independent');
  assert.equal((await call(s.checkout, startBody(), from('198.51.100.7'))).statusCode, 200);
});

// ---- security N-3: .vercelignore keeps residue out of deploy uploads ----
test('.vercelignore excludes local residue, tests, generated assets and docs', () => {
  const lines = read('.vercelignore').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  for (const p of ['.tmp', 'node_modules', '__pycache__', 'tests', 'gen-*', 'dist', 'evidence', '*.md']) {
    assert.ok(lines.some(l => l.replace(/^\/|\/$/g, '') === p), p);
  }
  for (const keep of ['public', 'api', 'lib', 'vercel.json', 'package.json']) {
    assert.ok(!lines.some(l => l.replace(/^\/|\/$/g, '') === keep), `must not ignore ${keep}`);
  }
});

// ---- security N-4: reservation.html route regex ----
test('reservation.html route regex escapes the dot', () => {
  const v = JSON.parse(read('vercel.json'));
  const route = v.routes.find(r => r.dest === '/public/reservation.html');
  const re = new RegExp(`^${route.src}$`);
  assert.ok(re.test('/reservation.html'));
  assert.ok(!re.test('/reservationXhtml'));
});

// ---- correctness N1: wording consistency ----
const REFUND_HOW = 'email support@revivex.store, ideally from the email address you used at checkout, or tell us which email address you used';
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

test('hosted Stripe custom text says "fully refundable" like the site', () => {
  const msg = checkoutSessionParams(CFG, { id: 'x'.repeat(22), binding: 'b', attribution: {} }).custom_text.submit.message;
  assert.match(msg, /^\$50 USD fully refundable preorder deposit/);
  assert.match(msg, /Includes 20% off the final machine price, then your \$50 is credited toward the rest\. No automatic balance charge\./);
  assert.ok(msg.length <= 1200, 'Stripe custom_text limit');
});

test('terms, receipt and FAQ give the same refund instruction, with no mailbox precondition', () => {
  for (const f of ['public/deposit-terms.html', 'public/reservation.html', 'public/index.html']) {
    const t = text(read(f));
    assert.ok(t.includes(`To request a refund, ${REFUND_HOW}.`), f);
    assert.ok(!/\bfrom the (email )?address you used at checkout\b/.test(t.replace(/ideally from the email address you used at checkout/g, '')), `${f}: no bare "from the address you used"`);
  }
});
