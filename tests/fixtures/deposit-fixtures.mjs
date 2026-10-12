// LOCAL/MOCK fixtures only. These objects imitate Stripe response shapes for
// unit tests; they are not Stripe sandbox evidence.
import { Readable } from 'node:stream';

// Fake key-shaped values are assembled at runtime so secret scanners never see a literal key.
export const fakeKey = (kind, mode) => [kind, mode, 'FAKE'.repeat(5) + '1234'].join('_');
export const SECRET = fakeKey('sk', 'test');
export const ORIGIN = 'https://revivex-launch.vercel.app';
export const SIGNING = 'test-signing-secret-0123456789abcdef0123';

export const ENV = Object.freeze({
  REVIVEX_CHECKOUT_ENABLED: 'true',
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: SECRET,
  STRIPE_EXPECTED_ACCOUNT_ID: 'acct_TESTREVIVEX01',
  STRIPE_DEPOSIT_PRICE_ID: 'price_TESTDEPOSIT01',
  STRIPE_DEPOSIT_PRODUCT_ID: 'prod_TESTDEPOSIT01',
  REVIVEX_SITE_ORIGIN: ORIGIN,
  REVIVEX_OPERATION_SIGNING_SECRET: SIGNING,
});

export const account = (o = {}) => ({ id: 'acct_TESTREVIVEX01', object: 'account', charges_enabled: true, email: 'owner@example.test', ...o });
export const product = (o = {}) => ({ id: 'prod_TESTDEPOSIT01', object: 'product', active: true, name: 'Revivex preorder deposit', ...o });
export const price = (o = {}) => ({
  id: 'price_TESTDEPOSIT01', object: 'price', active: true, livemode: false, type: 'one_time', recurring: null,
  billing_scheme: 'per_unit', custom_unit_amount: null, transform_quantity: null, currency: 'usd', unit_amount: 10000,
  product: product(), ...o,
});

let seq = 0;
export function session(o = {}) {
  seq += 1;
  const id = o.id || `cs_test_SYNTH${String(seq).padStart(6, '0')}abcdef`;
  return {
    id, object: 'checkout.session', livemode: false, mode: 'payment', status: 'open', payment_status: 'unpaid',
    currency: 'usd', amount_total: 10000, url: `https://checkout.stripe.com/c/pay/${id}`,
    metadata: { purpose: 'revivex_preorder_deposit', terms_version: 'deposit-terms-v1', operation: 'x' },
    customer_details: { email: 'buyer-pii@example.test', name: 'Pat Example' },
    client_secret: 'cs_secret_SHOULD_NEVER_LEAK',
    subscription: null, setup_intent: null, ...o,
  };
}

export function paidSession(o = {}, piOverrides = {}, chargeOverrides = {}) {
  return session({
    status: 'complete', payment_status: 'paid', url: null,
    line_items: { object: 'list', data: [{ price: { id: 'price_TESTDEPOSIT01' }, quantity: 1, amount_total: 10000 }] },
    payment_intent: {
      id: 'pi_TESTPAID000001', object: 'payment_intent', status: 'succeeded', amount_received: 10000, currency: 'usd', livemode: false,
      latest_charge: { id: 'ch_TEST1', object: 'charge', paid: true, status: 'succeeded', refunded: false, amount_refunded: 0, billing_details: { email: 'buyer-pii@example.test' }, ...chargeOverrides },
      ...piOverrides,
    },
    ...o,
  });
}

// Fake provider recording calls. Each method can be replaced per test.
export function fakeProvider(overrides = {}) {
  const calls = [];
  const p = {
    calls,
    getAccount: async () => { calls.push(['getAccount']); return account(); },
    getPrice: async id => { calls.push(['getPrice', id]); return price(); },
    createCheckoutSession: async (params, key) => { calls.push(['create', params, key]); return session(); },
    retrieveCheckoutSession: async id => { calls.push(['retrieve', id]); return paidSession({ id }); },
    ...overrides,
  };
  return p;
}

export function req({ method = 'POST', url = '/api/checkout', headers = {}, body } = {}) {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const r = Readable.from(raw ? [Buffer.from(raw)] : []);
  r.method = method;
  r.url = url;
  r.headers = {
    ...(method === 'POST' ? { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-length': String(Buffer.byteLength(raw)) } : {}),
    'x-real-ip': '203.0.113.7',
    ...headers,
  };
  for (const [k, v] of Object.entries(r.headers)) if (v === undefined) delete r.headers[k];
  r.socket = { remoteAddress: '127.0.0.1' };
  return r;
}

export function res() {
  const r = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = b => { r.body = b || ''; r.ended = true; };
  r.json = () => JSON.parse(r.body);
  return r;
}

export const startBody = (o = {}) => ({ step: 'start', termsAccepted: true, termsVersion: 'deposit-terms-v1', ...o });
export const createBody = (operation, o = {}) => ({ step: 'create', operation, termsAccepted: true, termsVersion: 'deposit-terms-v1', ...o });

export function logSink() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')) };
}
