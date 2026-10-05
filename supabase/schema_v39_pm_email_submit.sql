-- MySubbies Property & Facilities: one-click PM submission token
ALTER TABLE public.pm_work_orders ADD COLUMN IF NOT EXISTS pm_submit_token_hash TEXT UNIQUE;
ALTER TABLE public.pm_work_orders ADD COLUMN IF NOT EXISTS pm_submit_token_expires_at TIMESTAMPTZ;
ALTER TABLE public.pm_work_orders ADD COLUMN IF NOT EXISTS pm_submit_used_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS pm_work_orders_pm_submit_token_idx ON public.pm_work_orders(pm_submit_token_hash);
