-- Item-level progress invoicing for accepted quotes.
-- Apply once in Supabase SQL editor before enabling item allocation in production.
-- Existing milestone invoices remain valid and unchanged.

create table if not exists invoice_line_allocations (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  quote_id uuid not null references quotes(id),
  quote_version_id uuid not null references quote_versions(id),
  quote_line_key text not null,
  quote_line_description text not null,
  quoted_amount_cents bigint not null check (quoted_amount_cents > 0),
  invoiced_amount_cents bigint not null check (invoiced_amount_cents > 0),
  progress_percentage numeric(7,3),
  created_at timestamptz not null default now(),
  unique (invoice_id, quote_line_key)
);

create index if not exists invoice_line_allocations_quote_idx
  on invoice_line_allocations(quote_id, quote_line_key);

create index if not exists invoice_line_allocations_invoice_idx
  on invoice_line_allocations(invoice_id);

alter table invoice_line_allocations enable row level security;

-- Intentionally no browser RLS policies. Invoice allocation reads/writes must
-- go through authenticated server endpoints using the service role.
