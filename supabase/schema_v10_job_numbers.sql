-- Sequential, human-facing job numbers (Aug 2026)
--
-- jobs.id has always been the internal `job_<timestamp>_<random>` string
-- generated client-side in booking.html -- unique enough for a primary key,
-- but not something a customer or contractor could read out over the phone
-- or reference in a dispute. This adds a real, DB-generated sequential
-- number for exactly that: "Job #1042", assigned once per job by Postgres
-- itself (via the sequence default below), never by client code.
--
-- Backfill runs in created_at order so existing jobs get numbers matching
-- when they were actually created, not insertion order into this migration.
-- Safe to re-run: the backfill only touches rows still missing a number,
-- and the constraint add is guarded.
create sequence if not exists jobs_job_number_seq;

alter table jobs add column if not exists job_number bigint;

with ordered as (
  select id, row_number() over (order by created_at, id) as rn
  from jobs
  where job_number is null
)
update jobs set job_number = ordered.rn
from ordered
where jobs.id = ordered.id;

select setval('jobs_job_number_seq', coalesce((select max(job_number) from jobs), 0) + 1, false);

alter table jobs alter column job_number set default nextval('jobs_job_number_seq');
alter sequence jobs_job_number_seq owned by jobs.job_number;
alter table jobs alter column job_number set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_job_number_unique') then
    alter table jobs add constraint jobs_job_number_unique unique (job_number);
  end if;
end $$;
