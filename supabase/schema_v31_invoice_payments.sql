-- Auditable invoice payment receipts. Apply once after schema_v30.
-- Payment totals and invoice status are updated atomically in PostgreSQL.

alter table invoices drop constraint if exists invoices_status_check;
alter table invoices add constraint invoices_status_check
  check (status in ('draft','issued','sent','part_paid','paid','void'));

create table if not exists invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id),
  amount_cents bigint not null check (amount_cents > 0),
  received_at timestamptz not null,
  payment_method text not null check (payment_method in ('bank_transfer','card','cash','finance','other')),
  payment_reference text,
  notes text,
  recorded_by text not null default 'admin',
  created_at timestamptz not null default now()
);
create index if not exists invoice_payments_invoice_idx on invoice_payments(invoice_id, received_at, created_at);
alter table invoice_payments enable row level security;

create or replace function record_invoice_payment(
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_received_at timestamptz,
  p_payment_method text,
  p_payment_reference text default null,
  p_notes text default null,
  p_recorded_by text default 'admin'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_paid bigint;
  v_payment_id uuid;
  v_new_total bigint;
begin
  select * into v_invoice from invoices where id = p_invoice_id for update;
  if not found or v_invoice.status = 'void' then raise exception 'Invoice not found or void'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Payment amount must be greater than zero'; end if;
  if p_payment_method not in ('bank_transfer','card','cash','finance','other') then raise exception 'Invalid payment method'; end if;

  select coalesce(sum(amount_cents), 0) into v_paid from invoice_payments where invoice_id = p_invoice_id;
  v_new_total := v_paid + p_amount_cents;
  if v_new_total > v_invoice.total_inc_gst_cents then raise exception 'Payment exceeds invoice balance'; end if;

  insert into invoice_payments(invoice_id, amount_cents, received_at, payment_method, payment_reference, notes, recorded_by)
  values (p_invoice_id, p_amount_cents, p_received_at, p_payment_method,
    nullif(trim(p_payment_reference), ''), nullif(trim(p_notes), ''), coalesce(nullif(trim(p_recorded_by), ''), 'admin'))
  returning id into v_payment_id;

  update invoices set
    status = case when v_new_total = total_inc_gst_cents then 'paid' else 'part_paid' end,
    paid_at = case when v_new_total = total_inc_gst_cents then p_received_at else null end,
    updated_at = now()
  where id = p_invoice_id;

  return v_payment_id;
end;
$$;

revoke all on function record_invoice_payment(uuid,bigint,timestamptz,text,text,text,text) from public, anon, authenticated;
grant execute on function record_invoice_payment(uuid,bigint,timestamptz,text,text,text,text) to service_role;
