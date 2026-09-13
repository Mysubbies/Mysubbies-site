-- Verified customer property/contact address for CRM use. Issued quote and
-- invoice snapshots remain unchanged when this profile address is edited.
alter table customers add column if not exists address_place_id text;
alter table customers add column if not exists address_formatted text;
alter table customers add column if not exists address_suburb text;
alter table customers add column if not exists address_state text;
alter table customers add column if not exists address_postcode text;
alter table customers add column if not exists address_latitude double precision;
alter table customers add column if not exists address_longitude double precision;
alter table customers add column if not exists address_verified boolean not null default false;

create index if not exists customers_address_suburb_idx on customers(address_suburb);
create index if not exists customers_address_postcode_idx on customers(address_postcode);

create or replace function admin_update_customer_profile_v2(
  p_customer_id uuid, p_name text, p_phone text, p_email text,
  p_address_place_id text, p_address_formatted text, p_address_suburb text,
  p_address_state text, p_address_postcode text,
  p_address_latitude double precision, p_address_longitude double precision,
  p_address_verified boolean
)
returns table (
  id uuid, email text, name text, phone text, status text, created_at timestamptz,
  address_place_id text, address_formatted text, address_suburb text,
  address_state text, address_postcode text, address_latitude double precision,
  address_longitude double precision, address_verified boolean
)
language plpgsql
security invoker
as $$
declare old_email text;
begin
  select c.email into old_email from customers c where c.id = p_customer_id for update;
  if old_email is null then raise exception 'Customer not found'; end if;

  update jobs set customer_email = lower(p_email),
    full_record = case when full_record is null then full_record else
      jsonb_set(jsonb_set(jsonb_set(full_record, '{customerEmail}', to_jsonb(lower(p_email)), true),
        '{customerName}', to_jsonb(p_name), true), '{customerPhone}', to_jsonb(coalesce(p_phone, '')), true) end
    where customer_id = p_customer_id or lower(customer_email) = lower(old_email);
  update customer_credits set customer_email = lower(p_email) where lower(customer_email) = lower(old_email);

  update customers c set email = lower(p_email), name = p_name, phone = p_phone,
    address_place_id = coalesce(p_address_place_id, c.address_place_id),
    address_formatted = coalesce(p_address_formatted, c.address_formatted),
    address_suburb = coalesce(p_address_suburb, c.address_suburb),
    address_state = coalesce(p_address_state, c.address_state),
    address_postcode = coalesce(p_address_postcode, c.address_postcode),
    address_latitude = coalesce(p_address_latitude, c.address_latitude),
    address_longitude = coalesce(p_address_longitude, c.address_longitude),
    address_verified = case when p_address_formatted is null then c.address_verified else p_address_verified end
    where c.id = p_customer_id;

  return query select c.id, c.email, c.name, c.phone, c.status, c.created_at,
    c.address_place_id, c.address_formatted, c.address_suburb, c.address_state,
    c.address_postcode, c.address_latitude, c.address_longitude, c.address_verified
    from customers c where c.id = p_customer_id;
end;
$$;

revoke all on function admin_update_customer_profile_v2(uuid,text,text,text,text,text,text,text,text,double precision,double precision,boolean) from public, anon, authenticated;
grant execute on function admin_update_customer_profile_v2(uuid,text,text,text,text,text,text,text,text,double precision,double precision,boolean) to service_role;
