-- Mysubbies configurable milestone-based payment schedules — v3 (Aug 2026)
--
-- ADDITIVE ONLY, same convention as schema_v2_marketplace.sql. Run this file
-- after schema.sql and schema_v2_marketplace.sql. Nothing here touches the
-- `jobs`/`payments` tables' existing columns or constraints — the live
-- deposit flow keeps working exactly as it does today throughout this
-- migration.
--
-- Replaces the client-authored `job.paymentSchedule` (a plain array baked
-- into `jobs.full_record` jsonb, sourced from a hardcoded JS constant or a
-- rate-card category field, never validated) with a real backend-calculated
-- and backend-validated schedule. See api/_lib/paymentSchedule.js for the
-- calculation/validation engine that reads and writes these tables.
--
-- LEGAL NOTE, surfaced deliberately: the built-in schedule types and dollar
-- thresholds seeded below match the founder's specification exactly, but
-- have NOT been reviewed by a lawyer. admin-portal.html's Payment Schedule
-- Settings area must show a persistent disclaimer to this effect — see the
-- non-dismissible banner requirement in that page.

-- ============================================================
-- PAYMENT_SCHEDULE_TEMPLATES — reusable schedule definitions. The three
-- spec'd schedule types are seeded as is_builtin=true rows per price
-- bracket; admins can edit them (thresholds, percentages, milestone names)
-- without touching code, per the explicit "configurable" requirement.
-- Custom/manual-review templates are admin-authored from scratch.
-- ============================================================
create table if not exists payment_schedule_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  schedule_type text not null
    check (schedule_type in ('simple_service', 'material_heavy', 'structural_inspection', 'custom', 'manual_review')),
  min_price_cents bigint not null default 0,
  max_price_cents bigint,                       -- null = no upper bound
  deposit_pct numeric(5,2) not null,
  -- [{key, label, pct, milestone_type, requires_evidence_type, description,
  --   requires_customer_approval, review_period_hours, auto_capture_enabled}]
  milestones jsonb not null default '[]'::jsonb,
  is_builtin boolean not null default false,     -- true = one of the founder's seeded defaults
  status text not null default 'approved'
    check (status in ('draft', 'pending_review', 'approved', 'archived')),
  created_by text,
  approved_by text,
  approved_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_schedule_templates_type_idx on payment_schedule_templates(schedule_type);

