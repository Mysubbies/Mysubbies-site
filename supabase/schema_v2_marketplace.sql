-- Mysubbies marketplace backend schema — v2 (Aug 2026 small-jobs expansion)
--
-- This file is ADDITIVE to supabase/schema.sql, which already runs in
-- production and must not be disturbed (it backs the live Stripe deposit
-- flow, confirmed working end-to-end 2026-08-10). Run this file AFTER
-- schema.sql, in the same Supabase SQL editor. It only ever adds columns
-- to `jobs` (never drops/renames existing ones) and adds new tables.
--
-- Purpose: move the pieces that currently only live in browser localStorage
-- (rate card, customer/contractor accounts, job messaging/lifecycle,
-- variations, ratings) onto a real server-side source of truth, so the same
-- job is visible to a customer and contractor on two different devices —
-- which localStorage fundamentally cannot do. Designed now, per explicit
-- instruction, so the small-jobs Phase 1 build doesn't get rebuilt later.
--
-- Nothing in this file is wired up to the frontend yet. Writing the schema
-- is step one of the migration tracked as task "[Phase 2] Migrate
-- jobs/contractor accounts off localStorage onto Supabase schema" — the
-- API endpoints and page rewrites to actually use these tables are
-- separate, subsequent work.

-- ============================================================
-- LOCATIONS — city/region/suburb coverage (section 15: Melbourne first,
-- must not be hardcoded so other cities can be added without a rebuild)
-- ============================================================
create table if not exists cities (
  id text primary key,              -- e.g. 'melbourne'
  name text not null,                -- e.g. 'Melbourne'
  state text not null,               -- e.g. 'VIC'
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists suburbs (
  id text primary key,               -- e.g. 'richmond-3121'
  city_id text not null references cities(id),
  name text not null,
  postcode text not null,
  active boolean not null default true
);
create index if not exists suburbs_city_id_idx on suburbs(city_id);

-- ============================================================
-- SERVICES — the centrally-controlled rate card (section 4). Replaces
-- DEFAULT_CATEGORIES in mysubbies-website.html as the source of truth once
-- the frontend is migrated to fetch from an API instead of bundling prices
-- client-side. Until that migration lands, this table can be populated in
-- parallel without affecting the live site.
-- ============================================================
create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  category text not null,                     -- e.g. 'Plumbing', 'Handyman'
  name text not null,                          -- e.g. 'Replace kitchen mixer'
  unit text not null default 'job',
  is_small_job boolean not null default false, -- true = quick/low-ticket catalogue (section 1)

  customer_price_cents bigint,                 -- null = pricing pending founder review, not bookable
  contractor_payout_cents bigint,
  platform_margin_cents bigint generated always as
    (coalesce(customer_price_cents,0) - coalesce(contractor_payout_cents,0)) stored,

  base_labour_minutes integer,                 -- included labour allowance
  estimated_duration_minutes integer,
  material_allowance_cents bigint,
  gst_treatment text not null default 'inclusive' check (gst_treatment in ('inclusive', 'exclusive', 'exempt')),

  minimum_charge_cents bigint,                  -- per-service floor; platform-wide default lives in platform_settings
  additional_unit_price_cents bigint,           -- e.g. "+$89 each" for a second unit
  after_hours_surcharge_pct numeric(5,2) not null default 0,
  weekend_surcharge_pct numeric(5,2) not null default 0,

  service_radius_km numeric(6,2),               -- null = no radius limit
  licence_required text,                        -- e.g. 'electrician', 'plumber', null = none
  insurance_required boolean not null default false,
  photo_required boolean not null default false,

  questions jsonb not null default '[]'::jsonb, -- [{key, label, type, options?}]
  exclusions text,
  internal_notes text,                          -- admin-only, never shown to customer/contractor

  active boolean not null default true,
  needs_price_review boolean not null default false,
  rate_valid_from date not null default current_date,
  rate_review_date date,                        -- when this rate should be re-checked

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists services_category_idx on services(category);
create index if not exists services_is_small_job_idx on services(is_small_job) where is_small_job;

-- ============================================================
-- PLATFORM SETTINGS — single-row config table for admin-editable platform
-- constants (section 5: minimum booking value) instead of hardcoding them.
-- ============================================================
create table if not exists platform_settings (
  id boolean primary key default true check (id), -- enforces exactly one row
  minimum_booking_value_cents bigint not null default 14900, -- $149 default per section 5
  updated_at timestamptz not null default now()
);
insert into platform_settings (id) values (true) on conflict (id) do nothing;

-- ============================================================
-- CUSTOMERS / CONTRACTORS — real accounts. Auth itself should use Supabase
-- Auth (separate setup, not in this file); these tables hold the profile
-- data and, for contractors, the compliance/scoring fields from section 8.
-- ============================================================
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,           -- links to Supabase Auth once wired up
  email text unique not null,
  name text,
  phone text,
  created_at timestamptz not null default now()
);

