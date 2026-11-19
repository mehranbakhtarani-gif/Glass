alter table private.glass_devices enable row level security;
alter table private.glass_operations enable row level security;
alter table private.glass_operation_log enable row level security;

create or replace function private.glass_register_device(
  p_id text, p_actor text, p_label text, p_token_hash bytea
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_device private.glass_devices%rowtype;
begin
  if p_id is null or length(p_id) < 12 or p_actor not in ('mehran','ehsan')
     or p_label is null or length(btrim(p_label)) not between 1 and 80
     or p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'Invalid device registration' using errcode = '22023';
  end if;
  insert into private.glass_devices(id, actor, label, token_hash)
  values (p_id, p_actor, btrim(p_label), p_token_hash)
  returning * into v_device;
  return jsonb_build_object('id', v_device.id, 'actor', v_device.actor, 'label', v_device.label);
end;
$function$;

create or replace function private.glass_get_device_by_token_hash(p_token_hash bytea)
returns table(id text, actor text, label text)
language sql security definer set search_path = ''
as $function$
  select d.id, d.actor, d.label from private.glass_devices d
  where d.token_hash = p_token_hash and d.revoked_at is null limit 1;
$function$;

create or replace function private.glass_touch_device(p_device_id text)
returns boolean
language sql security definer set search_path = ''
as $function$
  update private.glass_devices set last_seen_at = pg_catalog.clock_timestamp()
  where id = p_device_id and revoked_at is null returning true;
$function$;

revoke all on function private.glass_register_device(text,text,text,bytea) from public, anon, authenticated;
revoke all on function private.glass_get_device_by_token_hash(bytea) from public, anon, authenticated;
revoke all on function private.glass_touch_device(text) from public, anon, authenticated;
grant execute on function private.glass_register_device(text,text,text,bytea) to service_role;
grant execute on function private.glass_get_device_by_token_hash(bytea) to service_role;
grant execute on function private.glass_touch_device(text) to service_role;