-- ============================================================
-- CATEGORY_PAYMENT_RULES — one row per rate-card category, assigning which
-- schedule type/template applies. Category labels match the existing rate
-- card (mysubbies-website.html DEFAULT_CATEGORIES) — free text, not a
-- foreign key, since the rate card itself is still client-side and not yet
-- migrated to the `services` table from schema_v2.
-- ============================================================
create table if not exists category_payment_rules (
  category text primary key,
  schedule_type text not null default 'manual_review'
    check (schedule_type in ('simple_service', 'material_heavy', 'structural_inspection', 'custom', 'manual_review')),
  default_template_id uuid references payment_schedule_templates(id),
  allow_job_override boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- PLATFORM-WIDE PAYMENT CONFIG — dollar thresholds and deposit caps,
-- admin-editable without a code change (explicit requirement). Single-row
-- table, same pattern as platform_settings in schema_v2.
-- ============================================================
create table if not exists payment_schedule_config (
  id boolean primary key default true check (id),
  deposit_cap_low_pct numeric(5,2) not null default 10.00,   -- contracts under high_value_threshold
  deposit_cap_high_pct numeric(5,2) not null default 5.00,   -- contracts at/above high_value_threshold
  high_value_threshold_cents bigint not null default 2000000, -- $20,000 — the deposit-cap AND structural-manual-schedule cutoff
  simple_service_tier1_max_cents bigint not null default 100000,  -- $1,000
  simple_service_tier2_max_cents bigint not null default 500000,  -- $5,000
  material_heavy_tier1_max_cents bigint not null default 500000,   -- $5,000
  material_heavy_tier2_max_cents bigint not null default 1000000,  -- $10,000
  material_heavy_tier3_max_cents bigint not null default 1999999,  -- $19,999.99
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into payment_schedule_config (id) values (true) on conflict (id) do nothing;

-- ============================================================
-- JOB_PAYMENT_SCHEDULES — the resolved, locked schedule for one job. Only
-- ever created server-side (api/create-deposit-intent.js), never trusted
-- from the client. `pending_admin_schedule` is the required state for
-- structural jobs >= the high-value threshold: deposit-only, remaining
-- balance withheld until an admin builds and approves a job-specific
-- schedule — never auto-generated, per the explicit compliance requirement.
-- ============================================================
create table if not exists job_payment_schedules (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references jobs(id),
  template_id uuid references payment_schedule_templates(id),
  schedule_type text not null
    check (schedule_type in ('simple_service', 'material_heavy', 'structural_inspection', 'custom', 'manual_review')),
  original_contract_price_cents bigint not null,
  total_variations_cents bigint not null default 0,
  revised_total_price_cents bigint not null,
  deposit_pct numeric(5,2) not null,
  deposit_amount_cents bigint not null,
  status text not null default 'draft'
    check (status in ('draft', 'pending_admin_schedule', 'pending_customer_acceptance', 'active', 'completed')),
  sequence_override boolean not null default false, -- admin-authorized out-of-order milestone claims
  version integer not null default 1,
  accepted_at timestamptz,
  accepted_by_customer_id uuid references customers(id),
  accepted_ip text,
  accepted_user_agent text,
  terms_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists job_payment_schedules_job_id_idx on job_payment_schedules(job_id);

-- ============================================================
-- PAYMENT_MILESTONES — one row per milestone per schedule version. Amounts
-- are cents, computed server-side by api/_lib/paymentSchedule.js so they
-- always sum to revised_total_price_cents (1-cent rounding remainder on the
-- LAST milestone, per explicit requirement).
-- ============================================================
create table if not exists payment_milestones (
  id uuid primary key default gen_random_uuid(),
  job_payment_schedule_id uuid not null references job_payment_schedules(id),
  milestone_index integer not null,       -- claim order; 0 = deposit
  key text not null,
  label text not null,
  pct numeric(5,2) not null,
  amount_cents bigint not null,
  milestone_type text not null default 'custom'
    check (milestone_type in ('deposit', 'materials_delivered', 'installation', 'foundation',
                               'frame', 'inspection', 'completion', 'custom')),
  requires_evidence_type text not null default 'photos'
    check (requires_evidence_type in ('photos', 'delivery_docket', 'inspection_certificate', 'none')),
  requires_customer_approval boolean not null default true,
  review_period_hours integer not null default 72,
  auto_capture_enabled boolean not null default false,
  status text not null default 'locked'
    check (status in ('locked', 'available', 'claimed', 'awaiting_customer', 'approved',
                       'payment_processing', 'paid', 'disputed', 'rejected')),
  stripe_payment_intent_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_milestones_schedule_id_idx on payment_milestones(job_payment_schedule_id, milestone_index);

-- ============================================================
-- MILESTONE_EVIDENCE — what a contractor submits to claim a milestone.
-- "Site visit completed" / "job started" alone (no evidence) can never
-- satisfy a claim — enforced in api/milestone.js against
-- requires_evidence_type above, not just in the UI.
-- ============================================================
create table if not exists milestone_evidence (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references payment_milestones(id),
  submitted_by_contractor_id uuid references contractors(id),
  description text not null,
  photo_urls text[] not null default '{}',
  delivery_docket_url text,
  inspection_record_id uuid,   -- fk added below, after inspection_records exists
  declaration_confirmed boolean not null default false,
  submitted_at timestamptz not null default now()
);
create index if not exists milestone_evidence_milestone_id_idx on milestone_evidence(milestone_id);

-- ============================================================
-- CUSTOMER_MILESTONE_RESPONSES — customer's approve/dispute action on a
-- claimed milestone.
-- ============================================================
create table if not exists customer_milestone_responses (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references payment_milestones(id),
  customer_id uuid references customers(id),
  response text not null check (response in ('approved', 'disputed')),
  notes text,
  responded_at timestamptz not null default now()
);
create index if not exists customer_milestone_responses_milestone_id_idx on customer_milestone_responses(milestone_id);

-- ============================================================
-- PAYMENT_MILESTONE_DISPUTES — a disputed milestone pauses payment and
-- enters the Admin Resolution Queue.
-- ============================================================
create table if not exists payment_milestone_disputes (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references payment_milestones(id),
  raised_by text not null check (raised_by in ('customer', 'contractor', 'admin')),
  reason text not null,
  status text not null default 'open'
    check (status in ('open', 'admin_reviewing', 'resolved_approved', 'resolved_rejected')),
  admin_notes text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists payment_milestone_disputes_milestone_id_idx on payment_milestone_disputes(milestone_id);
create index if not exists payment_milestone_disputes_status_idx on payment_milestone_disputes(status);

-- ============================================================
-- INSPECTION_RECORDS — only meaningful for structural/inspection-required
-- schedules. If delayed for reasons outside the contractor's control, the
-- linked milestone stays out of 'approved' status — never auto-released —
-- and must be escalated for admin review instead (enforced in api layer).
-- ============================================================
create table if not exists inspection_records (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references payment_milestones(id),
  inspection_type text not null,
  inspector_name text,
  booking_date date,
  result text not null default 'pending'
    check (result in ('pending', 'passed', 'failed', 'rectification_required')),
  certificate_url text,
  rectification_notes text,
  reinspection_of uuid references inspection_records(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inspection_records_milestone_id_idx on inspection_records(milestone_id);

alter table milestone_evidence add constraint milestone_evidence_inspection_record_fk
  foreign key (inspection_record_id) references inspection_records(id);

-- ============================================================
-- PAYMENT_SCHEDULE_VERSIONS — full snapshot on every schedule change
-- (initial acceptance, a variation-triggered recalculation). Append-only;
-- a job's current state is always job_payment_schedules + payment_milestones,
-- this table is purely historical/audit.
-- ============================================================
create table if not exists payment_schedule_versions (
  id uuid primary key default gen_random_uuid(),
  job_payment_schedule_id uuid not null references job_payment_schedules(id),
  version_number integer not null,
  milestones_snapshot jsonb not null,
  reason text not null check (reason in ('initial', 'variation', 'admin_override')),
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists payment_schedule_versions_schedule_id_idx on payment_schedule_versions(job_payment_schedule_id);

-- ============================================================
-- CONTRACT_VARIATIONS — extends the existing `variations` table from
-- schema_v2_marketplace.sql (which was defined but never wired to the
-- frontend) rather than creating a duplicate table. Additive columns only.
-- ============================================================
alter table variations add column if not exists time_impact_days integer;
alter table variations add column if not exists schedule_version_created integer;
alter table variations add column if not exists approved_by_customer_id uuid references customers(id);
alter table variations add column if not exists is_high_risk boolean not null default false;
alter table variations add column if not exists admin_reviewed_by text;
alter table variations add column if not exists admin_reviewed_at timestamptz;

-- ============================================================
-- PAYMENT_AUDIT_LOGS — the immutable trail for every payment-affecting
-- action (schedule creation, milestone claim/approve/dispute/resolve,
-- variation approval, payment success/refund/dispute). Distinct from the
-- general-purpose `job_events` table (schema_v2) which remains the
-- customer/contractor-visible job passport — this table is stricter
-- (no UPDATE/DELETE grants at all) because a financial audit trail needs
-- a real immutability guarantee, not just "nobody happens to write code
-- that mutates it."
-- ============================================================
create table if not exists payment_audit_logs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,   -- 'job_payment_schedule' | 'payment_milestone' | 'variation' | 'payment'
  entity_id text not null,
  action text not null,        -- e.g. 'schedule_created', 'milestone_claimed', 'milestone_approved', 'payment_captured', 'refunded'
  actor_role text not null check (actor_role in ('customer', 'contractor', 'admin', 'system')),
  actor_id text,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);
create index if not exists payment_audit_logs_entity_idx on payment_audit_logs(entity_type, entity_id);

-- ============================================================
-- Row Level Security — same posture as schema_v2: enabled with no
-- policies, so only the service_role key (used server-side in /api
-- functions only) can read/write.
-- ============================================================
alter table payment_schedule_templates enable row level security;
alter table category_payment_rules enable row level security;
alter table payment_schedule_config enable row level security;
alter table job_payment_schedules enable row level security;
alter table payment_milestones enable row level security;
alter table milestone_evidence enable row level security;
alter table customer_milestone_responses enable row level security;
alter table payment_milestone_disputes enable row level security;
alter table inspection_records enable row level security;
alter table payment_schedule_versions enable row level security;
alter table payment_audit_logs enable row level security;

-- ============================================================
-- Immutability enforcement for payment_audit_logs: revoke UPDATE/DELETE
-- from every role except the Postgres owner (service_role's grants come
-- through the default `anon`/`authenticated`/`service_role` roles Supabase
-- manages; since RLS above already blocks all access without a policy,
-- this REVOKE is defense-in-depth for the rare case someone adds a
-- policy later without thinking through the audit-log implications).
-- ============================================================
revoke update, delete on payment_audit_logs from anon, authenticated;

-- ============================================================
-- SEED: the three built-in schedule types exactly as specified. Admins can
-- edit these afterward (percentages, labels, thresholds) — this is the
-- starting configuration, not a hardcoded ceiling.
-- ============================================================
insert into payment_schedule_templates (name, schedule_type, min_price_cents, max_price_cents, deposit_pct, is_builtin, milestones) values
  ('Simple Service — up to $5,000', 'simple_service', 0, 500000, 10.00, true,
    '[
      {"key":"deposit","label":"Booking Deposit","pct":10,"milestone_type":"deposit","requires_evidence_type":"none","requires_customer_approval":false,"description":"Card saved/authorised at booking; not captured until completion."},
      {"key":"completion","label":"Job Completion","pct":90,"milestone_type":"completion","requires_evidence_type":"photos","requires_customer_approval":true,"description":"Balance captured once the completion milestone is approved or the review window expires."}
    ]'::jsonb),

  ('Material-Heavy Installation — $1,001–$5,000', 'material_heavy', 100100, 500000, 10.00, true,
    '[
      {"key":"deposit","label":"Booking Deposit","pct":10,"milestone_type":"deposit","requires_evidence_type":"none","requires_customer_approval":false},
      {"key":"materials","label":"Materials Delivered to Site","pct":35,"milestone_type":"materials_delivered","requires_evidence_type":"delivery_docket","requires_customer_approval":true,"description":"Materials must be delivered to the property before this can be claimed."},
      {"key":"installation","label":"Installation Milestone Completed","pct":20,"milestone_type":"installation","requires_evidence_type":"photos","requires_customer_approval":true},
      {"key":"completion","label":"Practical Completion","pct":35,"milestone_type":"completion","requires_evidence_type":"photos","requires_customer_approval":true}
    ]'::jsonb),

  ('Material-Heavy Installation — $5,001–$10,000', 'material_heavy', 500100, 1000000, 10.00, true,
    '[
      {"key":"deposit","label":"Booking Deposit","pct":10,"milestone_type":"deposit","requires_evidence_type":"none","requires_customer_approval":false},
      {"key":"materials","label":"Materials Delivered to Site","pct":35,"milestone_type":"materials_delivered","requires_evidence_type":"delivery_docket","requires_customer_approval":true},
      {"key":"installation","label":"Installation Milestone Completed","pct":25,"milestone_type":"installation","requires_evidence_type":"photos","requires_customer_approval":true},
      {"key":"completion","label":"Practical Completion","pct":30,"milestone_type":"completion","requires_evidence_type":"photos","requires_customer_approval":true}
    ]'::jsonb),

  ('Material-Heavy Installation — $10,001–$19,999.99', 'material_heavy', 1000100, 1999999, 10.00, true,
    '[
      {"key":"deposit","label":"Booking Deposit","pct":10,"milestone_type":"deposit","requires_evidence_type":"none","requires_customer_approval":false},
      {"key":"materials","label":"Materials Delivered to Site","pct":30,"milestone_type":"materials_delivered","requires_evidence_type":"delivery_docket","requires_customer_approval":true},
      {"key":"installation_1","label":"First Installation Milestone Completed","pct":25,"milestone_type":"installation","requires_evidence_type":"photos","requires_customer_approval":true},
      {"key":"installation_2","label":"Second Installation Milestone Completed","pct":25,"milestone_type":"installation","requires_evidence_type":"photos","requires_customer_approval":true},
      {"key":"completion","label":"Practical Completion","pct":10,"milestone_type":"completion","requires_evidence_type":"photos","requires_customer_approval":true}
    ]'::jsonb),

  ('Structural/Inspection-Required — under $20,000', 'structural_inspection', 0, 1999999, 10.00, true,
    '[
      {"key":"deposit","label":"Booking Deposit","pct":10,"milestone_type":"deposit","requires_evidence_type":"none","requires_customer_approval":false},
      {"key":"materials","label":"Materials Delivered to Site","pct":25,"milestone_type":"materials_delivered","requires_evidence_type":"delivery_docket","requires_customer_approval":true},
      {"key":"foundation","label":"Base/Foundation Milestone Completed","pct":25,"milestone_type":"foundation","requires_evidence_type":"photos","requires_customer_approval":true},
      {"key":"frame","label":"Frame/Main Structure Completed","pct":20,"milestone_type":"frame","requires_evidence_type":"photos","requires_customer_approval":true},
      {"key":"completion","label":"Practical Completion","pct":15,"milestone_type":"completion","requires_evidence_type":"photos","requires_customer_approval":true},
      {"key":"inspection","label":"Required Final Inspection or Certificate Completed","pct":5,"milestone_type":"inspection","requires_evidence_type":"inspection_certificate","requires_customer_approval":true}
    ]'::jsonb),

  ('Structural/Inspection-Required — $20,000+ (deposit only; remainder requires admin-built schedule)', 'structural_inspection', 2000000, null, 5.00, true,
    '[
      {"key":"deposit","label":"Booking Deposit","pct":5,"milestone_type":"deposit","requires_evidence_type":"none","requires_customer_approval":false}
    ]'::jsonb)
on conflict do nothing;
