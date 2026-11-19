create or replace function private.glass_register_device(
  p_id text, p_actor text, p_label text, p_token_hash bytea
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_device private.glass_devices%rowtype; v_count integer; v_limit integer;
begin
  if p_id is null or length(p_id) < 12 or p_actor not in ('mehran','ehsan')
     or p_label is null or length(btrim(p_label)) not between 1 and 80
     or p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'Invalid device registration' using errcode = '22023';
  end if;
  v_limit := case when p_actor = 'mehran' then 1 else 2 end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('glass-device-actor:' || p_actor, 0));
  select count(*) into v_count from private.glass_devices
  where actor = p_actor and revoked_at is null;
  if v_count >= v_limit then
    raise exception 'Active device limit reached for actor' using errcode = '23514';
  end if;
  insert into private.glass_devices(id, actor, label, token_hash)
  values (p_id, p_actor, btrim(p_label), p_token_hash)
  returning * into v_device;
  return jsonb_build_object('id', v_device.id, 'actor', v_device.actor, 'label', v_device.label);
end;
$function$;
revoke all on function private.glass_register_device(text,text,text,bytea) from public, anon, authenticated;
grant execute on function private.glass_register_device(text,text,text,bytea) to service_role;
