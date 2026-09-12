-- MySubbies small-job payment rules — v25 (Sep 2026)
--
-- Small home-service categories use the approved built-in simple_service
-- schedule: 10% booking deposit and 90% on job completion. Without an
-- explicit category rule the backend deliberately falls back to
-- manual_review, which caused ordinary $180 Cleaning bookings to show a
-- deposit-only "large or complex project" schedule.

insert into category_payment_rules (category, schedule_type, default_template_id, allow_job_override, updated_by, updated_at)
values
  ('Cleaning', 'simple_service', null, true, 'schema_v25', now()),
  ('Handyman', 'simple_service', null, true, 'schema_v25', now()),
  ('Gardening', 'simple_service', null, true, 'schema_v25', now())
on conflict (category) do update
set schedule_type = excluded.schedule_type,
    default_template_id = excluded.default_template_id,
    allow_job_override = excluded.allow_job_override,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
