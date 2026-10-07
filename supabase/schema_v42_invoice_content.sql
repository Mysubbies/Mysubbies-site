-- Standalone invoice content fields.
-- Apply once in Supabase SQL editor after schema_v31_invoice_payments.sql.

alter table invoices add column if not exists scope_text text;
alter table invoices add column if not exists inclusions_text text;
alter table invoices add column if not exists exclusions_text text;
alter table invoices add column if not exists payment_terms_text text;

notify pgrst, 'reload schema';