create table if not exists customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  label text,                          -- e.g. 'Home'
  address text not null,
  suburb_id text references suburbs(id),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists customer_addresses_customer_id_idx on customer_addresses(customer_id);

create table if not exists contractors (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  email text unique not null,
  business_name text not null,
  abn text,
  acn text,
  phone text,
  categories text[] not null default '{}',     -- service categories this contractor covers
  suburb_ids text[] not null default '{}',      -- coverage area

  -- Compliance (section 8)
  licence_status text not null default 'manual_review'
    check (licence_status in ('valid', 'expired', 'not_required', 'manual_review')),
  licence_expiry date,
  insurance_status text not null default 'manual_review'
    check (insurance_status in ('valid', 'expired', 'not_required', 'manual_review')),
  insurance_expiry date,
  profile_verified boolean not null default false,

  status text not null default 'manual_review'
    check (status in ('approved', 'preferred', 'watchlist', 'suspended', 'expired_documents', 'manual_review')),

  -- Performance (section 8 / 7 scoring inputs)
  jobs_completed integer not null default 0,
  jobs_cancelled integer not null default 0,
  jobs_offered integer not null default 0,
  jobs_accepted integer not null default 0,
  callback_count integer not null default 0,
  complaint_count integer not null default 0,
  average_rating numeric(3,2),
  compliance_score numeric(5,2),      -- computed/admin-set; weighting is admin-editable per section 7
  reliability_score numeric(5,2),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists contractors_status_idx on contractors(status);

-- ============================================================
-- JOBS — additive extension only. Existing columns (id, category, suburb,
-- contractor_email, base_price_cents, deposit_pct, deposit_amount_cents,
-- status, disputed, created_at, completed_at) are untouched; the deposit
-- payment flow keeps working exactly as it does today.
-- ============================================================
alter table jobs add column if not exists customer_id uuid references customers(id);
alter table jobs add column if not exists service_id uuid references services(id);
alter table jobs add column if not exists contractor_id uuid references contractors(id);
alter table jobs add column if not exists address text;
alter table jobs add column if not exists suburb_id text references suburbs(id);
alter table jobs add column if not exists scheduled_window_start timestamptz;
alter table jobs add column if not exists scheduled_window_end timestamptz;
alter table jobs add column if not exists estimated_duration_minutes integer;
alter table jobs add column if not exists distance_km numeric(6,2);
alter table jobs add column if not exists contractor_payout_cents bigint;
alter table jobs add column if not exists platform_margin_cents bigint;

-- FIX SOMETHING / AI triage (sections 2, 13)
alter table jobs add column if not exists source text not null default 'browse'
  check (source in ('browse', 'fix_something', 'search'));
alter table jobs add column if not exists ai_classification jsonb;   -- {category, service, confidence, detectedIssues, questionsAsked, priceLogic}
alter table jobs add column if not exists ai_confidence numeric(5,2);
alter table jobs add column if not exists manual_review_required boolean not null default false;

-- Job lifecycle beyond payment (existing `status` check constraint stays as-is
-- for the payment states; this adds an operational stage separate from that)
alter table jobs add column if not exists stage text not null default 'submitted'
  check (stage in ('submitted', 'quoted', 'booked', 'offered', 'accepted', 'in_progress',
                    'completed', 'signed_off', 'cancelled'));

-- ============================================================
-- JOB_OFFERS — contractor dispatch (section 6-7). One job can be offered to
-- multiple eligible contractors in sequence/parallel per the matching logic;
-- only one can accept.
-- ============================================================
create table if not exists job_offers (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references jobs(id),
  contractor_id uuid not null references contractors(id),
  contractor_payout_cents bigint not null,       -- shown to contractor before accepting; margin never exposed here
  distance_km numeric(6,2),
  match_score numeric(5,2),                      -- contractor score at time of offer (section 7)
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'expired')),
  offered_at timestamptz not null default now(),
  responded_at timestamptz
);
create index if not exists job_offers_job_id_idx on job_offers(job_id);
create index if not exists job_offers_contractor_id_idx on job_offers(contractor_id);
create unique index if not exists job_offers_one_accepted_idx on job_offers(job_id)
  where status = 'accepted'; -- a job can only ever be accepted once

