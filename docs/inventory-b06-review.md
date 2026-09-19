# B0.6 — Mobile Header completed; inventory hardening blocked

Historical review only. The scope stop and isolated Header evidence below are superseded by [inventory-canonical-contract.md](inventory-canonical-contract.md), including the completed canonical hardening and real App Header verification.

Branch: `feat/maintenance-material-usage-phase-b`.
Baseline: `bb451a68f7272cd51bf1de3df9d84f2a5d9f58ef`.
No Production mutation, Candidate migration, commit, push, full build, or Phase B implementation.

## Independent Header change

`src/app/page.tsx` now uses a two-column mobile grid: title and compact perspective tabs on row one, existing subpage navigation spanning row two. Mobile subpage padding/type size also fits all three Engineering tabs at 320px. At `md` the original flex layout, gaps, button sizes and text sizes apply. No navigation state, permissions, available subpages or storage logic changed.

Verification uses the actual header JSX extracted from the working tree, rendered with React and actual project Tailwind CSS, with synthetic labels/date/user only. This is a layout fixture, not an authenticated end-to-end App review. Baseline JSX comes from HEAD. Mobile checks: 320, 375, 390, 430px for all three perspectives; title/tab row overlap, non-overlap horizontally, subpages below, no horizontal content overflow. Desktop checks compare every header element's geometry against baseline. The fixture and generated CSS are ignored local artifacts under `.codex-logs`.

## Effective balance contract

Evidence: `src/lib/db/poc-supabase.ts` lines 1309–1335, `src/lib/db/types.ts` lines 555–557, and `src/lib/db/inventory-stock.ts`.

For each item, balance is its `opening_quantity` plus effective ledger deltas. Effective means `is_voided` is false/null and `excluded_by_initialization_id` is null. IN and RETURN add quantity; OUT subtracts quantity; ADJUST adds its signed quantity. The App does not use monthly closing snapshots as the current balance source or filter current balance by transaction date. Monthly snapshots are used by monthly reporting separately.

The corresponding SQL expression would use `COALESCE(opening_quantity,0)` plus `COALESCE(SUM(CASE transaction_type WHEN 'IN' THEN quantity WHEN 'RETURN' THEN quantity WHEN 'OUT' THEN -quantity WHEN 'ADJUST' THEN quantity ELSE 0 END),0)`, filtered by `is_voided IS NOT TRUE AND excluded_by_initialization_id IS NULL`. This is a derived contract, not an installed or SQL-verified helper.

The TypeScript delta helper also handles TRANSFER_IN/TRANSFER_OUT, but the schema transaction-type CHECK permits only IN/OUT/RETURN/ADJUST and the current form exposes only those four. Transfers are not included as an executable mutation.

## Direct negative mutation map

All references below are relative to this worktree and describe current code, not proposed behavior.

| Operation / original type | Why effective balance decreases | Existing write path / transaction and locking | Mutex requirement |
| --- | --- | --- | --- |
| Create OUT | Subtract positive quantity | `TransactionForm.tsx:213`, inventory page handlers, `poc-supabase.ts:911`; separate ledger/serial/link/activity requests, no shared item mutex | Yes |
| Create negative ADJUST | Adds a negative delta | `TransactionForm.tsx:293` computes counted minus client balance, same create adapter | Yes; expected balance must be validated while locked |
| Edit IN / RETURN | Reduce credited quantity | `transactions/page.tsx:236` → `poc-supabase.ts:949`; serial writes precede ledger update; old links deleted and replacements inserted afterward | Yes |
| Edit OUT | Increase debited quantity | Same unrestricted edit path | Yes |
| Edit ADJUST | New signed quantity is less than old signed quantity | Same edit path; form computes delta from client balance | Yes; edit must account for original contribution |
| Change transaction type | New contribution can be below old contribution, e.g. IN → OUT | `TransactionForm.tsx:323` type controls remain available during editing; same update adapter | Yes |
| Change transaction item | Removing a positive contribution lowers old item; moving a negative contribution lowers new item | `TransactionForm.tsx:360` permits clearing/reselecting item during edit; payload builder copies item_id | Yes; lock old/new item IDs in sorted order |
| Void IN | Removes positive contribution | `transactions/page.tsx:272`; ADMIN only. `poc-supabase.ts:1023` updates is_voided; existing safely_void_inventory_in_transaction trigger atomically locks/voids related serials, but does not lock item/check balance | Yes; preserve ADMIN and existing serial-history checks |
| Void RETURN | Removes positive contribution | Same void adapter; reverts serials to 已出庫 in separate requests before voiding ledger | Yes |
| Void positive ADJUST | Removes positive contribution | Same void adapter; no item balance validation | Yes |
| Lower opening quantity | Directly decreases balance baseline | `ItemForm.tsx:108`, `ItemDetailModal.tsx:207`, `poc-supabase.ts:419`. Allowed only when no monthly snapshot exists; DB guard rejects locked opening changes. UPDATE obtains a row lock but does not validate resulting ledger balance | Yes when this edit is eligible |
| One-time initialization | Replaces openings and excludes previous ledger, potentially reducing effective balance | Latest `initialize_inventory` in migration `20260901151219...` changes exclusions at line 334/openings at 343. One DB transaction with table ROW EXCLUSIVE locks, but these are not a mutually exclusive item-lock protocol. ADMIN-only and rejected after initialization | Requires coordination only where initialization remains eligible; do not rerun or change initialized data |

