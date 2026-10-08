-- Daily AI campaign suggestions for Marketing Centre.
alter table public.marketing_campaigns
  add column if not exists ai_generated boolean not null default false;

alter table public.marketing_campaigns
  add column if not exists suggestion_date date;

alter table public.marketing_campaigns
  add column if not exists suggestion_rank integer;

alter table public.marketing_campaigns
  add column if not exists ai_rationale text;

create unique index if not exists marketing_campaign_daily_ai_rank_uq
  on public.marketing_campaigns(suggestion_date, suggestion_rank)
  where ai_generated = true and suggestion_date is not null and suggestion_rank is not null;

notify pgrst, 'reload schema';
