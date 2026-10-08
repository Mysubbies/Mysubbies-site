-- Automated AI regulation watch for the MySubbies Marketing Centre.
-- Daily cron scans official regulator pages, compares page fingerprints,
-- uses AI only when a source changes, and stores reviewable opportunities.

alter table public.marketing_regulation_watch
  add column if not exists review_status text not null default 'pending'
    check (review_status in ('pending','approved','rejected'));

alter table public.marketing_regulation_watch
  add column if not exists detected_at timestamptz;

alter table public.marketing_regulation_watch
  add column if not exists ai_generated boolean not null default false;

alter table public.marketing_regulation_watch
  add column if not exists ai_confidence numeric(5,2);

alter table public.marketing_regulation_watch
  add column if not exists suggested_headline text;

alter table public.marketing_regulation_watch
  add column if not exists suggested_cta text;

alter table public.marketing_regulation_watch
  add column if not exists source_fingerprint text;

create unique index if not exists marketing_regulation_watch_fingerprint_uq
  on public.marketing_regulation_watch(source_fingerprint)
  where source_fingerprint is not null;

create table if not exists public.marketing_regulation_scan_sources (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_url text not null unique,
  jurisdiction text not null default 'Victoria',
  source_type text not null default 'government',
  enabled boolean not null default true,
  last_content_hash text,
  last_scanned_at timestamptz,
  last_changed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.marketing_regulation_scan_sources
  (source_name, source_url, jurisdiction, source_type)
values
  ('Consumer Affairs Victoria', 'https://www.consumer.vic.gov.au/news-and-alerts', 'Victoria', 'regulator'),
  ('Consumer Affairs Victoria - Renting', 'https://www.consumer.vic.gov.au/housing/renting', 'Victoria', 'regulator'),
  ('WorkSafe Victoria', 'https://www.worksafe.vic.gov.au/news', 'Victoria', 'regulator'),
  ('Energy Safe Victoria', 'https://www.energysafe.vic.gov.au/newsroom', 'Victoria', 'regulator'),
  ('EPA Victoria', 'https://www.epa.vic.gov.au/about-epa/news-media-and-updates', 'Victoria', 'regulator'),
  ('Victorian Planning', 'https://www.planning.vic.gov.au/guides-and-resources/legislation-regulation-and-fees', 'Victoria', 'government'),
  ('Victorian Legislation', 'https://www.legislation.vic.gov.au/', 'Victoria', 'legislation')
on conflict (source_url) do nothing;

alter table public.marketing_regulation_scan_sources enable row level security;
revoke all privileges on table public.marketing_regulation_scan_sources from anon, authenticated;

notify pgrst, 'reload schema';
