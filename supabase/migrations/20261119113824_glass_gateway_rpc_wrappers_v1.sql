create or replace function public.glass_gateway_register_device(
  p_id text, p_actor text, p_label text, p_token_hash bytea
) returns jsonb language sql security definer set search_path = ''
as $function$ select private.glass_register_device(p_id, p_actor, p_label, p_token_hash); $function$;

create or replace function public.glass_gateway_lookup_device(p_token_hash bytea)
returns table(id text, actor text, label text)
language sql security definer set search_path = ''
as $function$ select * from private.glass_get_device_by_token_hash(p_token_hash); $function$;

create or replace function public.glass_gateway_touch_device(p_device_id text)
returns boolean language sql security definer set search_path = ''
as $function$ select private.glass_touch_device(p_device_id); $function$;

revoke all on function public.glass_gateway_register_device(text,text,text,bytea) from public, anon, authenticated;
revoke all on function public.glass_gateway_lookup_device(bytea) from public, anon, authenticated;
revoke all on function public.glass_gateway_touch_device(text) from public, anon, authenticated;
grant execute on function public.glass_gateway_register_device(text,text,text,bytea) to service_role;
grant execute on function public.glass_gateway_lookup_device(bytea) to service_role;
grant execute on function public.glass_gateway_touch_device(text) to service_role;
