-- Branded Quoting/Invoicing CRM -- Stage 1 core spine (Sep 2026)
--
-- Confirmed via full-repo audit before writing this: no `quotes` table, no
-- `invoices` table, and no issuing-entity config existed anywhere prior to
-- this migration. "Quote" previously meant only the instant-estimator's
-- transient localStorage cart object (mysubbies_pending_quote), which flows
-- straight into a `jobs` row with no persisted record, ID, expiry or
-- acceptance step. This migration is additive only (RLS enabled, no
-- policies -- service-role only via /api, same posture as every prior
-- schema_v*.sql file) and is Stage 1 of a larger, explicitly staged build
-- -- invoicing, payment allocation, admin reporting and branded email are
-- deferred to later stages; several columns here (jobs.job_id FK on
-- quotes, payment_schedule_note, the generalized document_type on
-- document_access_tokens) exist purely so those stages don't need a
-- breaking migration later.

-- ============================================================
-- ISSUING_ENTITIES -- the legal entity a quote/invoice is issued from.
-- Single real row seeded below (Mysubbies Holdings Pty Ltd, ABN
-- 69 693 675 268, per CLAUDE.md's Sept 2026 entity-migration note --
-- confirmed via grep that no other entity name/ABN appears anywhere in
-- the live codebase). No multi-entity UI in Stage 1; document issuance
-- must fail closed if no active row exists here, per the explicit
-- requirement not to assume Mysubbies can always issue every document.
-- ============================================================
create table if not exists issuing_entities (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  abn text not null,
  trading_name text,
  address_line text,
  suburb text,
  state text default 'VIC',
  postcode text,
  email text,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into issuing_entities (legal_name, abn, suburb, state, email)
select 'Mysubbies Holdings Pty Ltd', '69 693 675 268', 'Melbourne', 'VIC', 'accounts@mysubbies.com.au'
where not exists (select 1 from issuing_entities);

-- ============================================================
-- STAFF_MEMBERS -- attributable identity for admin CRM fields (assigned
-- staff, follow-up owner, "who verified"). This is NOT a login/auth
-- system -- no password, no session token. Real per-admin authentication
-- would be a much larger, separate project (this codebase's admin portal
-- has exactly one shared password today, see api/_lib/adminAuth.js); this
-- table exists purely so a quote/CRM record can say a real name instead
-- of the generic 'admin' string every other action in this codebase is
-- attributed to.
-- ============================================================
create table if not exists staff_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- QUOTES -- durable identity. quote_number mirrors jobs.job_number's exact
-- pattern (schema_v10_job_numbers.sql): a real Postgres sequence, never a
-- client-assigned value, so it's safe to read aloud/reference in a
-- dispute the same way a job number already is.
--
-- current_status is the WHOLE-QUOTE lifecycle. 'superseded' is
-- deliberately NOT a value here -- it only ever applies to a single
-- quote_versions row (below); the quote itself is always exactly one of
-- draft/sent/accepted/declined/expired/withdrawn regardless of how many
-- versions it has been through.
-- ============================================================
create sequence if not exists quotes_quote_number_seq;

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  quote_number bigint not null unique default nextval('quotes_quote_number_seq'),
  customer_id uuid not null references customers(id),
  job_id text references jobs(id),  -- nullable Stage-2 hook (quote -> job conversion); unused in Stage 1
  current_version_id uuid,          -- FK added below once quote_versions exists (deferred FK, same
                                     -- technique already used for milestone_evidence.inspection_record_id
                                     -- in schema_v3_payment_schedules.sql)
  current_status text not null default 'draft'
    check (current_status in ('draft', 'sent', 'accepted', 'declined', 'expired', 'withdrawn')),
  assigned_staff_id uuid references staff_members(id),
  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists quotes_customer_id_idx on quotes(customer_id);
create index if not exists quotes_status_idx on quotes(current_status);

alter sequence quotes_quote_number_seq owned by quotes.quote_number;

-- ============================================================
-- QUOTE_VERSIONS -- immutable per-version snapshot. A revision always
-- creates a NEW row (version_number + 1); the previous row is stamped
-- superseded_by_version_id and stays permanently readable -- it is never
-- rewritten. Only a row with status='draft' is ever recomputed in place
-- (full recompute on every save, since a draft isn't locked yet); once a
-- version is issued its content is frozen for good.
--
-- Money fields are always server-computed (see api/_lib/quoteMath.js) --
-- never trust a client-submitted total. Each line item carries its own
-- tax_treatment (inside line_items jsonb, not a column) so a future
-- category/entity isn't locked into one hardcoded rate, but every item
-- defaults to 'gst_inclusive_10' -- the one real GST convention already
-- used across this codebase's existing receipt PDFs and Terms page
-- ("prices shown are GST inclusive"), so Stage 1 never requires
-- configuring tax on the existing ~163 rate-card tasks before any quote
-- can be issued.
-- ============================================================
create table if not exists quote_versions (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id),
  version_number integer not null,
  status text not null default 'draft'
    check (status in ('draft', 'issued', 'accepted', 'declined', 'expired', 'withdrawn', 'superseded')),
  issuing_entity_id uuid references issuing_entities(id),

  -- Snapshots -- copied at issue time so a later customer/property edit
  -- never silently rewrites what was actually shown/accepted.
  customer_snapshot jsonb not null default '{}'::jsonb,  -- {name, email, phone, billingAddress}
  property_snapshot jsonb,                                -- {address, suburb} -- best-effort string,
                                                           -- matching property_profiles' existing
                                                           -- string-match convention, not a real FK

  line_items jsonb not null default '[]'::jsonb,
    -- [{id, rateCardItemId, description, qty, unit, unitPriceCents,
    --   taxTreatment: 'gst_inclusive_10'|'gst_exclusive', lineTotalCents,
    --   exGstCents, gstCents}]
  subtotal_ex_gst_cents bigint not null default 0,
  gst_cents bigint not null default 0,
  total_inc_gst_cents bigint not null default 0,

  scope_text text,
  inclusions_text text,
  exclusions_text text,
  payment_schedule_note jsonb,  -- free-form placeholder only -- Stage 2 (invoicing) computes/enforces a
                                 -- real schedule; this column exists now so that later addition is
                                 -- additive, not a schema break.
  terms_version text,
  attachments jsonb not null default '[]'::jsonb,  -- base64-inline, matching the ONE real Storage bucket
                                                    -- precedent in this codebase (rate-card-photos) --
                                                    -- everything else already inlines jsonb/text, so quote
                                                    -- attachments follow that instead of a new bucket.

  validity_days integer not null default 30,
  issued_at timestamptz,
  expires_at timestamptz,
  superseded_by_version_id uuid references quote_versions(id),

  -- Acceptance identity is the CUSTOMER's, captured at accept time --
  -- distinct from assigned_staff_id on `quotes` (internal attribution).
  accepted_at timestamptz,
  accepted_by_name text,
  accepted_by_email text,
  accepted_ip text,
  accepted_user_agent text,
  declined_at timestamptz,
  declined_reason text,

  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quote_id, version_number)
);
create index if not exists quote_versions_quote_id_idx on quote_versions(quote_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_current_version_fk') then
    alter table quotes add constraint quotes_current_version_fk
      foreign key (current_version_id) references quote_versions(id);
  end if;
end $$;

-- ============================================================
-- QUOTE_EVENTS -- append-only activity feed / audit trail. Mirrors
-- payment_audit_logs' shape and immutability posture exactly (same
-- revoke below) -- this is both the CRM detail view's timeline and the
-- record of who accepted/declined a quote and when.
-- ============================================================
create table if not exists quote_events (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id),
  quote_version_id uuid references quote_versions(id),
  event_type text not null,  -- 'draft_created' | 'draft_updated' | 'issued' | 'viewed' | 'accepted' |
                              -- 'declined' | 'expired' | 'withdrawn' | 'revised' | 'question_asked'
  actor_role text not null check (actor_role in ('admin', 'customer', 'system')),
  actor_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists quote_events_quote_id_idx on quote_events(quote_id, created_at);

