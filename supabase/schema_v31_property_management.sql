-- MySubbies Property & Facilities Management MVP
-- Adds organisation accounts, multi-property work orders, approvals, recurring-maintenance metadata
-- and private work-order attachments. All access is server-mediated; direct anon/authenticated
-- table access is revoked so contractor/customer portals cannot enumerate commercial data.

create table if not exists public.pm_organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  organisation_type text not null default 'property_manager'
    check (organisation_type in ('property_manager','strata','real_estate','commercial','facilities','other')),
  status text not null default 'active' check (status in ('active','paused','closed')),
  billing_email text,
  approval_required boolean not null default true,
  approval_limit_cents bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pm_members (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.pm_organisations(id) on delete cascade,
  auth_user_id uuid unique,
  email text not null,
  name text,
  phone text,
  role text not null default 'requester' check (role in ('org_admin','approver','requester','viewer')),
  can_approve boolean not null default false,
  status text not null default 'invited' check (status in ('invited','active','disabled')),
  created_at timestamptz not null default now(),
  activated_at timestamptz
);
create unique index if not exists pm_members_org_email_uq on public.pm_members(organisation_id, lower(email));
create index if not exists pm_members_auth_user_idx on public.pm_members(auth_user_id);

create table if not exists public.pm_properties (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.pm_organisations(id) on delete cascade,
  name text,
  address text not null,
  suburb text,
  state text not null default 'VIC',
  postcode text,
  place_id text,
  latitude double precision,
  longitude double precision,
  access_notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pm_properties_org_idx on public.pm_properties(organisation_id);

create table if not exists public.pm_work_orders (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.pm_organisations(id) on delete cascade,
  property_id uuid not null references public.pm_properties(id),
  requested_by_member_id uuid not null references public.pm_members(id),
  approved_by_member_id uuid references public.pm_members(id),
  job_id text references public.jobs(id) on delete set null,
  service_mode text not null default 'instant_price' check (service_mode in ('instant_price','project_quote')),
  category text,
  task_summary text not null,
  description text,
  priority text not null default 'normal' check (priority in ('low','normal','urgent','emergency')),
  requested_completion_date date,
  recurring boolean not null default false,
  recurrence_rule text,
  approval_required boolean not null default true,
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','rejected','not_required')),
  status text not null default 'submitted'
    check (status in ('draft','submitted','awaiting_approval','approved','quote_required','ready_to_release','released','assigned','in_progress','completed','cancelled')),
  approved_at timestamptz,
  quoted_price_cents bigint,
  quote_reference text,
  contractor_status text,
  contractor_eta timestamptz,
  completion_notes text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pm_work_orders_org_idx on public.pm_work_orders(organisation_id, created_at desc);
create index if not exists pm_work_orders_property_idx on public.pm_work_orders(property_id, created_at desc);
create index if not exists pm_work_orders_job_idx on public.pm_work_orders(job_id);

create table if not exists public.pm_work_order_files (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.pm_work_orders(id) on delete cascade,
  uploaded_by_member_id uuid references public.pm_members(id),
  file_kind text not null default 'request_photo' check (file_kind in ('request_photo','completion_photo','document')),
  original_name text not null,
  storage_path text not null unique,
  mime text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists pm_work_order_files_order_idx on public.pm_work_order_files(work_order_id);

create table if not exists public.pm_work_order_events (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.pm_work_orders(id) on delete cascade,
  actor_type text not null check (actor_type in ('member','admin','contractor','system')),
  actor_id text,
  event_type text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pm_work_order_events_order_idx on public.pm_work_order_events(work_order_id, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('property-work-orders', 'property-work-orders', false, 5242880, array['image/jpeg','image/png','application/pdf'])
on conflict (id) do nothing;

alter table public.pm_organisations enable row level security;
alter table public.pm_members enable row level security;
alter table public.pm_properties enable row level security;
alter table public.pm_work_orders enable row level security;
alter table public.pm_work_order_files enable row level security;
alter table public.pm_work_order_events enable row level security;

revoke all privileges on table public.pm_organisations from anon, authenticated;
revoke all privileges on table public.pm_members from anon, authenticated;
revoke all privileges on table public.pm_properties from anon, authenticated;
revoke all privileges on table public.pm_work_orders from anon, authenticated;
revoke all privileges on table public.pm_work_order_files from anon, authenticated;
revoke all privileges on table public.pm_work_order_events from anon, authenticated;


-- Bridge fields kept additive so existing residential jobs continue unchanged.
-- A property-management job can be identified without overloading customer ownership.
alter table public.jobs drop constraint if exists jobs_source_check;
alter table public.jobs add constraint jobs_source_check
  check (source in ('browse','fix_something','search','property_management'));

alter table public.pm_work_orders add column if not exists invoice_reference text;
alter table public.pm_work_orders add column if not exists invoice_status text not null default 'not_issued'
  check (invoice_status in ('not_issued','issued','paid','void'));
alter table public.pm_work_orders add column if not exists invoice_amount_cents bigint;

alter table public.pm_work_orders add column if not exists legal_review_status text not null default 'not_required'
  check (legal_review_status in ('not_required','pending','cleared'));
