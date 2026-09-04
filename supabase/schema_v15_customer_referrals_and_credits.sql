-- Customer referral program: Give $50, Get $50 (added Sep 2026).
--
-- referral_code/referred_by previously existed for customers ONLY inside
-- each browser's own localStorage (mysubbies_customers) -- never on the
-- real customers table, so a server-side function (where the actual
-- discount has to be computed and applied to a real Stripe charge) had no
-- way to see them at all, and the client-side "is this a real code" check
-- only worked if the referrer's record happened to already be cached in
-- the SAME browser. Mirrors the exact pattern already used for contractor
-- referrals (schema_v9_contractor_referrals.sql).
alter table customers add column if not exists referral_code text;
alter table customers add column if not exists referred_by text;
create index if not exists customers_referral_code_idx on customers(referral_code);

-- A $50 credit, earned by either side of a successful referral (the
-- referee's first deposit payment succeeding), spendable once on either
-- person's own NEXT deposit. Deliberately NOT applied to the referee's
-- own first booking -- that first deposit is what proves the referral is
-- real, so both rewards fire together once it's paid, and both are usable
-- going forward. Keeps the discount out of the first-booking payment
-- flow entirely (lower risk) and avoids the client-side preview needing
-- to guess at a credit before the server can confirm one exists.
create table if not exists customer_credits (
  id uuid primary key default gen_random_uuid(),
  customer_email text not null,
  amount_cents integer not null,
  source text not null check (source in ('referral_referrer', 'referral_referee')),
  related_email text,
  status text not null default 'available' check (status in ('available', 'used')),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_job_id text
);
create index if not exists customer_credits_lookup_idx on customer_credits(customer_email, status);
alter table customer_credits enable row level security;
-- No policies -- service-role only (api/create-deposit-intent.js,
-- api/stripe-webhook.js), same posture as every other table this
-- project's backend owns exclusively.
