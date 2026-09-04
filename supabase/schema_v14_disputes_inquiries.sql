-- Real, server-side disputes + inquiries (added Sep 2026, pre-launch audit).
-- Both were previously 100% localStorage-only in every portal (customer,
-- contractor, admin each read/wrote their OWN browser's copy) -- a
-- customer's "Report a problem" or "Contact MySubbies" submission showed a
-- reassuring "our team will review this" message but never reached admin
-- on any device. Found during a pre-soft-launch audit; fixed the same
-- session using the notifications infrastructure already built
-- (supabase/schema_v13_notifications.sql, api/notifications.js) so a new
-- dispute/inquiry both persists here AND triggers a real admin
-- notification (bell + email), closing the loop completely.

create table if not exists disputes (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references jobs(id),
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  reported_by text not null check (reported_by in ('customer', 'contractor')),
  reported_by_email text not null,
  reported_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists disputes_status_idx on disputes(status);
create index if not exists disputes_job_id_idx on disputes(job_id);
alter table disputes enable row level security;

create table if not exists inquiries (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('customer', 'contractor')),
  name text,
  email text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inquiries_status_idx on inquiries(status);
create index if not exists inquiries_email_idx on inquiries(email);
alter table inquiries enable row level security;
-- No policies on either table -- service-role only (api/support.js), same
-- posture as every other table this project's backend owns exclusively.
