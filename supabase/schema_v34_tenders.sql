-- MySubbies Tenders & Contracts workspace
create table if not exists public.tenders (
 id uuid primary key default gen_random_uuid(),
 title text not null, issuer text, reference_number text, source_url text,
 tender_type text, location text, closes_at timestamptz,
 status text not null default 'reviewing' check(status in ('reviewing','go','no_go','drafting','pricing','compliance_review','approved','submitted','won','lost','archived')),
 summary text, scope text, mandatory_requirements text, exclusions text,
 response_draft text, assumptions text, final_review_notes text,
 labour_cents bigint not null default 0, materials_cents bigint not null default 0,
 equipment_cents bigint not null default 0, subcontractors_cents bigint not null default 0,
 preliminaries_cents bigint not null default 0, overhead_cents bigint not null default 0,
 contingency_cents bigint not null default 0, margin_percent numeric(7,3) not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists tenders_status_close_idx on public.tenders(status,closes_at);
alter table public.tenders enable row level security;
revoke all privileges on table public.tenders from anon, authenticated;

create table if not exists public.tender_compliance_items (
 id uuid primary key default gen_random_uuid(), tender_id uuid not null references public.tenders(id) on delete cascade,
 requirement text not null, mandatory boolean not null default true,
 status text not null default 'pending' check(status in ('pending','confirmed','gap','not_applicable')),
 evidence text, notes text, created_at timestamptz not null default now()
);
alter table public.tender_compliance_items enable row level security;
revoke all privileges on table public.tender_compliance_items from anon, authenticated;