-- ============================================================
-- VARIATIONS — extra work found on site (section 10). Chargeable work
-- cannot proceed until approved_at is set, except emergency/safety items
-- (is_emergency), which platform policy allows to proceed and be
-- retrospectively confirmed.
-- ============================================================
create table if not exists variations (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references jobs(id),
  description text not null,
  reason text,
  photo_url text,
  amount_cents bigint not null,
  is_emergency boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined')),
  requested_at timestamptz not null default now(),
  responded_at timestamptz
);
create index if not exists variations_job_id_idx on variations(job_id);

-- ============================================================
-- JOB_EVENTS — the digital job passport (section 9): an append-only timeline
-- of everything that happens on a job. Each row is one event; the full
-- passport for a job is just "select * from job_events where job_id = ...
-- order by created_at". Visibility per role is enforced in the API layer
-- (customer/contractor/admin see different subsets), not in this table.
-- ============================================================
create table if not exists job_events (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references jobs(id),
  event_type text not null,     -- e.g. 'ai_assessed', 'quote_generated', 'accepted', 'payment_authorised',
                                 -- 'contractor_offered', 'contractor_accepted', 'arrived', 'before_photo',
                                 -- 'materials_used', 'variation_requested', 'variation_approved',
                                 -- 'after_photo', 'customer_signoff', 'invoiced', 'payout_released',
                                 -- 'warranty_issued', 'complaint_raised', 'completed'
  actor_role text not null check (actor_role in ('customer', 'contractor', 'admin', 'system')),
  actor_id text,                 -- customer/contractor id, or 'system' for automated events
  payload jsonb not null default '{}'::jsonb,  -- event-specific data (photo URLs, amounts, notes, etc.)
  visible_to text[] not null default '{customer,contractor,admin}', -- role-based visibility per section 9
  created_at timestamptz not null default now()
);
create index if not exists job_events_job_id_idx on job_events(job_id, created_at);

-- ============================================================
-- RATINGS — customer rating of a completed job/contractor.
-- ============================================================
create table if not exists ratings (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references jobs(id) unique, -- one rating per job
  contractor_id uuid not null references contractors(id),
  stars integer not null check (stars between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);
create index if not exists ratings_contractor_id_idx on ratings(contractor_id);

-- ============================================================
-- Row Level Security — same posture as schema.sql: enabled with no
-- policies, so only the service_role key (used server-side in /api
-- functions only) can read/write. Nothing here is reachable from the
-- browser directly.
-- ============================================================
alter table cities enable row level security;
alter table suburbs enable row level security;
alter table services enable row level security;
alter table platform_settings enable row level security;
alter table customers enable row level security;
alter table customer_addresses enable row level security;
alter table contractors enable row level security;
alter table job_offers enable row level security;
alter table variations enable row level security;
alter table job_events enable row level security;
alter table ratings enable row level security;

-- ============================================================
-- The ONE deliberate exception to "service_role only, no policies": a
-- logged-in Supabase Auth user may view/create/update ONLY their own
-- customer/contractor profile row (matched via auth_user_id = auth.uid()).
-- This is what lets the browser call Supabase Auth directly with the
-- public anon key for signup/login, without needing a custom /api
-- endpoint just to create a session. Every other table (jobs, payments,
-- job_offers, etc.) still has zero policies — untouchable except via the
-- service_role key in /api functions.
-- ============================================================
create policy "customers can view own row" on customers
  for select using (auth.uid() = auth_user_id);
create policy "customers can insert own row" on customers
  for insert with check (auth.uid() = auth_user_id);
create policy "customers can update own row" on customers
  for update using (auth.uid() = auth_user_id);

create policy "contractors can view own row" on contractors
  for select using (auth.uid() = auth_user_id);
create policy "contractors can insert own row" on contractors
  for insert with check (auth.uid() = auth_user_id);
create policy "contractors can update own row" on contractors
  for update using (auth.uid() = auth_user_id);
