#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
MIGRATION="supabase/migrations/20261119113420_glass_atomic_sync_foundation_v1.sql"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$$;
SQL

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$MIGRATION"

seed="$(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "
  SELECT public.glass_apply_state_operation(
    'glass_main_company_state', NULL,
    '{\"vouchers\":[],\"marker\":\"seed\"}'::jsonb,
    '[]'::jsonb, '{}'::jsonb, 'concurrency-seed-op',
    'mehran', 'device-mehran', 1, 'state_snapshot', 'seed', clock_timestamp()
  );")"
echo "Seed result: $seed"
baseline="$(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT updated_at::text FROM public.glass_sync WHERE id='glass_main_company_state';")"

apply_operation() {
  local operation_id="$1" actor="$2" device="$3" marker="$4"
  psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "
    SELECT public.glass_apply_state_operation(
      'glass_main_company_state', '$baseline'::timestamptz,
      jsonb_build_object('vouchers','[]'::jsonb,'marker','$marker'),
      '[]'::jsonb, '{}'::jsonb, '$operation_id',
      '$actor', '$device', 1, 'state_snapshot', '$marker', clock_timestamp()
    );"
}

apply_operation "concurrent-mehran-op" "mehran" "device-mehran" "mehran-write" > /tmp/glass-mehran-result.json &
pid_mehran=$!
apply_operation "concurrent-ehsan-op" "ehsan" "device-ehsan-1" "ehsan-write" > /tmp/glass-ehsan-result.json &
pid_ehsan=$!
wait "$pid_mehran"
wait "$pid_ehsan"

mehran_result="$(cat /tmp/glass-mehran-result.json)"
ehsan_result="$(cat /tmp/glass-ehsan-result.json)"
echo "Mehran concurrent result: $mehran_result"
echo "Ehsan concurrent result: $ehsan_result"

applied_count="$(printf '%s\n%s\n' "$mehran_result" "$ehsan_result" | grep -c '"status": "applied"' || true)"
conflict_count="$(printf '%s\n%s\n' "$mehran_result" "$ehsan_result" | grep -c '"status": "conflict"' || true)"
if [[ "$applied_count" != "1" || "$conflict_count" != "1" ]]; then
  echo "Expected exactly one applied and one conflict; got applied=$applied_count conflict=$conflict_count" >&2
  exit 1
fi

counts="$(psql "$DATABASE_URL" -X -qAt -F ':' -v ON_ERROR_STOP=1 -c "
  SELECT s.revision,
         (SELECT count(*) FROM private.glass_operations WHERE company_id='glass_main_company_state'),
         (SELECT count(*) FROM private.glass_operation_log WHERE company_id='glass_main_company_state')
  FROM public.glass_sync s WHERE s.id='glass_main_company_state';")"
echo "Post-race revision:operations:audit = $counts"
[[ "$counts" == "2:2:2" ]] || { echo "Unexpected state after race: $counts" >&2; exit 1; }

if grep -q '"status": "applied"' /tmp/glass-mehran-result.json; then
  winner_op="concurrent-mehran-op"; winner_actor="mehran"; winner_device="device-mehran"; winner_marker="mehran-write"
else
  winner_op="concurrent-ehsan-op"; winner_actor="ehsan"; winner_device="device-ehsan-1"; winner_marker="ehsan-write"
fi

replay="$(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "
  SELECT public.glass_apply_state_operation(
    'glass_main_company_state', '$baseline'::timestamptz,
    jsonb_build_object('vouchers','[]'::jsonb,'marker','$winner_marker'),
    '[]'::jsonb, '{}'::jsonb, '$winner_op',
    '$winner_actor', '$winner_device', 1, 'state_snapshot', '$winner_marker', clock_timestamp()
  );")"
echo "Idempotent replay: $replay"
grep -q '"status": "already_applied"' <<< "$replay"

counts_after_replay="$(psql "$DATABASE_URL" -X -qAt -F ':' -v ON_ERROR_STOP=1 -c "
  SELECT s.revision,
         (SELECT count(*) FROM private.glass_operations WHERE company_id='glass_main_company_state'),
         (SELECT count(*) FROM private.glass_operation_log WHERE company_id='glass_main_company_state')
  FROM public.glass_sync s WHERE s.id='glass_main_company_state';")"
[[ "$counts_after_replay" == "2:2:2" ]] || { echo "Replay duplicated a committed operation: $counts_after_replay" >&2; exit 1; }

echo "PASS: concurrent CAS, single winner, conflict preservation, idempotent replay, and atomic audit counts."
