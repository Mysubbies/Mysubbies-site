-- MySubbies AI Workforce Phase 1: staging migration (NOT APPLIED)
-- Run only after reviewing existing schema and RLS.
create extension if not exists pgcrypto;
create table if not exists public.ai_prospects (
 id uuid primary key default gen_random_uuid(),
 business_name text not null,
 category text not null,
 suburb text not null,
 website text,
 phone text,
 public_email text,
 source_url text not null,
 provider text not null,
 provider_place_id text,
 status text not null default 'new' check (status in ('new','reviewed','qualified','contacted','replied','won','lost','suppressed')),
 discovered_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index if not exists ai_prospects_provider_unique on public.ai_prospects(provider,provider_place_id) where provider_place_id is not null;
create index if not exists ai_prospects_suburb_category_idx on public.ai_prospects(suburb,category);
create table if not exists public.ai_discovery_runs (
 id uuid primary key default gen_random_uuid(),
 suburb text not null,
 category text not null,
 status text not null default 'queued' check(status in ('queued','running','completed','failed')),
 discovered_count integer not null default 0,
 new_count integer not null default 0,
 error_message text,
 created_at timestamptz not null default now(),
 finished_at timestamptz
);
create table if not exists public.ai_outreach_drafts (
 id uuid primary key default gen_random_uuid(),
 prospect_id uuid not null references public.ai_prospects(id) on delete cascade,
 subject text not null,
 body text not null,
 status text not null default 'pending_review' check(status in ('pending_review','approved','rejected','sent')),
 approved_at timestamptz,
 sent_at timestamptz,
 created_at timestamptz not null default now()
);
create table if not exists public.ai_agent_runs (
 id uuid primary key default gen_random_uuid(),
 agent_name text not null,
 status text not null check(status in ('running','completed','failed')),
 metrics jsonb not null default '{}'::jsonb,
 error_message text,
 created_at timestamptz not null default now(),
 finished_at timestamptz
);
alter table public.ai_prospects enable row level security;
alter table public.ai_discovery_runs enable row level security;
alter table public.ai_outreach_drafts enable row level security;
alter table public.ai_agent_runs enable row level security;
-- No anon/authenticated policies: deny client-side access by default.
-- Server-side service role access must require independently authenticated admin API endpoints.
