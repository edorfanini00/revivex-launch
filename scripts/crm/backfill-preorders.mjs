// Imports already paid deposit Checkout Sessions from Stripe into `preorders`.
// Stripe access is read only (list + retrieve). Rows are marked origin='backfill' and
// are never emailed automatically (confirmation_sent_at stays null), so the owner can
// decide separately whether to email them. Safe to re-run: upserts by session id.
// Usage: STRIPE_* (as in the deposit config) + DATABASE_URL, then
//   node scripts/crm/backfill-preorders.mjs [--dry-run]
import { neon } from '@neondatabase/serverless';
import { DEPOSIT, readStripeConfig } from '../../lib/deposit-config.js';
import { lookupState } from '../../lib/deposit-handlers.js';
import { createStripeRestProvider } from '../../lib/stripe-rest.js';
import { createCrmStore } from '../../lib/crm-store.js';
import { preorderFromSession } from '../../lib/stripe-webhook.js';
import { greetingName } from '../../lib/email/shared.js';

const STATUS = { confirmed: 'paid', refunded: 'refunded', partially_refunded: 'partially_refunded', disputed: 'disputed' };
const dryRun = process.argv.includes('--dry-run');
const stripe = readStripeConfig(process.env);
if (!stripe.ok) { console.error('Stripe config incomplete:', stripe.problems.join(',')); process.exit(1); }
if (!dryRun && !process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const provider = createStripeRestProvider({ secretKey: stripe.config.secretKey, timeoutMs: 15000 });
const sql = dryRun ? null : neon(process.env.DATABASE_URL);
const store = sql ? createCrmStore((t, p) => sql.query(t, p)) : null;

const counts = { listed: 0, deposits: 0, stored: 0, byStatus: {}, skipped: {} };
let after = null;
const note = `backfilled ${new Date().toISOString().slice(0, 10)} from Stripe history; confirmation email not sent`;
for (;;) {
  const q = [['limit', '100'], ['status', 'complete']];
  if (after) q.push(['starting_after', after]);
  const page = await provider.listCheckoutSessions(q);
  for (const s of page.data) {
    counts.listed += 1;
    if (s.metadata?.purpose !== DEPOSIT.purpose) continue;
    counts.deposits += 1;
    const full = await provider.retrieveCheckoutSession(s.id);
    const state = lookupState(full, stripe.config);
    const status = STATUS[state.state];
    if (!status) { counts.skipped[state.state] = (counts.skipped[state.state] || 0) + 1; continue; }
    counts.byStatus[status] = (counts.byStatus[status] || 0) + 1;
    if (dryRun) continue;
    const row = await store.upsertPreorder(preorderFromSession(full, status, { origin: 'backfill', notes: note }));
    await store.mergeCustomer({ email: row.email, firstName: greetingName(row.name) || null });
    counts.stored += 1;
  }
  if (!page.has_more || !page.data.length) break;
  after = page.data[page.data.length - 1].id;
}
console.log(JSON.stringify({ mode: stripe.config.mode, dryRun, ...counts }));
