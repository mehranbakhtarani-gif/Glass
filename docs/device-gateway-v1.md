# Glass Device Gateway v1

## Scope
This gateway is dedicated to the independent Glass Supabase project. It never calls or reads the Holoo project. The browser must not call the database RPC or read glass_sync directly.

## Endpoints
Deploy as Supabase Edge Function glass-gateway with JWT verification disabled because the function validates its own device bearer token.

- POST /functions/v1/glass-gateway with { action: pair, pairingCode, actor, label } creates a device credential. Pairing is disabled until GLASS_PAIRING_SECRET is configured as a Supabase Edge Function secret with at least 32 characters.
- POST with { action: read } and Authorization: Bearer <deviceToken> returns the one fixed company snapshot.
- POST with { action: apply, operation: ... } and a device bearer token submits an atomic operation.

## Trust boundaries
- SUPABASE_SECRET_KEYS.default is read only inside the Edge Function. It is never sent to the browser or committed.
- The device token is generated with Web Crypto, returned once, and only its SHA-256 hash is stored in private.glass_devices.
- Actor and device ID are derived from the active token record. Browser-supplied actor/device values are ignored.
- The company record ID is hardcoded server-side as glass_main_company_state.
- Active device caps are enforced transactionally in Postgres: one for mehran, two for ehsan.
- Revoked tokens stop authenticating because lookup filters revoked_at is null.
- The three private tables have RLS enabled and no client policies. Gateway helper RPCs are executable only by service_role.
- The existing atomic operation RPC remains service-role-only. The gateway supplies canonical actor/device identity.

## Pairing secret setup
In Supabase Dashboard → Edge Functions → Secrets, add:
- Name: GLASS_PAIRING_SECRET
- Value: a newly generated random secret of at least 32 characters.

Do not put this value in GitHub, the Glass frontend, localStorage, or a screenshot. Rotate it after all three devices are paired. Pairing currently uses a shared bootstrap secret; the endpoint should only be exposed during the initial device-enrollment window.

## Client integration contract
The frontend should store the returned device token locally on that device and call only the Edge Function. It must not send the token to GitHub or include it in backups. Replace direct REST calls to /rest/v1/rpc/glass_apply_state_operation and direct glass_sync reads with gateway actions. Keep the outbox until the gateway confirms applied or already_applied; keep it on errors/conflicts.

## Current limitations
- This PR establishes the gateway and server-side device identity, but does not yet migrate the Glass frontend to use it.
- Device revocation is supported by the database state (revoked_at) but no operator-facing revoke action/UI is included yet.
- Pairing attempts are not yet rate-limited; use a high-entropy bootstrap secret and rotate/disable it after enrollment.
- No live browser or multi-device concurrency test is claimed here.