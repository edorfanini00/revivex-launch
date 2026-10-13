# Preorder CRM (Neon + Stripe webhook + Resend)

- **Database**: Neon Postgres `revivex-preorders` (Vercel Marketplace store `store_170lzgOetI2EPidN`, team iqon, Free plan, iad1). Production uses the Marketplace `DATABASE_URL`; preview and development use `REVIVEX_DATABASE_URL` (separate database `revivex_preview` in the same Neon project). Schema: `db/migrations/*.sql`, applied by an operator with `DATABASE_URL=... node scripts/crm/migrate.mjs` (idempotent, never on cold start).
- **Webhook** `POST /api/stripe-webhook` (`lib/stripe-webhook.js`): verifies `Stripe-Signature` on the raw body (300 s tolerance), dedupes by event id, retrieves the Checkout Session and applies the receipt page rules (`lookupState`), upserts `preorders`, merges the customer into `subscribers` as transactional only, and sends the confirmation with a fenced claim lease (`Idempotency-Key: preorder-confirmation/<session id>`, only the owning claim is released and 500 returned on failure or active competing work so Stripe retries). Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`.
- **Signup** `POST /api/signup` (`lib/signup.js`): same origin JSON, 5/min per IP + 60/min per instance, honeypot `website`, identical reply for new or existing addresses, opt in stored with the consent line; welcome email with `List-Unsubscribe` + `List-Unsubscribe-Post`. `GET|POST /api/unsubscribe?t=` (GET shows a confirm button; POST unsubscribes).
- **Env**: `STRIPE_WEBHOOK_SECRET`, `DATABASE_URL` (or `REVIVEX_DATABASE_URL`), `REVIVEX_CRM_SIGNING_SECRET` (unsubscribe tokens, IP hashes), `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO`. Each route fails closed when its part is missing; without Resend the webhook still stores preorders (outcome `email_unconfigured`).
- **Scripts**: `scripts/crm/backfill-preorders.mjs` (read only Stripe, rows marked `origin='backfill'`, never auto emailed), `scripts/crm/send-pending-confirmations.mjs` (emails paid webhook rows that missed the confirmation), `scripts/crm/render-email-previews.mjs <dir>`.
- **Tests**: `node --test tests/js/` (PGlite runs the real SQL locally); `REVIVEX_TEST_DATABASE_URL=<preview db> node --test tests/integration/`.
- **Rollback**: redeploy the previous build (the webhook then 404s and Stripe retries for up to 3 days; disable endpoint `we_1UQBoICIvt18t00iACirmCwv` if rolling back for longer). Data: `drop table if exists email_events, webhook_events, preorders, subscribers;`.

## Confirmation recovery contract (FIX1)

Apply `002_confirmation_claim_token.sql` with the existing migration runner **before**
deploying this application or running the pending-confirmation script. It adds one
nullable UUID column, is safe to repeat, and changes no existing rows. Existing claims
without a token remain busy until the 120-second lease expires. Roll back application
code without dropping this column or CRM data; older code does not provide the new
ownership protection. No database migration is performed automatically at startup.

A claim grants temporary send ownership, not proof that email was sent. When another
sender holds the claim, checkout webhooks return 500 and leave `processed_at` unset.
A retry may acknowledge a stored confirmation, a non-paid status, or an excluded
backfill row. A UUID fences completion and release, so a slow expired worker cannot
clear or complete a newer lease. The webhook and pending-confirmation script both use
this contract. A failed event finish after successful confirmation storage does not
send again. Webhook email audit logging is best effort; the preorder is the completion ledger.
There is no separate queued outbox or background delivery scheduler.

Provider acceptance followed by a crash or database failure is uncertain. Retrying
uses the same `preorder-confirmation/<session id>` key. Avoid claiming unlimited
exactly-once delivery: replay protection depends on the provider's retention window
and an unchanged request payload. The offline regression models that bounded behavior;
it does not certify a live provider guarantee. Reconcile an old uncertain acceptance
with provider records before an operator retries beyond that window. A refund cannot
recall an email whose send has already started.

Refund and dispute writes cannot be undone by an earlier paid snapshot that finishes
late. Within the currently handled events the precedence is disputed, refunded,
partially refunded, paid. Dispute closure/reinstatement is not handled by this event
set; it requires separate reconciliation before changing a disputed row. Payment
merges never grant marketing consent or remove an unsubscribe. Welcome email remains
best effort after explicit signup; it is not part of confirmation recovery.

Offline regression: `node --test tests/js/crm-confirmation-regressions.test.mjs` uses
real migrated SQL in PGlite, synthetic customers and injected fake Stripe/Resend,
with outbound fetch disabled. On baseline `62817873fddd48e6bd43327dc43544c84c4888dc`,
9 of 15 checks failed (same/different-event races, stale ownership, delayed paid writes,
and crash recovery); all 15 pass with FIX1. The unchanged review reproducer previously
returned duplicate 200, sender 500, retry 200/duplicate and sent=0; FIX1 returns
competing delivery 500 and keeps the event pending on repeated sender failures.
The failure-once regression then retries successfully with sent=1. (The original
review script reuses an already-rejected promise on every attempt, so its unchanged
fixed run correctly continues returning 500 while that fake provider stays failed.)
