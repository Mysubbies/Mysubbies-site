-- Fix: allow Property & Facilities jobs in the live jobs table.
-- The production database currently has an older jobs_source_check constraint.

ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_source_check;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_source_check
  CHECK (
    source IN (
      'browse',
      'fix_something',
      'search',
      'property_management'
    )
  );
