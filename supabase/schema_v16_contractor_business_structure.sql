-- Contractor signup redesign (Sept 2026, "Founding 100" program) --
-- removes the earlier company-only restriction, so applicants now record
-- which business structure they operate under. ACN stays nullable (it
-- already was) since only a Company-structure applicant provides one.
alter table contractors add column if not exists business_structure text
  check (business_structure in ('sole_trader', 'partnership', 'company'));

-- acn was already nullable in schema_v2_marketplace.sql -- no change needed
-- there, just documenting: a sole trader / partnership row will now
-- legitimately have acn = null, where previously every row had one.
