// SYNTHETIC in-memory stand-in for Stripe, used only by the local harness and browser
// QA. It imitates idempotency replay (including saved results after a timeout and
// parameter-mismatch errors) so the real handler code can be exercised end to end.
// It is NOT Stripe and results from it are not sandbox evidence.
import { StripeCallError } from '../../lib/stripe-rest.js';

export function createSyntheticStripe({ accountId, priceId, productId }) {
  const sessions = new Map();
  const byKey = new Map();
  const failures = [];
  let seq = 0;

  const priceObj = () => ({
    id: priceId, object: 'price', active: true, livemode: false, type: 'one_time', recurring: null, billing_scheme: 'per_unit',
    custom_unit_amount: null, transform_quantity: null, currency: 'usd', unit_amount: 10000,
    product: { id: productId, object: 'product', active: true, name: 'SYNTHETIC deposit product' },
  });

  function view(s) {
    const paid = s.status === 'complete';
    return {
      id: s.id, object: 'checkout.session', livemode: false, mode: s.params.mode, status: s.status,
      payment_status: paid ? 'paid' : 'unpaid', currency: 'usd', amount_total: 10000,
      url: s.status === 'open' ? `https://checkout.stripe.com/c/pay/${s.id}` : null,
      metadata: { ...s.params.metadata }, subscription: null, setup_intent: null,
      customer_details: paid ? { email: 'synthetic-buyer@example.test', name: 'Synthetic Buyer' } : null,
      line_items: { object: 'list', data: s.params.line_items.map(li => ({ price: { id: li.price }, quantity: li.quantity })) },
      payment_intent: paid ? {
        id: `pi_SYNTH${s.id.slice(-10)}`, object: 'payment_intent', status: 'succeeded', amount_received: 10000, currency: 'usd', livemode: false,
        latest_charge: { id: `ch_SYNTH${s.id.slice(-10)}`, object: 'charge', paid: true, status: 'succeeded', refunded: s.refunded, amount_refunded: s.refunded ? 10000 : 0, disputed: s.disputed },
      } : null,
    };
  }

  const provider = {
    getAccount: async () => ({ id: accountId, object: 'account', charges_enabled: true }),
    getPrice: async () => priceObj(),
    createCheckoutSession: async (params, key) => {
      const body = JSON.stringify(params);
      const prior = byKey.get(key);
      if (prior) {
        if (prior.body !== body) throw new StripeCallError('api', { status: 400, type: 'idempotency_error' });
        return view(sessions.get(prior.id));
      }
      const failure = failures.shift();
      if (failure === 'reject') throw new StripeCallError('api', { status: 500, type: 'api_error' }); // nothing stored
      seq += 1;
      const id = `cs_test_SYNTH${String(seq).padStart(4, '0')}${Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, 'x')}`;
      sessions.set(id, { id, params, key, status: 'open', refunded: false, disputed: false });
      byKey.set(key, { id, body });
      if (failure === 'timeout') throw new StripeCallError('timeout'); // created, but the caller never hears back
      return view(sessions.get(id));
    },
    retrieveCheckoutSession: async id => {
      const s = sessions.get(id);
      if (!s) throw new StripeCallError('api', { status: 404, type: 'invalid_request_error', code: 'resource_missing' });
      return view(s);
    },
  };

  const control = {
    pay(id) { const s = sessions.get(id); if (!s) return false; s.status = 'complete'; return true; },
    expire(id) { const s = sessions.get(id); if (!s) return false; s.status = 'expired'; return true; },
    dispute(id) { const s = sessions.get(id); if (!s) return false; s.disputed = true; return true; },
    refund(id) { const s = sessions.get(id); if (!s) return false; s.refunded = true; return true; },
    failNext(kind, n = 1) { for (let i = 0; i < n; i++) failures.push(kind); },
    state() {
      return {
        sessionCount: sessions.size,
        sessions: [...sessions.values()].map(s => ({ id: s.id, status: s.status, key: s.key, metadata: s.params.metadata, piMetadata: s.params.payment_intent_data.metadata })),
      };
    },
  };
  return { provider, control };
}
