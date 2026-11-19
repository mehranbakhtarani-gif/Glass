# Glass Device Gateway v1

## Scope
The gateway is dedicated to the independent Glass-Accounting Supabase project. The browser does not read or write the database directly.

## Endpoints
Deploy as Supabase Edge Function `glass-gateway`, with platform JWT verification disabled because the function authenticates device bearer tokens itself.

- `POST /functions/v1/glass-gateway` with `{ action: "pair", pairingCode, actor, label }` issues a device credential.
- `POST` with `{ action: "read" }` and `Authorization: Bearer <deviceToken>` returns the single company snapshot.
- `POST` with `{ action: "apply", operation: ... }` and a device bearer token submits an atomic operation.

## Trust boundaries
- `SUPABASE_SECRET_KEYS.default` is used only inside the Edge Function. It is never sent to the browser or committed.
- The device token is generated with Web Crypto, returned once, and only its SHA-256 hash is stored in `private.glass_devices`.
- Actor and device ID are derived from the active token record. Browser-supplied actor/device values are ignored.
- The company record ID is fixed server-side as `glass_main_company_state`.
- Active device caps are enforced transactionally: one for `mehran`, two for `ehsan`.
- Revoked tokens stop authenticating because lookup filters `revoked_at is null`.
- Private operational tables have RLS enabled and no client policies. Gateway helper RPCs are executable only by `service_role`.

## Frontend integration
The Glass frontend now:
- Uses the dedicated project URL and publishable key, with no Holoo project fallback.
- Calls only the `glass-gateway` Edge Function for reads and writes; direct `/rest/v1` access has been removed from the client.
- Pairs a device with its assigned actor and a one-time bootstrap code, then stores the returned device token locally on that device.
- Sends the local operation journal through the gateway. Actor and device identity are not accepted from browser operation fields.
- Keeps the outbox on network errors and compare-and-swap conflicts. It does not fall back to a legacy snapshot write.

## Pairing secret setup
In Supabase Dashboard → Edge Functions → Secrets, add:
- Name: `GLASS_PAIRING_SECRET`
- Value: a newly generated random secret of at least 32 characters.

Do not put this value in GitHub, the frontend, localStorage, or a screenshot. Rotate or remove it after all three devices are paired. Pairing returns HTTP 503 until the secret is configured.

## Remaining limitations
- No operator-facing device revocation screen exists yet; revocation can be performed by setting `revoked_at` on the corresponding device row through a trusted administrative path.
- Pairing attempts are not yet rate-limited; use a high-entropy bootstrap secret and keep the enrollment window short.
- Live browser invocation, device pairing, and multi-device concurrency have not yet been verified. The frontend integration is committed to this PR but is not live until the PR is merged and the static site is deployed.
- The current server operation model uses strict whole-snapshot compare-and-swap. Conflicting edits are stopped rather than silently overwritten.
