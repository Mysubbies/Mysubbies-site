-- MySubbies Property & Facilities: owner quote approval workflow
alter table public.pm_work_orders add column if not exists owner_approval_status text not null default 'not_requested'
  check (owner_approval_status in ('not_requested','pending','approved','declined'));
alter table public.pm_work_orders add column if not exists owner_approval_token_hash text unique;
alter table public.pm_work_orders add column if not exists owner_approval_expires_at timestamptz;
alter table public.pm_work_orders add column if not exists owner_approved_at timestamptz;
alter table public.pm_work_orders add column if not exists owner_approved_by_email text;
create index if not exists pm_work_orders_owner_token_idx on public.pm_work_orders(owner_approval_token_hash);
