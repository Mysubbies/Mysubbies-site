-- MySubbies Property & Facilities: PM handoff to MySubbies operations
ALTER TABLE public.pm_work_orders DROP CONSTRAINT IF EXISTS pm_work_orders_status_check;
ALTER TABLE public.pm_work_orders ADD CONSTRAINT pm_work_orders_status_check
  CHECK (status IN ('draft','submitted','awaiting_approval','approved','quote_required','ready_to_release','submitted_to_mysubbies','released','assigned','in_progress','completed','cancelled'));
