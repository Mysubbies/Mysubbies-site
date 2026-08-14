-- Additive migration, same convention as schema_v2/v3: run in the Supabase
-- SQL editor. Adds account-level activation status for customers.
--
-- Contractors already have this (contractors.status supports 'suspended',
-- and contractor-portal.html's doLogin() already refuses portal access to
-- suspended/rejected accounts) -- this migration brings customers up to the
-- same capability, since `customers` had no status column at all.
--
-- 'deactivated' is checked explicitly in mysubbies-customer-portal.html's
-- doLogin() and mysubbies-booking.html's submitBooking() login branch,
-- BEFORE any password/session is treated as granting access -- mirroring
-- exactly how the contractor status gate already works. This does not rely
-- on Supabase Auth banning; it's a plain app-level check against this
-- column, so it applies regardless of which login path (real Supabase Auth,
-- or the local-cache self-heal fallback) succeeded.

alter table customers add column if not exists status text not null default 'active'
  check (status in ('active', 'deactivated'));
