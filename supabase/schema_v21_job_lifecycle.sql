-- Durable, retryable automation for post-booking intake, matching and ops.
begin;

alter table job_offers add column if not exists match_round integer not null default 1;
alter table job_offers add column if not exists expires_at timestamptz;
-- Older dispatch paths could create repeated offers for the same pair. Keep
-- the accepted offer when present, otherwise the oldest, before enforcing
-- the idempotency key used by the lifecycle worker.
lock table job_offers in share row exclusive mode;
delete from job_offers
where id in (
  select id from (
    select id, row_number() over (
      partition by job_id, contractor_id
      order by case when status = 'accepted' then 0 else 1 end, offered_at, id
    ) as duplicate_number
    from job_offers
  ) duplicates
  where duplicate_number > 1
);
create unique index if not exists job_offers_job_contractor_idx on job_offers(job_id, contractor_id);

create table if not exists job_workflows (
  job_id text primary key references jobs(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','awaiting_intake','matching','assigned','exception','completed','cancelled')),
  match_round integer not null default 0,
  next_retry_at timestamptz,
  last_matched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists job_workflows_retry_idx on job_workflows(state, next_retry_at);

create table if not exists ops_exceptions (
  id uuid primary key default gen_random_uuid(), job_id text references jobs(id) on delete cascade,
  exception_type text not null, summary text not null, details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), resolved_at timestamptz,
  unique(job_id, exception_type)
);
create index if not exists ops_exceptions_queue_idx on ops_exceptions(status, created_at);
create index if not exists job_offers_expiry_idx on job_offers(status, expires_at);

create table if not exists coverage_signals (
  id uuid primary key default gen_random_uuid(), zone text not null, category text not null,
  approved_contractors integer not null default 0, demand_30d integer not null default 0,
  shortage boolean not null default false, recruitment_triggered_at timestamptz,
  marketing_context jsonb not null default '{}'::jsonb, calculated_at timestamptz not null default now(),
  unique(zone, category)
);

create table if not exists recruitment_triggers (
  id uuid primary key default gen_random_uuid(), zone text not null, category text not null,
  reason text not null, demand_30d integer not null default 0, approved_contractors integer not null default 0,
  status text not null default 'open' check (status in ('open','actioned','closed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(zone, category, status)
);
create index if not exists coverage_signals_shortage_idx on coverage_signals(shortage, calculated_at);

alter table job_workflows enable row level security;
alter table ops_exceptions enable row level security;
alter table coverage_signals enable row level security;
alter table recruitment_triggers enable row level security;

commit;
