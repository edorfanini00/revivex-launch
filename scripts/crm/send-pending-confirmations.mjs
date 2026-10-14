// Sends the confirmation email to paid webhook preorders that never got one (for
// example while RESEND_API_KEY was not configured). Backfilled rows are excluded by the
// claim. Same fenced claim + provider Idempotency-Key as the webhook; uncertain
// acceptance is only deduplicated within the provider's replay retention window.
// Usage: DATABASE_URL + RESEND_* + REVIVEX_SITE_ORIGIN, then
//   node scripts/crm/send-pending-confirmations.mjs [--dry-run]
import { neon } from '@neondatabase/serverless';
import { createCrmStore } from '../../lib/crm-store.js';
import { readEmailConfig, readLinkOrigin } from '../../lib/crm-config.js';
import { renderPreorderConfirmation } from '../../lib/email/index.js';
import { sendEmail } from '../../lib/resend.js';

const dryRun = process.argv.includes('--dry-run');
const cfg = readEmailConfig(process.env);
if (!process.env.DATABASE_URL || (!dryRun && !cfg)) { console.error('DATABASE_URL and RESEND_* are required'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);
const query = (t, p) => sql.query(t, p);
const store = createCrmStore(query);
const pending = await query("select id from preorders where status = 'paid' and origin = 'webhook' and confirmation_sent_at is null order by paid_at");
console.log(`pending: ${pending.length}`);
if (dryRun) process.exit(0);
let sent = 0;
for (const { id } of pending) {
  const claim = await store.claimConfirmation(id);
  if (!claim || !claim.email) { if (claim) await store.releaseConfirmation(id, claim.claim_token); continue; }
  const msg = renderPreorderConfirmation({ sessionId: claim.stripe_session_id, email: claim.email, name: claim.name, paidAt: claim.paid_at, amountCents: claim.amount_cents, currency: claim.currency, origin: readLinkOrigin(process.env) });
  try {
    const r = await sendEmail(cfg, { to: claim.email, subject: msg.subject, html: msg.html, text: msg.text, tags: [{ name: 'category', value: 'preorder_confirmation' }] }, { idempotencyKey: `preorder-confirmation/${claim.stripe_session_id}` });
    if (!await store.completeConfirmation(id, r.id, claim.claim_token)) throw new Error('confirmation_claim_lost');
    await store.logEmail({ preorderId: id, kind: 'preorder_confirmation', resendId: r.id, status: 'sent' });
    sent += 1;
  } catch (e) {
    await store.releaseConfirmation(id, claim.claim_token);
    await store.logEmail({ preorderId: id, kind: 'preorder_confirmation', status: 'failed', error: e.message });
  }
}
console.log(`sent: ${sent}`);
