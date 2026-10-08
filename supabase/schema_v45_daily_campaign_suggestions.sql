-- Daily AI marketing campaign suggestions for MySubbies.
alter table public.marketing_campaigns
  add column if not exists ai_generated boolean not null default false;

alter table public.marketing_campaigns
  add column if not exists suggestion_date date;

alter table public.marketing_campaigns
  add column if not exists ai_rationale text;

alter table public.marketing_campaigns
  add column if not exists ai_rank integer;

create index if not exists marketing_campaign_suggestion_date_idx
  on public.marketing_campaigns(suggestion_date, ai_rank)
  where ai_generated = true;

notify pgrst, 'reload schema';
