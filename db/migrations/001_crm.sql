-- Revivex preorder CRM: subscribers, paid preorders, email log, Stripe webhook inbox.
-- Idempotent: safe to re-run. Applied with `node scripts/crm/migrate.mjs`, never on cold start.
-- Rollback (destroys CRM data; Stripe stays the payment ledger):
--   drop table if exists email_events, webhook_events, preorders, subscribers;
create extension if not exists citext;

create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique check (length(email) <= 254),
  first_name text check (length(first_name) <= 80),
  source text,
  consent_marketing boolean not null default false,
  consent_text text,
  consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  utm jsonb,
  ip_hash text
);

create table if not exists preorders (
  id uuid primary key default gen_random_uuid(),
  stripe_session_id text not null unique,
  stripe_payment_intent text,
  livemode boolean not null,
  email citext,
  name text,
  phone text,
  amount_cents integer,
  currency text,
  status text not null check (status in ('paid', 'refunded', 'partially_refunded', 'disputed')),
  country text,
  postal_code text,
  utm jsonb,
  operation_id text,
  -- 'webhook': recorded live from Stripe events (gets the confirmation email).
  -- 'backfill': imported from Stripe history; never emailed automatically.
  origin text not null default 'webhook' check (origin in ('webhook', 'backfill')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  disputed_at timestamptz,
  -- Send lease: set just before calling Resend, cleared on failure, so one paid
  -- preorder gets one confirmation even with concurrent or retried deliveries.
  confirmation_claimed_at timestamptz,
  confirmation_email_id text,
  confirmation_sent_at timestamptz
);
create index if not exists preorders_payment_intent_idx on preorders (stripe_payment_intent);
create index if not exists preorders_email_idx on preorders (email);

create table if not exists email_events (
  id uuid primary key default gen_random_uuid(),
  preorder_id uuid references preorders (id) on delete set null,
  subscriber_id uuid references subscribers (id) on delete set null,
  kind text not null,
  resend_id text,
  status text not null,
  created_at timestamptz not null default now(),
  error text
);

create table if not exists webhook_events (
  stripe_event_id text primary key,
  type text not null,
  livemode boolean,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text
);
