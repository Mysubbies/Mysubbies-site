-- Contractor signup (Sept 2026) -- captures the contractor's own business
-- address at application time (api/sync-applications.js now writes it),
-- shown to admin in the Applications tab review card.
alter table contractors add column if not exists address text;
