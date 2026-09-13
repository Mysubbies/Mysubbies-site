-- Admin CRM customer profile updates. The database changes are kept in one
-- transaction so changing a login email cannot leave jobs/credits pointing at
-- the old address. Issued quote snapshots are deliberately immutable.
create or replace function admin_update_customer_profile(
  p_customer_id uuid,
  p_name text,
  p_phone text,
  p_email text
)
returns table (id uuid, email text, name text, phone text, status text, created_at timestamptz)
language plpgsql
security invoker
as $$
declare
  old_email text;
begin
  select c.email into old_email from customers c where c.id = p_customer_id for update;
  if old_email is null then raise exception 'Customer not found'; end if;

  update jobs
     set customer_email = lower(p_email),
         full_record = case when full_record is null then full_record else
           jsonb_set(jsonb_set(jsonb_set(full_record, '{customerEmail}', to_jsonb(lower(p_email)), true),
             '{customerName}', to_jsonb(p_name), true), '{customerPhone}', to_jsonb(coalesce(p_phone, '')), true) end
   where customer_id = p_customer_id or lower(customer_email) = lower(old_email);

  update customer_credits set customer_email = lower(p_email)
   where lower(customer_email) = lower(old_email);

  update customers c set email = lower(p_email), name = p_name, phone = p_phone
   where c.id = p_customer_id;

  return query select c.id, c.email, c.name, c.phone, c.status, c.created_at
    from customers c where c.id = p_customer_id;
end;
$$;

revoke all on function admin_update_customer_profile(uuid, text, text, text) from public;
revoke all on function admin_update_customer_profile(uuid, text, text, text) from anon;
revoke all on function admin_update_customer_profile(uuid, text, text, text) from authenticated;
grant execute on function admin_update_customer_profile(uuid, text, text, text) to service_role;
