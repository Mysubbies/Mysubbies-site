-- Structured contractor base locations power the internal coverage map.
-- Exact addresses remain admin-only; public/contractor matching should use
-- suburb/postcode or suitably reduced coordinates.
alter table contractors add column if not exists address_place_id text;
alter table contractors add column if not exists address_formatted text;
alter table contractors add column if not exists address_suburb text;
alter table contractors add column if not exists address_state text;
alter table contractors add column if not exists address_postcode text;
alter table contractors add column if not exists address_latitude double precision;
alter table contractors add column if not exists address_longitude double precision;
alter table contractors add column if not exists address_verified boolean not null default false;

create index if not exists contractors_address_suburb_idx on contractors(address_suburb);
create index if not exists contractors_address_postcode_idx on contractors(address_postcode);
