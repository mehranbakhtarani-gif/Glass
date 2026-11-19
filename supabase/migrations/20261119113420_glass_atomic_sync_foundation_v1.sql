create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists public.glass_sync (
  id text primary key,
  data jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.glass_sync enable row level security;
revoke all on table public.glass_sync from public, anon, authenticated;
grant select, insert, update, delete on table public.glass_sync to service_role;

create table if not exists private.glass_devices (
  id text primary key,
  actor text not null check (actor in ('mehran', 'ehsan')),
  label text not null,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table if not exists private.glass_operations (
  id bigint generated always as identity primary key,
  company_id text not null,
  operation_id text not null,
  device_id text not null,
  device_sequence bigint not null check (device_sequence > 0),
  operation_type text,
  actor text,
  summary text,
  client_created_at timestamptz,
  applied_at timestamptz not null default now(),
  server_revision bigint not null,
  server_updated_at timestamptz not null,
  entity_changes jsonb not null default '[]'::jsonb,
  root_changes jsonb not null default '{}'::jsonb,
  unique (company_id, operation_id),
  unique (company_id, device_id, device_sequence)
);

create index if not exists glass_operations_company_applied_idx
  on private.glass_operations (company_id, applied_at desc);

create table if not exists private.glass_operation_log (
  id bigint generated always as identity primary key,
  company_id text not null,
  operation_id text not null,
  device_id text not null,
  actor text,
  operation_type text,
  summary text,
  revision bigint not null,
  created_at timestamptz not null default now(),
  unique (company_id, operation_id)
);

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema private to service_role;
grant usage, select on all sequences in schema private to service_role;

create or replace function public.glass_apply_state_operation(
  p_record_id text,
  p_expected_updated_at timestamptz,
  p_data jsonb,
  p_entity_changes jsonb,
  p_root_changes jsonb,
  p_operation_id text,
  p_actor text,
  p_device_id text,
  p_device_sequence bigint,
  p_operation_type text,
  p_summary text,
  p_client_created_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_state public.glass_sync%rowtype;
  v_existing private.glass_operations%rowtype;
  v_new_revision bigint;
  v_now timestamptz := clock_timestamp();
begin
  if p_record_id is null or length(btrim(p_record_id)) = 0
     or p_operation_id is null or length(btrim(p_operation_id)) = 0
     or p_device_id is null or length(btrim(p_device_id)) = 0
     or p_device_sequence is null or p_device_sequence < 1
     or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Invalid operation envelope' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_record_id, 0));

  select * into v_existing
  from private.glass_operations
  where company_id = p_record_id and operation_id = p_operation_id;

  if found then
    return jsonb_build_object(
      'status', 'already_applied',
      'revision', v_existing.server_revision,
      'updated_at', v_existing.server_updated_at,
      'merged', false
    );
  end if;

  select * into v_state
  from public.glass_sync
  where id = p_record_id
  for update;

  if not found then
    if p_expected_updated_at is not null then
      return jsonb_build_object('status', 'conflict', 'revision', 0, 'updated_at', null, 'merged', false);
    end if;

    v_new_revision := 1;
    insert into public.glass_sync (id, data, revision, updated_at)
    values (p_record_id, p_data, v_new_revision, v_now)
    returning * into v_state;
  else
    if p_expected_updated_at is null or v_state.updated_at <> p_expected_updated_at then
      return jsonb_build_object(
        'status', 'conflict',
        'revision', v_state.revision,
        'updated_at', v_state.updated_at,
        'merged', false
      );
    end if;

    v_new_revision := v_state.revision + 1;
    update public.glass_sync
      set data = p_data,
          revision = v_new_revision,
          updated_at = v_now
    where id = p_record_id
    returning * into v_state;
  end if;

  if exists (
    select 1 from private.glass_operations
    where company_id = p_record_id
      and device_id = p_device_id
      and device_sequence = p_device_sequence
  ) then
    raise exception 'Device sequence already used by another operation' using errcode = '23505';
  end if;

  insert into private.glass_operations (
    company_id, operation_id, device_id, device_sequence,
    operation_type, actor, summary, client_created_at,
    server_revision, server_updated_at, entity_changes, root_changes
  ) values (
    p_record_id, p_operation_id, p_device_id, p_device_sequence,
    p_operation_type, p_actor, p_summary, p_client_created_at,
    v_state.revision, v_state.updated_at,
    coalesce(p_entity_changes, '[]'::jsonb),
    coalesce(p_root_changes, '{}'::jsonb)
  );

  insert into private.glass_operation_log (
    company_id, operation_id, device_id, actor, operation_type,
    summary, revision, created_at
  ) values (
    p_record_id, p_operation_id, p_device_id, p_actor, p_operation_type,
    p_summary, v_state.revision, v_state.updated_at
  );

  return jsonb_build_object(
    'status', 'applied',
    'revision', v_state.revision,
    'updated_at', v_state.updated_at,
    'merged', false
  );
end;
$function$;

revoke all on function public.glass_apply_state_operation(
  text, timestamptz, jsonb, jsonb, jsonb, text, text, text, bigint, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.glass_apply_state_operation(
  text, timestamptz, jsonb, jsonb, jsonb, text, text, text, bigint, text, text, timestamptz
) to service_role;