-- ============================================================
-- DOCUMENT_ACCESS_TOKENS -- token stored as a SHA-256 HASH only (Node's
-- built-in crypto, no new dependency -- same posture as
-- api/_lib/adminAuth.js's session-token signing). Generalized via
-- document_type/document_id rather than a quote-specific FK, so a later
-- invoice token can reuse this exact table without a new migration.
-- ============================================================
create table if not exists document_access_tokens (
  id uuid primary key default gen_random_uuid(),
  document_type text not null check (document_type in ('quote_version')),
  document_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  last_accessed_at timestamptz
);
create index if not exists document_access_tokens_document_idx on document_access_tokens(document_type, document_id);

-- ============================================================
-- DOCUMENT_ACCESS_ATTEMPTS -- Postgres-backed rate limiting for token
-- lookups. This stack has no Redis/external rate-limit service, and a
-- stateless serverless function can't hold in-memory counters across
-- invocations, so every attempt (success or failure) is logged here and
-- checked BEFORE the real token lookup runs.
-- ============================================================
create table if not exists document_access_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists document_access_attempts_ip_idx on document_access_attempts(ip, created_at);

-- ============================================================
-- Let an "Ask a question" submission on a quote page land in the
-- EXISTING inquiries system (admin-bell + admin-email already wired in
-- api/support.js) instead of building new notification plumbing, which
-- is explicitly deferred to a later stage.
-- ============================================================
alter table inquiries add column if not exists quote_id uuid references quotes(id);

alter table issuing_entities enable row level security;
alter table staff_members enable row level security;
alter table quotes enable row level security;
alter table quote_versions enable row level security;
alter table quote_events enable row level security;
alter table document_access_tokens enable row level security;
alter table document_access_attempts enable row level security;

-- Immutability enforcement for quote_events, mirroring
-- payment_audit_logs' exact same revoke (schema_v3_payment_schedules.sql).
revoke update, delete on quote_events from anon, authenticated;
