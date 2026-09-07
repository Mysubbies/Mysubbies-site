-- Sep 2026: self-service customer preferences, mirroring contractors'
-- full_application jsonb (see api/contractor-profile.js). First use:
-- hiddenJobIds -- the customer-portal "Remove cancelled job" list, which
-- was localStorage-only (mysubbies_customer_hidden_jobs) and so reappeared
-- on any other device/browser or after site data was cleared. See
-- api/customer-profile.js for the read/write endpoint.
alter table customers add column if not exists preferences jsonb not null default '{}'::jsonb;
