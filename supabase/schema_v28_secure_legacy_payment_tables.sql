-- Close the legacy public-table gap reported by Supabase's Security Advisor.
--
-- These tables are accessed only by Vercel API routes through the Supabase
-- service-role client (api/_lib/clients.js). No browser workflow requires
-- direct anon/authenticated access, so RLS can fail closed with no policies.
-- The service_role bypasses RLS and continues to support the existing app.

alter table public.jobs enable row level security;
alter table public.payments enable row level security;
alter table public.contractor_connect_accounts enable row level security;
alter table public.payout_batches enable row level security;
alter table public.payout_line_items enable row level security;

-- Defence in depth: even if a permissive policy is added accidentally later,
-- the browser roles still have no direct table privileges unless a future
-- migration explicitly restores the exact access required.
revoke all privileges on table public.jobs from anon, authenticated;
revoke all privileges on table public.payments from anon, authenticated;
revoke all privileges on table public.contractor_connect_accounts from anon, authenticated;
revoke all privileges on table public.payout_batches from anon, authenticated;
revoke all privileges on table public.payout_line_items from anon, authenticated;
