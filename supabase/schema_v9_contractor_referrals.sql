-- Contractor-to-contractor referrals get real columns (added Aug 2026)
--
-- referral_code/referred_by have existed since day one on the contractor
-- application record, but only ever lived buried inside
-- contractors.full_application jsonb (mirrored there by
-- api/sync-applications.js) -- unqueryable for any admin reporting.
-- Real columns make this data actually usable.
--
-- No reward/bonus/commission logic accompanies this -- founder confirmed
-- this is tracking + sharing only, not an incentive program.
--
-- No unique constraint on referral_code: the app-level uniqueness check
-- (does this code match any existing application/contractor) already
-- governs new-code collisions, same as the parallel customer referral
-- system, which has no DB-level uniqueness either. Adding one here risks
-- the backfill below failing outright if any accumulated test data
-- happens to share a code (business-name-prefix + random 4 digits).
alter table contractors add column if not exists referral_code text;
alter table contractors add column if not exists referred_by text;

-- Backfill from the existing buried JSON so pre-existing signups aren't
-- orphaned once the real columns become the source of truth going forward.
update contractors set referral_code = full_application->>'referralCode'
  where referral_code is null and full_application->>'referralCode' is not null;
update contractors set referred_by = full_application->>'referredBy'
  where referred_by is null and full_application->>'referredBy' is not null;
