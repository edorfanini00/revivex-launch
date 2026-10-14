// REAL Stripe TEST mode acceptance for the $50 offer, through the real handlers and the
// real REST provider. Test mode only: it refuses a live key. It opens one unpaid test
// Checkout Session, verifies it, then expires that same session (created here, so it is
// owned by this run). No payment, no card data, no refund.
//
//   STRIPE_MODE=test STRIPE_SECRET_KEY=sk_test_… STRIPE_EXPECTED_ACCOUNT_ID=acct_… \
//   STRIPE_DEPOSIT_PRICE_ID=price_… STRIPE_DEPOSIT_PRODUCT_ID=prod_… \
//   STRIPE_LEGACY_DEPOSIT_PRICE_IDS=price_… HISTORIC_SESSION_IDS=cs_test_…,cs_test_… \
//   node tests/provider/stripe-test-price50.mjs
//
// HISTORIC_SESSION_IDS: real paid-then-refunded $100 deposit-terms-v2 test sessions.
// Output masks every Stripe id and never prints the hosted checkout URL.
import crypto from 'node:crypto';
import { createCheckoutHandler, createReservationHandler } from '../../lib/deposit-handlers.js';
import { DEPOSIT, PREVIOUS_OFFER, STRIPE_API_VERSION, readCheckoutConfig } from '../../lib/deposit-config.js';
import { bindingDigest } from '../../lib/operation-token.js';
import { createInstanceRateLimiter, makeLogger } from '../../lib/http.js';
import { req, res, ORIGIN } from '../fixtures/deposit-fixtures.mjs';

