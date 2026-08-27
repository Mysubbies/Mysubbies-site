-- Admin -> contractor messaging (added Aug 2026)
--
-- Lets admin message one or many approved contractors from the Applications
-- tab (multi-select), optionally with a file attachment (e.g. an updated
-- rate card). This is deliberately separate from the existing per-job
-- internalMessages thread (job.internalMessages in mysubbies-admin-portal.html/
-- mysubbies-contractor-portal.html) -- that's a job-scoped conversation;
-- this is a standalone admin-to-panel channel with no job involved at all.
--
-- One row per (message, recipient) rather than a single row + a recipients
-- array, so read/unread state is naturally per-contractor and a broadcast
-- to N contractors is just N rows sharing the same body/attachment.
--
-- attachment_data_url: base64 data URL, same "no real blob storage" pattern
-- already used for job photos and application documents -- accepted
-- tradeoff, not new debt. Client-side enforces a size cap before sending
-- (same lesson as the Aug 2026 Fix Something photo-upload fix: an
-- uncompressed file can silently exceed Vercel's request-body limit).
--
-- All access goes through api/admin-messages.js using the service-role
-- key -- RLS is enabled with no policies, so the publishable/anon key
-- (used client-side in mysubbies-contractor-portal.html) has no direct
-- access at all, matching the pattern in schema_v5.

create table if not exists admin_contractor_messages (
  id uuid primary key default gen_random_uuid(),
  contractor_email text not null,
  subject text,
  body text not null,
  attachment_data_url text,
  attachment_filename text,
  attachment_mime text,
  sent_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists admin_contractor_messages_contractor_email_idx on admin_contractor_messages(contractor_email);

alter table admin_contractor_messages enable row level security;
