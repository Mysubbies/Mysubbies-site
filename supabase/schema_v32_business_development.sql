-- MySubbies shared Business Development CRM
-- Stores only reviewed business prospects and their source evidence.
create table if not exists public.business_development_prospects (
  id uuid primary key default gen_random_uuid(),
  prospect_type text not null check (prospect_type in ('contractor','property_manager')),
  business_name text not null,
  contact_name text,
  email text,
  phone text,
  website text,
  suburb text,
  state text default 'VIC',
  trade_or_segment text,
  source_provider text not null,
  source_url text not null,
  source_reference text,
  status text not null default 'prospect' check (status in ('prospect','invited','opened','interested','registration_started','registered','under_review','approved','active','declined','archived')),
  invitation_count integer not null default 0,
  last_invited_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists bd_prospects_type_email_uq
  on public.business_development_prospects(prospect_type, lower(email)) where email is not null;
create index if not exists bd_prospects_status_idx
  on public.business_development_prospects(prospect_type, status, updated_at desc);
alter table public.business_development_prospects enable row level security;
revoke all privileges on table public.business_development_prospects from anon, authenticated;

create table if not exists public.business_development_activity (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references public.business_development_prospects(id) on delete cascade,
  prospect_type text not null check (prospect_type in ('contractor','property_manager')),
  event_type text not null,
  outcome text not null default 'success',
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists bd_activity_prospect_idx on public.business_development_activity(prospect_id, created_at desc);
alter table public.business_development_activity enable row level security;
revoke all privileges on table public.business_development_activity from anon, authenticated;
