-- MySubbies Growth Marketing Centre
-- Unified facility-maintenance prospecting, compliant campaign sends,
-- regulation opportunity watch, and SEO/SEM target planning.

create table if not exists public.marketing_contacts (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  segment text not null,
  contact_name text,
  email text,
  phone text,
  website text,
  suburb text,
  state text default 'VIC',
  source_provider text,
  source_url text,
  source_reference text,
  consent_status text not null default 'unknown'
    check (consent_status in ('unknown','express','inferred','existing_relationship','opted_out')),
  consent_basis text,
  consent_recorded_at timestamptz,
  marketing_eligible boolean not null default false,
  status text not null default 'prospect'
    check (status in ('prospect','contacted','engaged','qualified','customer','archived')),
  last_contacted_at timestamptz,
  notes text,
  unsubscribe_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists marketing_contacts_email_uq
  on public.marketing_contacts(lower(email)) where email is not null;
create index if not exists marketing_contacts_segment_idx
  on public.marketing_contacts(segment,status,updated_at desc);
create unique index if not exists marketing_contacts_unsub_uq
  on public.marketing_contacts(unsubscribe_token);
alter table public.marketing_contacts enable row level security;
revoke all privileges on table public.marketing_contacts from anon, authenticated;

alter table public.marketing_campaigns add column if not exists email_subject text;
alter table public.marketing_campaigns add column if not exists email_html text;
alter table public.marketing_campaigns add column if not exists flyer_copy text;
alter table public.marketing_campaigns add column if not exists regulation_id uuid;
alter table public.marketing_campaigns add column if not exists audience_segments text[] not null default '{}';
alter table public.marketing_campaigns add column if not exists sent_at timestamptz;

create table if not exists public.marketing_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  contact_id uuid not null references public.marketing_contacts(id) on delete cascade,
  email text not null,
  delivery_status text not null default 'queued'
    check (delivery_status in ('queued','sent','failed','skipped','unsubscribed')),
  provider_message_id text,
  error_text text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique(campaign_id,contact_id)
);
create index if not exists marketing_campaign_recipients_idx
  on public.marketing_campaign_recipients(campaign_id,delivery_status);
alter table public.marketing_campaign_recipients enable row level security;
revoke all privileges on table public.marketing_campaign_recipients from anon, authenticated;

create table if not exists public.marketing_regulation_watch (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  jurisdiction text default 'Victoria',
  source_name text,
  source_url text,
  effective_date date,
  affected_segments text[] not null default '{}',
  summary text,
  opportunity_angle text,
  service_category text,
  status text not null default 'watching'
    check (status in ('watching','campaign_ready','actioned','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketing_regulation_watch_idx
  on public.marketing_regulation_watch(status,effective_date);
alter table public.marketing_regulation_watch enable row level security;
revoke all privileges on table public.marketing_regulation_watch from anon, authenticated;

create table if not exists public.marketing_search_targets (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('seo','sem')),
  keyword text not null,
  location text default 'Melbourne VIC',
  intent text,
  landing_page text,
  service_category text,
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  status text not null default 'planned' check (status in ('planned','in_progress','live','paused','complete')),
  monthly_budget_cents integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists marketing_search_targets_idx
  on public.marketing_search_targets(channel,status,priority);
alter table public.marketing_search_targets enable row level security;
revoke all privileges on table public.marketing_search_targets from anon, authenticated;

notify pgrst, 'reload schema';
