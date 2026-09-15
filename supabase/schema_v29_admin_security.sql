-- Persistent brute-force protection for the shared admin login while the
-- portal is migrated to named Supabase Auth administrators with MFA.
create table if not exists public.admin_login_attempts (
  id uuid primary key default gen_random_uuid(),
  client_fingerprint text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists admin_login_attempts_fingerprint_time_idx
  on public.admin_login_attempts(client_fingerprint, attempted_at desc);

alter table public.admin_login_attempts enable row level security;
revoke all privileges on table public.admin_login_attempts from anon, authenticated;
