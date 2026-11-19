# Glass Atomic Operations — Backend Foundation

## Scope

This document tracks the backend foundation for the independent Glass application. The current database layer provides a transaction-safe state journal boundary; it does **not** yet make invoice posting production-ready or enable client-side writes.

## Findings from the current client

- `saveState()` writes the browser snapshot and an operation record to IndexedDB, then schedules cloud synchronization.
- Operation records have a generated operation ID, a device ID, a device-local sequence, actor label, snapshot payload, and entity/root change sets.
- Device ID and actor assignment are stored in browser storage. They are useful for attribution and workflow, but they are **not authentication** and must not be trusted as authorization.
- `submitInvoice()` currently allocates invoice IDs in the browser using the current maximum ID, then mutates invoice, voucher, stock/batches, kardex, and settlement balance before calling `saveState()`.
- `postVoucher()` likewise allocates voucher IDs in the browser using the current maximum ID.
- Therefore, two devices can independently allocate the same next invoice or voucher number.

## Deployed independent Supabase foundation

Target project: `Glass-Accounting` (project ref `bdbckuwsilncbvqsknub`). The existing Holoo Supabase project was not modified.

Migration: `20261119113420_glass_atomic_sync_foundation_v1`

Created objects:
- `public.glass_sync`: company state snapshot, monotonic revision, server timestamp; RLS enabled; no direct anon/authenticated grants.
- `private.glass_devices`: device identity and revocable token-hash storage; no credentials have been provisioned yet.
- `private.glass_operations`: idempotency journal with unique company/operation and company/device/sequence constraints.
- `private.glass_operation_log`: append-only operation audit metadata.
- `public.glass_apply_state_operation(...)`: transaction-scoped state operation RPC.

RPC behavior:
1. Serializes operations by company using a transaction advisory lock.
2. Returns `already_applied` for a replay of a committed operation ID.
3. Requires the expected server timestamp to match the current snapshot; stale baselines return `conflict`.
4. Writes the snapshot, operation journal row, and audit row in the same PostgreSQL transaction.
5. Rejects a reused device sequence with a different operation ID.
6. Exposes execution to `service_role` only. It is deliberately not callable by `anon` or `authenticated`.

Important limitation: this first RPC uses strict whole-snapshot compare-and-swap. It stores entity/root change metadata for audit/future reconciliation but does not yet merge disjoint entity changes. This is safer than silently overwriting another device, but it may return conflicts that need resolution.

## Verification performed

- Migration recorded successfully in Supabase.
- Schema inspection confirms all four tables exist and `public.glass_sync` has RLS enabled.
- Privilege checks confirm anon cannot read `glass_sync` or execute the RPC; service_role has the required access.
- Transaction test returned:
  - first operation: `applied`, revision 1;
  - retry of the same operation ID: `already_applied`, same revision/timestamp;
  - stale second operation: `conflict`, no overwrite.
- Test ran inside a transaction and was rolled back; no test company data was retained.
- Security and performance advisors were run.

## Security follow-up required

- The security advisor flagged RLS disabled on the three tables inside the non-exposed `private` schema. Direct privilege checks confirmed anon and authenticated have no SELECT access to those tables, but RLS should be enabled as defense in depth. This is a pending hardening item.
- No device tokens have been issued or stored. Until a pairing gateway validates revocable device credentials, no browser device should be allowed to call write RPCs.
- The publishable key is public by design and is not a device credential. Never place a service-role or secret key in Glass frontend code.
- The user's preference for no password screen can be preserved with device pairing, but the server must still authenticate each paired device.

## Not completed

- The browser still calls the RPC directly with the publishable key; because execution is service_role-only, client writes remain blocked by design until a secure Edge Function gateway is deployed and the client is routed through it.
- Device pairing and revocation flow is not implemented.
- The conflict read path must be routed through the authenticated gateway; the client must not receive unrestricted direct read access to the company snapshot.
- `glass_post_invoice` is not implemented. Invoice/voucher numbering, full account/period/warehouse validation, tax/FIFO recalculation, and atomic posting across invoice, voucher, stock, kardex, treasury, and audit remain future work.
- No live multi-device concurrency or browser end-to-end test has been run.

## Next implementation order

1. Enable RLS on the private device/journal/audit tables and keep them inaccessible to anon/authenticated.
2. Implement a server-only device-pairing bootstrap and revocable per-device credentials.
3. Deploy an Edge Function gateway that validates each device token, then invokes the service-role RPC; never expose the service-role key to the browser.
4. Update Glass to use the gateway for sync and conflict reads.
5. Implement `glass_post_invoice` with server-generated invoice/voucher numbers and atomic accounting validation/posting.
6. Run concurrent-device, retry, rollback, stale-baseline, and unauthorized-device acceptance tests.

## Acceptance criteria before production accounting use

1. Two devices submit the same operation ID concurrently: exactly one operation is committed; the other receives `already_applied`.
2. Two devices submit different operations against the same baseline: one is serialized; the other safely merges disjoint changes or receives an explicit conflict. No update is silently lost.
3. Two devices request the next invoice/voucher number concurrently: unique server-generated numbers are returned.
4. A forced error after voucher creation but before stock update rolls back the entire transaction, including audit log.
5. A network timeout after commit followed by retry does not duplicate invoice, voucher, stock movement, or cash/bank movement.
6. A stale device cannot overwrite a newer company revision using the legacy snapshot endpoint.
7. An unpaired/revoked device cannot write, even if it knows the public publishable key.
