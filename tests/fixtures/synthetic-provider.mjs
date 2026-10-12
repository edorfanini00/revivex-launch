// SYNTHETIC in-memory stand-in for Stripe, used by unit tests, the local harness and
// browser QA. It follows the documented v1 idempotency contract and the behaviour seen
// in the real TEST sandbox (checkout/sandbox/RESULT.md):
//   - the first response for an idempotency key is SAVED and replayed verbatim,
//     including 500 errors (a replay does NOT show the session's current state);
//   - a request racing an in-flight request with the same key gets 409 (not saved);
//   - a replay with different parameters gets 400 idempotency_error;
//   - payment_method_types is rejected (API 2026-09-30.endive);
//   - without allowed_payment_method_types the dynamic set includes non-card methods;
//   - the hosted header shows the account display name unless branding_settings
//     overrides it.
// It is NOT Stripe and results from it are not sandbox evidence.
import { StripeCallError } from '../../lib/stripe-rest.js';

const DYNAMIC_METHODS = ['card', 'link', 'klarna', 'cashapp', 'amazon_pay'];
const clone = o => JSON.parse(JSON.stringify(o));

export function createSyntheticStripe({ accountId, priceId, productId, accountDisplayName = 'Individual' }) {
  const sessions = new Map();
  const saved = new Map(); // idempotency key -> { body, response | error }
  const inFlight = new Set();
  const failures = [];
  const calls = [];
  let seq = 0;

  const priceObj = () => ({
    id: priceId, object: 'price', active: true, livemode: false, type: 'one_time', recurring: null, billing_scheme: 'per_unit',
    custom_unit_amount: null, transform_quantity: null, currency: 'usd', unit_amount: 10000, currency_options: { usd: { unit_amount: 10000 } },
    product: { id: productId, object: 'product', active: true, name: 'SYNTHETIC deposit product' },
  });

  function view(s) {
    const paid = s.status === 'complete';
    const allowed = s.params.allowed_payment_method_types || null;
    return {
      id: s.id, object: 'checkout.session', livemode: false, mode: s.params.mode, status: s.status,
      payment_status: paid ? 'paid' : 'unpaid', currency: 'usd', amount_total: 10000,
      url: s.status === 'open' ? `https://checkout.stripe.com/c/pay/${s.id}` : null,
      allowed_payment_method_types: allowed,
      payment_method_types: allowed ? DYNAMIC_METHODS.filter(m => allowed.includes(m)) : [...DYNAMIC_METHODS],
      branding_settings: { display_name: s.params.branding_settings?.display_name || accountDisplayName },
      metadata: { ...s.params.metadata }, subscription: null, setup_intent: null,
      customer_details: paid ? { email: 'synthetic-buyer@example.test', name: 'Synthetic Buyer' } : null,
      line_items: { object: 'list', data: s.params.line_items.map(li => ({ price: { id: li.price }, quantity: li.quantity })) },
      payment_intent: paid ? {
        id: `pi_SYNTH${s.id.slice(-10)}`, object: 'payment_intent', status: 'succeeded', amount_received: 10000, currency: 'usd', livemode: false,
        latest_charge: { id: `ch_SYNTH${s.id.slice(-10)}`, object: 'charge', paid: true, status: 'succeeded', refunded: s.refunded, amount_refunded: s.refunded ? 10000 : 0, disputed: s.disputed, payment_method_details: { type: 'card' } },
      } : null,
    };
  }

  const provider = {
    getAccount: async () => { calls.push('getAccount'); return { id: accountId, object: 'account', charges_enabled: true }; },
    getPrice: async () => { calls.push('getPrice'); return priceObj(); },
    createCheckoutSession: async (params, key) => {
      calls.push('create');
      const body = JSON.stringify(params);
      const prior = saved.get(key);
      if (prior) {
        if (prior.body !== body) throw new StripeCallError('api', { status: 400, type: 'idempotency_error' });
        if (prior.error) throw new StripeCallError('api', prior.error);
        return clone(prior.response); // saved FIRST response, not current state
      }
      if (inFlight.has(key)) throw new StripeCallError('api', { status: 409, type: 'idempotency_error', code: 'idempotency_key_in_use' });
      inFlight.add(key);
      try {
        await new Promise(r => setTimeout(r, 5));
        if (params.payment_method_types) {
          // Validation failures are not saved under the key.
          throw new StripeCallError('api', { status: 400, type: 'invalid_request_error', param: 'payment_method_types' });
        }
        const failure = failures.shift();
        if (failure === 'lost') throw new StripeCallError('network'); // never reached Stripe; nothing saved
        if (failure === 'save500') {
          const error = { status: 500, type: 'api_error' };
          saved.set(key, { body, error });
          throw new StripeCallError('api', error);
        }
        seq += 1;
        const id = `cs_test_SYNTH${String(seq).padStart(4, '0')}${Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, 'x')}`;
        sessions.set(id, { id, params: clone(params), key, status: 'open', refunded: false, disputed: false });
        const response = view(sessions.get(id));
        saved.set(key, { body, response: clone(response) });
        if (failure === 'timeout') throw new StripeCallError('timeout'); // created + saved; reply lost
        if (failure === 'garbled') throw new StripeCallError('api', { status: 200, type: 'invalid_response' }); // created; body unreadable
        return response;
      } finally {
        inFlight.delete(key);
      }
    },
    retrieveCheckoutSession: async id => {
      calls.push('retrieve');
      const s = sessions.get(id);
      if (!s) throw new StripeCallError('api', { status: 404, type: 'invalid_request_error', code: 'resource_missing' });
      const failure = failures[0] === 'retrieve_timeout' ? failures.shift() : null;
      if (failure) throw new StripeCallError('timeout');
      return view(s);
    },
  };

  const control = {
    pay(id) { const s = sessions.get(id); if (!s) return false; s.status = 'complete'; return true; },
    expire(id) { const s = sessions.get(id); if (!s) return false; s.status = 'expired'; return true; },
    dispute(id) { const s = sessions.get(id); if (!s) return false; s.disputed = true; return true; },
    refund(id) { const s = sessions.get(id); if (!s) return false; s.refunded = true; return true; },
    failNext(kind, n = 1) { for (let i = 0; i < n; i++) failures.push(kind); },
    calls: () => [...calls],
    state() {
      return {
        sessionCount: sessions.size,
        sessions: [...sessions.values()].map(s => ({ id: s.id, status: s.status, key: s.key, metadata: s.params.metadata, piMetadata: s.params.payment_intent_data.metadata, allowed: s.params.allowed_payment_method_types || null, displayName: s.params.branding_settings?.display_name || null })),
      };
    },
  };
  return { provider, control };
}
