-- BDM CRM migration: staged, not applied
create extension if not exists pgcrypto;
create table if not exists public.ai_bdm_accounts (
 id uuid primary key default gen_random_uuid(),
 business_name text not null,
 suburb text not null,
 category text not null default 'other',
 service_interest text not null default 'Property maintenance',
 source_url text not null,
 website text,
 contact_email text,
 contact_permission text not null default 'unverified' check (contact_permission in ('unverified','verified')),
 source_type text not null check (source_type in ('direct_enquiry','referral','independently_verified')),
 status text not null default 'new' check (status in ('new','qualified','contacted','interested','quoted','won','lost','suppressed')),
 notes text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index if not exists ai_bdm_accounts_unique on public.ai_bdm_accounts (lower(btrim(business_name)),lower(btrim(suburb)));
create table if not exists public.ai_bdm_approvals (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references public.ai_bdm_accounts(id) on delete cascade,
 subject text not null,
 message text not null,
 status text not null default 'pending' check (status in ('pending','approved','rejected')),
 reviewed_at timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists ai_bdm_approvals_pending on public.ai_bdm_approvals(status,created_at desc);
alter table public.ai_bdm_accounts enable row level security;
alter table public.ai_bdm_approvals enable row level security;
-- No public access policies. Only admin-verified server API uses service role.
