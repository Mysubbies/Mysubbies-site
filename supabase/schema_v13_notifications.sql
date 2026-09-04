-- Real, persistent, cross-device notification center (added Sep 2026).
-- Replaces the old "desktop Notification while this tab happens to be
-- open" mechanism (checkForNewMessages() in each portal, still kept for
-- its own instant-while-open alerting) with an actual inbox: a bell icon
-- + panel in each portal, backed by this table, so a notification is
-- still there the next time anyone opens the app on any device.
--
-- No FK on link_job_id -- every event that writes here fires from a
-- client-side call right after saveJobs()/sync-jobs.js has already run,
-- so the job row exists by the time this insert happens, but staying
-- FK-free keeps this table simple and matches the file's job column
-- being a plain text id like jobs.id, not a foreign key relationship
-- this table needs to enforce.
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_role text not null check (recipient_role in ('customer', 'contractor', 'admin')),
  recipient_email text,
  event_type text not null,
  title text not null,
  body text not null,
  link_job_id text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists notifications_recipient_idx on notifications(recipient_role, recipient_email, read_at);
create index if not exists notifications_created_at_idx on notifications(created_at desc);

alter table notifications enable row level security;
-- No policies -- service-role only (api/notifications.js, api/notify.js),
-- same posture as every other table this project's backend owns exclusively.
