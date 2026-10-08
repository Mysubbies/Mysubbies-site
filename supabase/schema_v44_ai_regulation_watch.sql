-- AI-powered regulation watch additions.
alter table public.marketing_regulation_watch
  add column if not exists detection_source text not null default 'manual',
  add column if not exists review_status text not null default 'reviewed',
  add column if not exists ai_confidence numeric(5,2),
  add column if not exists detected_at timestamptz,
  add column if not exists source_published_at timestamptz,
  add column if not exists campaign_headline text,
  add column if not exists campaign_cta text,
  add column if not exists source_fingerprint text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'marketing_regulation_watch_review_status_check'
  ) then
    alter table public.marketing_regulation_watch
      add constraint marketing_regulation_watch_review_status_check
      check (review_status in ('needs_review','reviewed','dismissed'));
  end if;
end $$;

create unique index if not exists marketing_regulation_watch_source_fingerprint_uq
  on public.marketing_regulation_watch(source_fingerprint)
  where source_fingerprint is not null;

create table if not exists public.marketing_regulation_scan_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running'
    check (status in ('running','success','failed')),
  sources_checked integer not null default 0,
  candidates_found integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  error_text text
);

alter table public.marketing_regulation_scan_runs enable row level security;
revoke all privileges on table public.marketing_regulation_scan_runs from anon, authenticated;

notify pgrst, 'reload schema';
