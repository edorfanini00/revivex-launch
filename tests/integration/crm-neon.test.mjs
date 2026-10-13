// INTEGRATION: the real CRM SQL over Neon's HTTP driver against a disposable database.
// Skipped unless REVIVEX_TEST_DATABASE_URL is set (use the preview database, never
// production). Every row it creates is deleted at the end.
// Run: REVIVEX_TEST_DATABASE_URL=postgres://... node --test tests/integration/
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sqlClient } from '../../lib/db.js';
import { createCrmStore } from '../../lib/crm-store.js';

const url = process.env.REVIVEX_TEST_DATABASE_URL;
test('Neon: preorder upsert, single claim, refund transition, subscriber merge and opt in', { skip: !url && 'REVIVEX_TEST_DATABASE_URL not set' }, async () => {
  const query = sqlClient(url);
  const store = createCrmStore(query);
  const tag = crypto.randomBytes(6).toString('hex');
  const sessionId = `cs_test_INTEG${tag}`;
  const email = `integration+${tag}@example.test`;
  try {
    assert.deepEqual(await store.beginEvent({ id: `evt_INTEG${tag}`, type: 'checkout.session.completed', livemode: false }), { seen: false, processed: false });
    assert.deepEqual(await store.beginEvent({ id: `evt_INTEG${tag}`, type: 'checkout.session.completed', livemode: false }), { seen: true, processed: false });
    const row = await store.upsertPreorder({ sessionId, paymentIntent: `pi_INTEG${tag}`, livemode: false, email, name: 'Integration Test', amountCents: 10000, currency: 'usd', status: 'paid', paidAt: new Date().toISOString(), utm: { utm_source: 'integration' } });
    assert.equal(row.inserted, true);
    const [a, b] = await Promise.all([store.claimConfirmation(row.id), store.claimConfirmation(row.id)]);
    assert.equal([a, b].filter(Boolean).length, 1, 'exactly one concurrent claim wins');
    assert.equal(await store.completeConfirmation(row.id, 're_integration', (a || b).claim_token), true);
    assert.equal(await store.claimConfirmation(row.id), null);
    const again = await store.upsertPreorder({ sessionId, livemode: false, amountCents: 10000, currency: 'usd', status: 'refunded' });
    assert.equal(again.inserted, false);
    assert.equal(again.status, 'refunded');
    assert.equal(await store.findPreorderByPaymentIntent(`pi_INTEG${tag}`), sessionId);
    await store.mergeCustomer({ email, firstName: 'Integration' });
    const sub = await store.subscribe({ email: email.toUpperCase(), firstName: null, source: 'reserve', consentText: 'x', utm: {}, ipHash: 'h' });
    assert.equal(sub.optedIn, true, 'transactional customer opting in counts as a new opt in');
    assert.equal(await store.unsubscribe(sub.id), true);
    await store.finishEvent(`evt_INTEG${tag}`, 'integration');
    assert.equal((await store.beginEvent({ id: `evt_INTEG${tag}`, type: 'x', livemode: false })).processed, true);
  } finally {
    await query('delete from email_events where preorder_id in (select id from preorders where stripe_session_id = $1)', [sessionId]);
    await query('delete from preorders where stripe_session_id = $1', [sessionId]);
    await query('delete from subscribers where email = $1', [email]);
    await query('delete from webhook_events where stripe_event_id = $1', [`evt_INTEG${tag}`]);
  }
});
