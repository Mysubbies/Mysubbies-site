-- Launch-safe customer funnel leads. Records are service-role only: the
-- browser cannot read or write this table, and capture occurs only after an
-- authenticated customer voluntarily supplies contact details.
create table if not exists customer_leads (
  id uuid primary key default gen_random_uuid(),
  booking_job_id text unique,
  customer_id uuid references customers(id),
  name text,
  email text not null,
  mobile text,
  requested_service text,
  suburb text,
  source text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  landing_page text,
  stage text not null default 'NEW'
    check (stage in ('NEW','PRICE_STARTED','PRICE_COMPLETED','QUOTE_REQUESTED','BOOKING_STARTED','BOOKED','LOST')),
  booking_status text,
  quote_status text,
  marketing_consent boolean not null default false,
  marketing_consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_leads_stage_created_idx on customer_leads(stage, created_at desc);
alter table customer_leads enable row level security;

create table if not exists customer_lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references customer_leads(id),
  stage text not null check (stage in ('NEW','PRICE_STARTED','PRICE_COMPLETED','QUOTE_REQUESTED','BOOKING_STARTED','BOOKED','LOST')),
  occurred_at timestamptz not null default now(),
  unique (lead_id, stage)
);
create index if not exists customer_lead_events_lead_time_idx on customer_lead_events(lead_id, occurred_at);
alter table customer_lead_events enable row level security;