Not negative ledger paths: creating positive IN/RETURN/ADJUST; voiding OUT or negative ADJUST; changing notes/project only; changing date alone; deactivating an item (`deleteInventoryItem` only sets is_active=false); monthly close/unseal snapshot maintenance; serial-only changes. No ordinary transaction hard-delete/cancel method is exposed by this adapter/UI. Initialization preserves old transactions via exclusion, rather than deleting ledger history.

Serial-only writes still matter for OUT safety: `inventory/serials/page.tsx:117` updates serial status/project, then independently fills its transaction link at line 123. They do not change numeric balance, but can compete for the same serial. They must not be mistaken for balance-lowering transactions.

## First blocker: existing serial edit/void lifecycle cannot be covered by a ledger-only lock

This triggers user instructions G / O.1: making the existing edit/void architecture atomic exceeds adding a small shared item-lock protocol to OUT/ADJUST.

Direct evidence:

1. `transactions/page.tsx:248` calls `resolveTransactionSerialLinks` before the update adapter. That resolver writes serial status/project (`:157`) and may create serial rows (`:189`). Those writes already commit independently.
2. `poc-supabase.ts:972` calls `revertSerialsForTransaction` before the ledger UPDATE (`:979`). For an existing OUT, the revert helper sets its serials to 在庫 (`:901`) while the old OUT and links still remain effective.
3. The adapter next deletes links (`:991`), inserts replacements and changes serial status again (`:1005`), then writes activity. A lock acquired only by the ledger UPDATE cannot encompass the earlier or later HTTP transactions. A later validation failure cannot roll them back.
4. Non-IN void has the same pre-commit serial reversion (`:1047`); IN void is already a special DB trigger contract with different history rules.

Concrete race derived from these paths: editing an existing OUT temporarily restores its serial to 在庫; a new atomic OUT can acquire the item/serial locks and consume it in that interval; the legacy edit then continues and restores its own outgoing link. Sufficient numeric stock does not prevent two effective OUT links using the same serial. This race is a code-path derivation, not a executed concurrency test.

A balance trigger alone could reject a negative ledger result, but would not undo precommitted serial writes or protect the entire link-replacement lifecycle. A lock-only RPC also releases its locks when that HTTP request commits. Permanent UNIQUE(serial_id) would break historical IN/RETURN/reissue relationships and is explicitly disallowed.

## Smallest staged next step

1. Establish the common item mutex and balance helper with Candidate contract tests, then make **existing transaction edit/void** an atomic operation over old/new item locks, affected serial locks, ledger, links, batches and activity. Keep existing UI fields and all IN-void authorization/history restrictions. Resolve how legacy pending-OUT serial completion joins the same protocol. No historical data movement is required.
2. Connect ordinary OUT and counted/expected ADJUST to that established boundary, and run OUT/OUT, OUT/ADJUST, edit/OUT, void/OUT and serial/pending-link races. Until both stages pass, do not treat the hardening as safe or start Maintenance integration.

No inventory implementation or migration was introduced after identifying this scope boundary. SQL/RLS/concurrency tests therefore have not been run for a new protocol. Header changes remain independently reviewable.

## Verification result

- Responsive browser fixture: PASS, 12 mobile cases (three perspectives × four widths). All subpage content fits without horizontal scrolling.
- Desktop baseline element geometry: PASS, nine comparisons (three perspectives × 768/1024/1200px).
- Visual screenshot inspected at 320px, including all three Engineering subpage labels.
- Existing dashboard-navigation Node tests: 4/4 PASS, including member/perspective storage and subpage fallback behavior.
- `tsc --noEmit`: PASS. `git diff --check`: PASS (only Windows LF/CRLF notices).
- No full build; no new SQL/RLS/concurrency test claim; no database fixtures created.
- Browser viewport override reset after verification. The isolated fixture has no Supabase connection.
