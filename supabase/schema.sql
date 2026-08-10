-- Mysubbies payment backend schema (Supabase / Postgres)
--
-- Scope (Aug 2026, v1): only the DEPOSIT payment stage is real money via
-- Stripe. Materials/frame/completion stages stay as today's manual tick-off
-- in the contractor portal (localStorage) until a later phase moves them to
-- Stripe too. The weekly payout batch therefore only ever transfers a
-- contractor's 75% share of the DEPOSIT amount that was actually captured
-- — never the full job value, because the platform doesn't actually hold
-- the rest of that money yet. Widening this is future work, not a bug.
--
-- Money is stored in cents (integer) everywhere, matching Stripe's own
-- convention, to avoid floating-point rounding bugs with real currency.
--
-- `jobs.id` here matches the job `id` already generated in localStorage by
-- booking.html (e.g. "job_1723200000000_123") — it is NOT a new ID scheme.
-- This table is a deliberately thin server-side mirror: just enough job
-- state for payment/payout logic to be authoritative, not a full copy of
-- everything in the localStorage job record (messages, photos, etc. stay
-- client-side for now).

create table if not exists jobs (
  id text primary key,
  category text not null,
  suburb text,
  contractor_email text,
  base_price_cents bigint not null,
  deposit_pct numeric(5,2) not null default 5.00,
  deposit_amount_cents bigint not null,
  status text not null default 'pending_deposit'
    check (status in ('pending_deposit', 'deposit_paid', 'completed', 'disputed', 'cancelled')),
  disputed boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references jobs(id),
  stripe_payment_intent_id text unique not null,
  stage text not null default 'deposit',
  amount_cents bigint not null,
  currency text not null default 'aud',
  status text not null default 'requires_payment'
    check (status in ('requires_payment', 'succeeded', 'failed', 'refunded')),
  stripe_event_id text unique, -- last webhook event that updated this row; enforces idempotency
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payments_job_id_idx on payments(job_id);

create table if not exists contractor_connect_accounts (
  contractor_email text primary key,
  stripe_connect_account_id text unique not null,
  onboarding_status text not null default 'pending'
    check (onboarding_status in ('pending', 'complete')),
  created_at timestamptz not null default now()
);

create table if not exists payout_batches (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  total_amount_cents bigint not null default 0,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed'))
);

create table if not exists payout_line_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references payout_batches(id),
  job_id text not null references jobs(id),
  contractor_email text not null,
  amount_cents bigint not null, -- contractor's 75% share of the captured deposit
  stripe_transfer_id text,
  status text not null default 'pending'
    check (status in ('pending', 'transferred', 'failed')),
  created_at timestamptz not null default now()
);
create index if not exists payout_line_items_batch_id_idx on payout_line_items(batch_id);
create unique index if not exists payout_line_items_job_once_idx on payout_line_items(job_id)
  where status = 'transferred'; -- a job's deposit can only ever be paid out once
