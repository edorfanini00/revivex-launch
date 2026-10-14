// SQL for the preorder CRM. Every statement is parameterised; `query(text, params)`
// returns rows (Neon HTTP driver in production, PGlite in tests).

export const CONFIRMATION_LEASE_S = 120;

export function createCrmStore(query) {
  return {
    // Webhook inbox. Returns { seen: bool, processed: bool }.
    async beginEvent(event) {
      const inserted = await query(
        `insert into webhook_events (stripe_event_id, type, livemode) values ($1, $2, $3)
         on conflict (stripe_event_id) do nothing returning stripe_event_id`,
        [event.id, String(event.type).slice(0, 80), event.livemode === true],
      );
      if (inserted.length) return { seen: false, processed: false };
      const rows = await query('select processed_at from webhook_events where stripe_event_id = $1', [event.id]);
      return { seen: true, processed: !!rows[0]?.processed_at };
    },

    async finishEvent(eventId, outcome) {
      await query('update webhook_events set processed_at = now(), outcome = $2 where stripe_event_id = $1', [eventId, String(outcome).slice(0, 80)]);
    },

    // Insert or refresh a preorder from Stripe's current state. The origin of an existing
    // row never changes, paid_at keeps its first value, refund/dispute times are set once.
    async upsertPreorder(p) {
      const rows = await query(
        `insert into preorders (stripe_session_id, stripe_payment_intent, livemode, email, name, phone, amount_cents,
           currency, status, country, postal_code, utm, operation_id, origin, notes, paid_at, refunded_at, disputed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16,
           case when $9 in ('refunded', 'partially_refunded') then coalesce($17::timestamptz, now()) end,
           case when $9 = 'disputed' then coalesce($17::timestamptz, now()) end)
         on conflict (stripe_session_id) do update set
           stripe_payment_intent = coalesce(excluded.stripe_payment_intent, preorders.stripe_payment_intent),
           email = coalesce(excluded.email, preorders.email),
           name = coalesce(excluded.name, preorders.name),
           phone = coalesce(excluded.phone, preorders.phone),
           country = coalesce(excluded.country, preorders.country),
           postal_code = coalesce(excluded.postal_code, preorders.postal_code),
           amount_cents = excluded.amount_cents,
           currency = excluded.currency,
           -- Concurrent Stripe reads can finish out of order. The handled event set
           -- never reverses a refund or resolves a dispute; do not revive a deposit
           -- from an older paid snapshot (including a backfill snapshot).
           status = case
             when preorders.status = 'disputed' or excluded.status = 'disputed' then 'disputed'
             when preorders.status = 'refunded' or excluded.status = 'refunded' then 'refunded'
             when preorders.status = 'partially_refunded' then 'partially_refunded'
             else excluded.status end,
           utm = coalesce(preorders.utm, excluded.utm),
           operation_id = coalesce(preorders.operation_id, excluded.operation_id),
           paid_at = coalesce(preorders.paid_at, excluded.paid_at),
           refunded_at = case when excluded.status in ('refunded', 'partially_refunded')
             then coalesce(preorders.refunded_at, excluded.refunded_at) else preorders.refunded_at end,
           disputed_at = case when excluded.status = 'disputed'
             then coalesce(preorders.disputed_at, excluded.disputed_at) else preorders.disputed_at end,
           updated_at = now()
         returning id, status, origin, email, name, paid_at, confirmation_sent_at, (xmax = 0) as inserted`,
        [p.sessionId, p.paymentIntent, p.livemode, p.email, p.name, p.phone, p.amountCents, p.currency, p.status,
          p.country, p.postalCode, p.utm ? JSON.stringify(p.utm) : null, p.operationId, p.origin || 'webhook', p.notes || null,
          p.paidAt, p.eventAt || null],
      );
      return rows[0];
    },

    // Paying customers join subscribers as transactional only. An existing opt in (or
    // opt out) is never changed by a payment.
    async mergeCustomer({ email, firstName }) {
      if (!email) return null;
      const rows = await query(
        `insert into subscribers (email, first_name, source, consent_marketing) values ($1, $2, 'preorder', false)
         on conflict (email) do update set first_name = coalesce(subscribers.first_name, excluded.first_name), updated_at = now()
         returning id`,
        [email, firstName || null],
      );
      return rows[0]?.id || null;
    },

    // Claims the right to send the confirmation. Only one caller wins until the lease
    // expires or is released; a sent confirmation is never claimed again.
    async claimConfirmation(preorderId) {
      const rows = await query(
        `update preorders set confirmation_claimed_at = now(), confirmation_claim_token = gen_random_uuid()
         where id = $1 and status = 'paid' and origin = 'webhook' and confirmation_sent_at is null
           and (confirmation_claimed_at is null or confirmation_claimed_at < now() - make_interval(secs => $2))
         returning id, stripe_session_id, email, name, paid_at, amount_cents, currency,
           confirmation_claim_token as claim_token`,
        [preorderId, CONFIRMATION_LEASE_S],
      );
      return rows[0] || null;
    },

    // A failed claim is not proof of delivery. Read the durable state before deciding
    // whether a webhook can be acknowledged; an active/just-released lease must retry.
    async confirmationState(preorderId) {
      const rows = await query('select status, origin, confirmation_sent_at from preorders where id = $1', [preorderId]);
      return rows[0] || null;
    },

    async completeConfirmation(preorderId, resendId, claimToken) {
      const rows = await query(
        `update preorders set confirmation_sent_at = now(), confirmation_email_id = $2,
           confirmation_claimed_at = null, confirmation_claim_token = null, updated_at = now()
         where id = $1 and confirmation_claim_token = $3::uuid and confirmation_sent_at is null returning id`,
        [preorderId, resendId, claimToken || null],
      );
      return rows.length > 0;
    },

    async releaseConfirmation(preorderId, claimToken) {
      const rows = await query(
        `update preorders set confirmation_claimed_at = null, confirmation_claim_token = null
         where id = $1 and confirmation_claim_token = $2::uuid and confirmation_sent_at is null returning id`,
        [preorderId, claimToken || null],
      );
      return rows.length > 0;
    },

    async logEmail({ preorderId = null, subscriberId = null, kind, resendId = null, status, error = null }) {
      await query(
        'insert into email_events (preorder_id, subscriber_id, kind, resend_id, status, error) values ($1, $2, $3, $4, $5, $6)',
        [preorderId, subscriberId, kind, resendId, status, error ? String(error).slice(0, 200) : null],
      );
    },

    // Marketing opt in from the site form. Returns { id, optedIn } where optedIn is true
    // only when this request turned consent on (new, previously transactional only, or
    // previously unsubscribed). The caller never reveals which case applied.
    async subscribe({ email, firstName, source, consentText, utm, ipHash }) {
      const rows = await query(
        `with prev as (select consent_marketing, unsubscribed_at from subscribers where email = $1)
         insert into subscribers (email, first_name, source, consent_marketing, consent_text, consent_at, utm, ip_hash)
         values ($1, $2, $3, true, $4, now(), $5::jsonb, $6)
         on conflict (email) do update set
           first_name = coalesce(excluded.first_name, subscribers.first_name),
           source = case when subscribers.consent_marketing and subscribers.unsubscribed_at is null then subscribers.source else excluded.source end,
           consent_marketing = true,
           consent_text = excluded.consent_text,
           consent_at = case when subscribers.consent_marketing and subscribers.unsubscribed_at is null then subscribers.consent_at else now() end,
           unsubscribed_at = null,
           utm = coalesce(subscribers.utm, excluded.utm),
           ip_hash = excluded.ip_hash,
           updated_at = now()
         returning id, first_name,
           coalesce((select not p.consent_marketing or p.unsubscribed_at is not null from prev p), true) as opted_in`,
        [email, firstName || null, source, consentText, utm && Object.keys(utm).length ? JSON.stringify(utm) : null, ipHash || null],
      );
      return { id: rows[0].id, firstName: rows[0].first_name, optedIn: rows[0].opted_in === true };
    },

    async unsubscribe(subscriberId) {
      const rows = await query(
        `update subscribers set unsubscribed_at = coalesce(unsubscribed_at, now()), consent_marketing = false, updated_at = now()
         where id = $1 returning id`,
        [subscriberId],
      );
      return rows.length > 0;
    },

    async findPreorderByPaymentIntent(paymentIntent) {
      const rows = await query('select stripe_session_id from preorders where stripe_payment_intent = $1 limit 1', [paymentIntent]);
      return rows[0]?.stripe_session_id || null;
    },
  };
}
