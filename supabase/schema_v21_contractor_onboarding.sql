-- Auditable contractor consent and protected second-step document uploads.
alter table contractors add column if not exists agreement_accepted boolean not null default false;
alter table contractors add column if not exists agreement_accepted_at timestamptz;
alter table contractors add column if not exists agreement_version text;
alter table contractors add column if not exists application_update_token_hash text;
alter table contractors add column if not exists application_update_token_expires_at timestamptz;
alter table contractors add column if not exists application_review_notes text;
alter table contractors add column if not exists licence_reminder_sent_at timestamptz;
alter table contractors add column if not exists insurance_reminder_sent_at timestamptz;
create unique index if not exists contractors_abn_unique_idx on contractors (abn) where abn is not null;
create unique index if not exists job_offers_job_contractor_idx on job_offers (job_id, contractor_id);

-- Prevent self-service contractor profile updates (including the broad
-- full_application JSON object) from being used to alter review state.
drop policy if exists "contractors can update own row" on contractors;

create table if not exists contractor_signup_attempts (
  id uuid primary key default gen_random_uuid(),
  client_fingerprint text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists contractor_signup_attempts_rate_idx
  on contractor_signup_attempts (client_fingerprint, attempted_at desc);
alter table contractor_signup_attempts enable row level security;

-- Sensitive onboarding documents live in a private bucket. There are no
-- storage-object policies: only the service-role onboarding/Admin APIs can
-- upload or mint five-minute signed download URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contractor-documents', 'contractor-documents', false, 5242880,
  array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = 5242880,
  allowed_mime_types = excluded.allowed_mime_types;
