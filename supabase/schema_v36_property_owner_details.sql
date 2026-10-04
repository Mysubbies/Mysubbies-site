-- MySubbies Property & Facilities enhancements
-- Property owner/contact details for PM-managed properties.

alter table public.pm_properties add column if not exists owner_name text;
alter table public.pm_properties add column if not exists owner_email text;
alter table public.pm_properties add column if not exists owner_phone text;

create index if not exists pm_properties_owner_email_idx on public.pm_properties(lower(owner_email));