const mask = s => (typeof s === 'string' && s.length > 14 ? `${s.slice(0, s.indexOf('_', 3) + 5)}…${s.slice(-4)}` : s);
const results = [];
const check = (ok, name, detail = '') => { results.push({ ok: !!ok, name }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const base = process.env;
if (base.STRIPE_MODE !== 'test' || !/^(sk|rk)_test_/.test(base.STRIPE_SECRET_KEY || '')) { console.error('test mode only'); process.exit(2); }
const SIGNING = crypto.randomBytes(36).toString('base64');
const ENV = {
  REVIVEX_CHECKOUT_ENABLED: 'true',
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: base.STRIPE_SECRET_KEY,
  STRIPE_EXPECTED_ACCOUNT_ID: base.STRIPE_EXPECTED_ACCOUNT_ID,
  STRIPE_DEPOSIT_PRICE_ID: base.STRIPE_DEPOSIT_PRICE_ID,
  STRIPE_DEPOSIT_PRODUCT_ID: base.STRIPE_DEPOSIT_PRODUCT_ID,
  STRIPE_LEGACY_DEPOSIT_PRICE_IDS: base.STRIPE_LEGACY_DEPOSIT_PRICE_IDS,
  REVIVEX_SITE_ORIGIN: ORIGIN,
  REVIVEX_OPERATION_SIGNING_SECRET: SIGNING,
};
const cfgCheck = readCheckoutConfig(ENV);
if (!cfgCheck.ok) { console.error('config problems', cfgCheck.problems); process.exit(2); }

const logs = [];
const log = makeLogger({ log: l => logs.push(l) });
const limiter = () => createInstanceRateLimiter({ limit: 1000, windowMs: 60_000 });
const checkout = createCheckoutHandler({ getEnv: () => ENV, log, limiter: limiter() });
const reservationFor = env => createReservationHandler({ getEnv: () => env, log, limiter: limiter() });
const reservation = reservationFor(ENV);
const call = async (h, opts) => { const r = res(); await h(req(opts), r); return r; };
const lookup = async (id, h = reservation) => (await call(h, { method: 'GET', url: `/api/reservation?session_id=${id}` })).json();

async function stripe(method, path) {
  const r = await fetch(`https://api.stripe.com${path}`, { method, headers: { Authorization: `Bearer ${ENV.STRIPE_SECRET_KEY}`, 'Stripe-Version': STRIPE_API_VERSION }, redirect: 'error' });
  return [r.status, await r.json()];
}
function signedToken(binding) {
  const payload = Buffer.from(JSON.stringify({ v: 1, id: crypto.randomBytes(16).toString('base64url'), iat: Math.floor(Date.now() / 1000) - 60, b: binding, a: {} })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', SIGNING).update(`rvx-op-v1.${payload}`).digest('base64url')}`;
}

// 1. Probe
const probe = (await call(checkout, { method: 'GET' })).json();
check(probe.configured && probe.mode === 'test' && probe.amount === 5000 && probe.termsVersion === 'deposit-terms-v3' && probe.machineDiscountPercent === 20, 'probe: configured test, 5000, deposit-terms-v3, 20%', JSON.stringify({ amount: probe.amount, termsVersion: probe.termsVersion }));

// 2. Real create through the handler
const start = (await call(checkout, { body: { step: 'start', termsAccepted: true, termsVersion: DEPOSIT.termsVersion, displayedAmount: DEPOSIT.amount, attribution: { utm_source: 'price50_qa' } } })).json();
check(start.state === 'started', 'start returns a signed operation');
const createBody = { step: 'create', operation: start.operation, termsAccepted: true, termsVersion: DEPOSIT.termsVersion, displayedAmount: DEPOSIT.amount };
const [a, b] = await Promise.all([call(checkout, { body: createBody }), call(checkout, { body: createBody })]);
const aj = a.json(), bj = b.json();
check(aj.state === 'redirect' && /^https:\/\/checkout\.stripe\.com\//.test(aj.url), 'create redirects to a real checkout.stripe.com session');
check(bj.url === aj.url, 'duplicate concurrent submit returns the same session');
const again = (await call(checkout, { body: createBody })).json();
check(again.url === aj.url, 'retry of the same operation returns the same session');
const sessionId = (logs.map(l => { try { return JSON.parse(l); } catch { return {}; } }).find(e => typeof e.session === 'string' && e.session.startsWith('cs_test_')) || {}).session
  || (await stripe('GET', '/v1/checkout/sessions?limit=5'))[1].data.find(s => s.url === aj.url)?.id;
check(/^cs_test_/.test(sessionId || ''), 'session id found', mask(sessionId));

// 3. Independent read back from Stripe
const [ss, s] = await stripe('GET', `/v1/checkout/sessions/${sessionId}?expand[]=line_items`);
const [, acct] = await stripe('GET', '/v1/account');
const li = s.line_items?.data || [];
check(ss === 200 && s.livemode === false && s.mode === 'payment' && s.status === 'open' && s.payment_status === 'unpaid', 'session: test mode, payment, open, unpaid');
check(acct.id === ENV.STRIPE_EXPECTED_ACCOUNT_ID, 'account matches the pinned Revivex account', mask(acct.id));
check(s.amount_total === 5000 && s.amount_subtotal === 5000 && s.currency === 'usd', 'amount 5000 usd (subtotal and total)');
check(li.length === 1 && li[0].price?.id === ENV.STRIPE_DEPOSIT_PRICE_ID && li[0].price?.unit_amount === 5000 && li[0].quantity === 1 && li[0].amount_discount === 0, 'one line: the $50 price, quantity 1, no discount', mask(li[0]?.price?.id));
check(Array.isArray(s.discounts) && s.discounts.length === 0 && s.allow_promotion_codes === false && (s.total_details?.amount_discount ?? 0) === 0, 'no discounts or promotion codes on the deposit');
check(s.metadata?.terms_version === 'deposit-terms-v3' && s.metadata?.machine_discount_percent === '20' && s.metadata?.purpose === 'revivex_preorder_deposit', 'metadata: v3, 20% machine discount, purpose');
check(/^\$50 USD fully refundable/.test(s.custom_text?.submit?.message || '') && !/\$100/.test(s.custom_text?.submit?.message || ''), 'hosted text says $50, never $100');
check(s.branding_settings?.display_name === 'Revivex', 'hosted header display name Revivex');

// 4. Receipt for the unpaid session shows no benefit
const unpaid = await lookup(sessionId);
check(unpaid.state === 'not_completed' && unpaid.amount === null && unpaid.machineDiscountPercent === null, 'unpaid receipt: not_completed, no amount, no discount', unpaid.state);

// 5. Old $100 operation and cached old page: no Stripe session
const old = await call(checkout, { body: { ...createBody, operation: signedToken(bindingDigest(cfgCheck.config, { priceId: cfgCheck.config.legacyPriceIds[0], termsVersion: PREVIOUS_OFFER.termsVersion, paramsVersion: PREVIOUS_OFFER.paramsVersion })) } });
check(old.statusCode === 409 && old.json().state === 'offer_changed', 'old $100 operation: offer_changed');
const stale = await call(checkout, { body: { step: 'start', termsAccepted: true, termsVersion: 'deposit-terms-v2' } });
check(stale.statusCode === 409 && stale.json().state === 'terms_changed', 'old cached page (v2, no amount): terms_changed');

// 6. Expire the session this run created
const [es, e] = await stripe('POST', `/v1/checkout/sessions/${sessionId}/expire`);
check(es === 200 && e.status === 'expired', 'this run\'s own test session expired');
const expired = await lookup(sessionId);
check(expired.state === 'expired' && expired.machineDiscountPercent === null, 'expired receipt: expired, no discount');

// 7. Real historical $100 v2 test deposits (paid, then refunded)
const historic = (base.HISTORIC_SESSION_IDS || '').split(',').filter(Boolean);
check(historic.length > 0, 'historic test sessions supplied', String(historic.length));
const { STRIPE_LEGACY_DEPOSIT_PRICE_IDS: _, ...noLegacy } = ENV;
const noLegacyReservation = reservationFor(noLegacy);
for (const id of historic) {
  const d = await lookup(id);
  check(d.state === 'refunded' && d.amount === 10000 && d.amountRefunded === 10000 && d.termsVersion === 'deposit-terms-v2' && d.machineDiscountPercent === null, `historic ${mask(id)}: refunded $100 v2, no new benefit`, JSON.stringify({ state: d.state, amount: d.amount, amountRefunded: d.amountRefunded, termsVersion: d.termsVersion }));
  const n = await lookup(id, noLegacyReservation);
  check(n.state === 'not_recognized', `historic ${mask(id)}: without the pinned $100 price it fails closed`, n.state);
}

for (const leak of [ENV.STRIPE_SECRET_KEY, SIGNING, 'checkout.stripe.com/c/pay']) check(!logs.join('\n').includes(leak), 'logs contain no key, signing secret or checkout URL');
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} real Stripe test mode checks passed`);
process.exitCode = failed ? 1 : 0;
