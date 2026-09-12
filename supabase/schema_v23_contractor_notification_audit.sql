-- Delivery-safe audit metadata for contractor lifecycle notifications.
-- Existing notification consumers ignore these additive columns.
alter table notifications add column if not exists application_ref text;
alter table notifications add column if not exists delivery_channels text[] not null default '{in_app}';
alter table notifications add column if not exists delivery_status jsonb not null default '{"in_app":"created"}'::jsonb;
alter table notifications add column if not exists metadata jsonb not null default '{}'::jsonb;
create index if not exists notifications_application_ref_idx on notifications(application_ref, created_at desc);
create index if not exists notifications_event_type_idx on notifications(event_type, created_at desc);
