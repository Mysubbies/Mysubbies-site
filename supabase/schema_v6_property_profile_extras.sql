-- Property Profiles Phase 2 (added Aug 2026) -- additive columns only, no new tables.
-- See CLAUDE.md for the full writeup.
--
-- photo_data_url: base64 data URL, same "no real blob storage" pattern already used
-- for job reference photos (job.photoDataUrl(s)) -- accepted tradeoff, not new debt.
--
-- maintenance_preferences: customer-set reminder intervals, keyed by category label.
-- Deliberately customer-provided, not MySubbies-invented -- only Gardening & Lawn
-- Mowing has a real recurring, priced rate-card task today; Plumbing/Electrical/
-- Fencing have no defined interval anywhere and none is invented here. Shape:
-- { "Gardening & Lawn Mowing": { "taskName": "...", "intervalWeeks": 3, "setAt": "..." } }

alter table property_profiles add column if not exists photo_data_url text;
alter table property_profiles add column if not exists maintenance_preferences jsonb not null default '{}'::jsonb;
