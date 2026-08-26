-- Property Profiles (Phase 1, added Aug 2026)
--
-- A permanent, address-keyed record of every completed job done at a
-- property, auto-populated from api/sync-jobs.js on every job sync (not a
-- separate manual-entry flow). See CLAUDE.md for the full feature writeup,
-- including why proactive maintenance reminders and warranties are NOT part
-- of this phase (no real maintenance-interval or warranty data exists yet
-- to build them on honestly).
--
-- job.address is free text (no geocoding/verification) -- normalized_address
-- is a best-effort string match (trim/lowercase/collapse whitespace), not a
-- guaranteed exact-property match. See normalizeAddress() in api/sync-jobs.js.

create table if not exists property_profiles (
  id uuid primary key default gen_random_uuid(),
  normalized_address text not null unique,
  address text not null,        -- original, display-quality string (most recent seen)
  suburb text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists property_history (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references property_profiles(id),
  job_id text not null unique references jobs(id),   -- text, matches jobs.id's scheme (job_<timestamp>_<rand>)
  category text not null,
  task_summary text,            -- derived from job.items (taskName list), never invented
  contractor_email text,
  contractor_name text,
  amount_paid_cents bigint,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists property_history_property_id_idx on property_history(property_id);

alter table property_profiles enable row level security;
alter table property_history enable row level security;
