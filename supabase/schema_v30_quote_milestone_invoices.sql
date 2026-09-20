-- Accepted quote milestone invoicing. Apply once in the Supabase SQL editor.
-- Service-role only: RLS is enabled with no browser policies.
create sequence if not exists invoices_invoice_number_seq start 1001;

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number bigint not null unique default nextval('invoices_invoice_number_seq'),
  quote_id uuid not null references quotes(id),
  quote_version_id uuid not null references quote_versions(id),
  issuing_entity_id uuid not null references issuing_entities(id),
  status text not null default 'draft' check (status in ('draft','issued','sent','paid','void')),
  milestone_key text not null,
  milestone_label text not null,
  milestone_percentage numeric(7,3),
  customer_snapshot jsonb not null default '{}'::jsonb,
  property_snapshot jsonb,
  description text not null,
  subtotal_ex_gst_cents bigint not null,
  gst_cents bigint not null,
  total_inc_gst_cents bigint not null check (total_inc_gst_cents > 0),
  bank_account_name text not null,
  bank_bsb text not null,
  bank_account_number text not null,
  issued_at timestamptz not null default now(),
  due_at timestamptz not null,
  sent_at timestamptz,
  paid_at timestamptz,
  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quote_id, milestone_key)
);
create index if not exists invoices_quote_idx on invoices(quote_id, created_at);
alter table invoices enable row level security;

alter table document_access_tokens drop constraint if exists document_access_tokens_document_type_check;
alter table document_access_tokens add constraint document_access_tokens_document_type_check
  check (document_type in ('quote_version','invoice'));
