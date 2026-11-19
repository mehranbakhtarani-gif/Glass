# Glass Atomic Operations — Phase 1

## Scope

This change establishes a safe boundary for the next multi-device accounting work. It does **not** claim that invoice posting is already a server-side database transaction.

## Findings from the current client

- `saveState()` writes the browser snapshot and an operation record to IndexedDB, then schedules cloud synchronization.
- Operation records have a generated operation ID, a device ID, a device-local sequence, actor label, snapshot payload, and entity/root change sets.
- Device ID and actor assignment are stored in browser storage. They are useful for attribution and workflow, but they are **not authentication** and must not be trusted as authorization.
- `submitInvoice()` currently allocates invoice IDs in the browser using the current maximum ID, then mutates invoice, voucher, stock/batches, kardex, and settlement balance before calling `saveState()`.
- `postVoucher()` likewise allocates voucher IDs in the browser using the current maximum ID.
- Therefore, two devices can independently allocate the same next invoice or voucher number. A client-side idempotency key alone cannot prevent this.
- The old cloud configuration default pointed Glass at the `Holoo pro` Supabase project and the `holoo_sync/main_company_state` record. That violated the requirement that Glass remain independent from the Holoo application.

## Changes in this phase

1. Removed the embedded Holoo Supabase URL and publishable key from Glass defaults.
2. Changed the default cloud namespace to `glass_sync / glass_main_company_state`; URL and key must be configured explicitly for a dedicated Glass backend.
3. Changed the RPC endpoint to `glass_apply_state_operation`, so Glass does not silently call the Holoo-specific RPC.
4. Made synchronization fail closed when pending operations exist but the Glass atomic RPC is unavailable. The local outbox is retained; the client does not fall back to uploading a legacy full snapshot in that case.
5. Changed invoice confirmation wording so it no longer claims cloud synchronization before the server has acknowledged it.

## Required server transaction contract

The dedicated Glass backend must implement and test a transaction boundary before multi-device accounting is enabled.

### State-operation RPC

`glass_apply_state_operation` must, in one PostgreSQL transaction:

1. Resolve and lock the target company state row (`SELECT ... FOR UPDATE`).
2. Check the company revision / expected baseline.
3. Check idempotency using a unique key scoped to the company (and preferably a second unique constraint on company + device + device sequence).
4. Return `already_applied` for a replay of an already committed operation.
5. Reject stale or conflicting edits without overwriting another device's newer data.
6. Apply the accepted entity/root changes and update the aggregate state revision.
7. Insert the operation/audit record.
8. Commit the state update and operation log together; any error must roll back both.

The response must include a stable status (`applied`, `already_applied`, or `conflict`) and the committed server revision/timestamp. Acknowledgement in IndexedDB must happen only after this response.

### Accounting posting RPC

The state-operation RPC is not sufficient by itself to guarantee accounting correctness. A dedicated command such as `glass_post_invoice` is required for invoice posting. It must execute under a company-level transaction/lock and atomically:

- allocate invoice and voucher numbers on the server (never from `Math.max(...)+1` in the browser);
- enforce uniqueness for operation ID, invoice number, and voucher source/event;
- revalidate party, account, fiscal period, warehouse, and product references against the locked server state;
- recalculate or independently verify quantities, amounts, tax, FIFO allocations, and cost of goods sold;
- update invoice, voucher, stock/batches, kardex, and cash/bank balance as one unit;
- append the audit/operation log in the same transaction;
- return the canonical committed invoice, voucher, and new company revision.

A failed validation must leave every accounting subsystem unchanged. Retries with the same operation ID must return the original result rather than posting again.

## Security and deployment gate

- The browser publishable/anon key is not a secret and must never be treated as one.
- A locally stored `deviceId` or actor name is not proof of device identity.
- The user's preference for no password screen can be preserved in the UI, but production write access still needs a trustworthy authorization mechanism (for example, device pairing with revocable credentials or an equivalent server-verified identity). Public unrestricted writes are not an acceptable substitute.
- Do not deploy migrations or functions to the existing `Holoo pro` Supabase project. Glass requires its own dedicated Supabase project and explicit confirmation of that target.
- New tables/functions may require explicit Data API exposure/grants under current Supabase defaults; apply least privilege and RLS intentionally.

## Not completed in this phase

- No Supabase schema or RPC has been deployed.
- No live multi-device transaction test has been run.
- Invoice/voucher number allocation and full accounting validation are still client-side until the command RPC is implemented.
- This phase is a fail-safe isolation and contract step, not a claim of production-ready atomic posting.

## Acceptance tests for the backend phase

1. Two devices submit the same operation ID concurrently: exactly one operation is committed; the other receives `already_applied`.
2. Two devices submit different operations against the same baseline: one is serialized; the other either safely merges disjoint entities or receives a conflict. No update is silently lost.
3. Two devices request the next invoice/voucher number concurrently: unique server-generated numbers are returned.
4. A forced error after voucher creation but before stock update rolls back the entire transaction, including audit log.
5. A network timeout after commit followed by retry does not duplicate invoice, voucher, stock movement, or cash/bank movement.
6. A stale device cannot overwrite a newer company revision using the legacy snapshot endpoint.
7. An unpaired/unauthorized device cannot write, even if it knows the public publishable key.
