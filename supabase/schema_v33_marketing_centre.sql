-- MySubbies Marketing Centre
create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  campaign_type text not null default 'seasonal',
  offer text,
  audience text,
  service_category text,
  headline text,
  body_copy text,
  facebook_copy text,
  instagram_copy text,
  whatsapp_copy text,
  call_to_action text,
  hashtags text,
  booking_url text,
  image_url text,
  tracking_code text,
  status text not null default 'draft' check (status in ('draft','ready_for_review','approved','scheduled','published','archived')),
  scheduled_for timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists marketing_campaign_tracking_uq on public.marketing_campaigns(tracking_code) where tracking_code is not null;
create index if not exists marketing_campaign_status_idx on public.marketing_campaigns(status, updated_at desc);
alter table public.marketing_campaigns enable row level security;
revoke all privileges on table public.marketing_campaigns from anon, authenticated;

create table if not exists public.marketing_campaign_activity (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.marketing_campaigns(id) on delete cascade,
  event_type text not null,
  detail text,
  created_at timestamptz not null default now()
);
alter table public.marketing_campaign_activity enable row level security;
revoke all privileges on table public.marketing_campaign_activity from anon, authenticated;
