-- Public campaign service requests for offers that are not yet fixed-price rate-card services.
create table if not exists public.marketing_service_requests (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.marketing_campaigns(id) on delete set null,
  campaign_name text,
  requested_service text not null,
  business_name text,
  contact_name text,
  email text not null,
  phone text,
  suburb text,
  property_address text,
  scope text,
  source_url text,
  status text not null default 'new'
    check (status in ('new','reviewing','quoted','converted','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_service_requests_status_idx
  on public.marketing_service_requests(status,created_at desc);

alter table public.marketing_service_requests enable row level security;
revoke all privileges on table public.marketing_service_requests from anon, authenticated;

notify pgrst, 'reload schema';
