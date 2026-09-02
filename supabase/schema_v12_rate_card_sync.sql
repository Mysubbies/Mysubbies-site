-- Rate card server sync (Aug 2026)
--
-- The rate card (21 categories, ~163 tasks) has always lived only in each
-- browser's own localStorage['mysubbies_ratecard'] -- a documented gap
-- (see CLAUDE.md's "Phase 2 -- Rate card -> Supabase"). Concretely this
-- meant: when admin adjusted a price, disabled ("held") a task, or removed
-- one via the admin Rate Card tab, that change only ever updated admin's
-- own browser. No customer's browser ever saw it, since there was no
-- server copy to fetch. This table is the fix -- one authoritative copy,
-- pushed by admin, pulled by every visitor's estimator on load.
--
-- Single-row settings table, same convention as payment_schedule_config
-- (schema_v3_payment_schedules.sql) -- the admin Rate Card tab always
-- reads/writes the whole 21-category structure as one unit (upload CSV
-- replaces all of it, bulk % update touches all of it), so a single jsonb
-- blob matches the real access pattern rather than a normalized schema.
create table if not exists platform_rate_card (
  id boolean primary key default true check (id),
  categories jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table platform_rate_card enable row level security;
-- No policies added (service-role only via api/rate-card.js), same posture
-- as every other table added this session.
