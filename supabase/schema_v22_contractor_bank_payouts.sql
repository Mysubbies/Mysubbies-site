-- Contractor payouts are administered by MySubbies using bank details held
-- in the service-role-only contractors table. Stripe Connect columns/tables
-- remain untouched for backwards compatibility but are legacy/unused.
alter table contractors add column if not exists payout_account_name text;
alter table contractors add column if not exists payout_bsb text;
alter table contractors add column if not exists payout_account_number text;
alter table contractors add column if not exists payout_bank_name text;
alter table contractors add column if not exists payout_details_confirmed boolean not null default false;
alter table contractors add column if not exists payout_details_updated_at timestamptz;

alter table contractors drop constraint if exists contractors_payout_bsb_check;
alter table contractors add constraint contractors_payout_bsb_check
  check (payout_bsb is null or payout_bsb ~ '^[0-9]{6}$');
alter table contractors drop constraint if exists contractors_payout_account_number_check;
alter table contractors add constraint contractors_payout_account_number_check
  check (payout_account_number is null or payout_account_number ~ '^[0-9]{6,10}$');
