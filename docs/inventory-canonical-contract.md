# Inventory canonical write contract

This LOOP supersedes the scope stop in inventory-b06-review.md. Existing ledger and history remain the source of truth. Production is excluded. Candidate `fssogssryeunkjkdgewx` was verified using environment_guard and the baseline fingerprint before business-data checks.

| Operation | Can lower effective balance? | Serial changes? | Old path / atomicity | Required lock |
| --- | --- | --- | --- | --- |
| IN | No for valid positive creation | Create, register, assign receipt batch | page → multiple adapter requests; not atomic | item, serial |
| OUT | Yes | 在庫 → 已出庫, bind project, link | multiple requests; not atomic | item, serial |
| RETURN | No for positive creation | Restore outgoing serial and receipt batch | old UI erroneously selects 在庫 and writes 已退回 | item, serial; now 已出庫 → 在庫 as explicitly requested |
| ADJUST | Yes if negative | Not supported for serialized items | client-computed delta, direct insert | item; expected balance conflict check |
| Edit | Yes: lower credit, increase debit, type/item change | Undo old effect and apply replacement | prewrites serial, updates ledger, deletes/recreates links in separate requests | sorted old/new items, transaction, sorted old/new serials |
| Void | Yes for IN, RETURN, positive ADJUST | Reverse terminal event; IN preserves 作廢 history | IN serial part has DB trigger; others split | item, transaction, serial |
| Pending serial completion / batch registration | No numeric delta | Create or consume serial; fill link | multiple requests | item, transaction, serial |
| Serial deletion | No numeric delta | Removes identity | direct delete | item, serial; linked history must remain |
| Opening quantity edit | Yes | No | item UPDATE locks row, but no balance check | item row + resulting-balance validation |
| Initialization | Replaces opening/excludes old ledger | Retained stock and pending IN | single existing function, table ROW EXCLUSIVE (not mutual exclusion) | all items sorted before existing function |
| Monthly close / cutoff | Does not change live balance | No | existing snapshot and date-write guards | preserve guards |

Balance = opening_quantity + SUM(effective IN + RETURN - OUT + signed ADJUST). Effective is `is_voided IS NOT TRUE AND excluded_by_initialization_id IS NULL`. No extra date filter or monthly-snapshot addition. Four types are enforced by the existing DB CHECK; transfer labels in the TS helper are not executable App types. Deactivation is not deletion and does not affect balance.

Every canonical write uses item → transaction → serial ordering. Edit first reads the original item only to discover locks, then locks both items sorted and rechecks the original transaction; a changed item or version produces conflict. Void uses the same order to avoid inversion with edit. Serial history is not globally unique: OUT → RETURN → OUT retains all links. A serial-linked transaction with subsequent effective serial events cannot be rewritten/voided underneath those events. Receipt-origin edits cannot move registered serial identities to another item/type; quantities, remaining registrations, fields and safe terminal corrections stay supported. Historical excluded records remain readable; only initialization-pending serial registration is writable without reinterpreting excluded stock.

Public RPCs validate existing editor/admin membership, use fixed search_path, and own the complete transaction. Client direct DML on ledger/serial/link/batch tables is revoked so an old browser cannot bypass them. Existing RLS SELECT policies remain. IN void retains its ADMIN-only rule and existing trigger. Initialization retains its existing algorithm behind an item-lock wrapper. Opening edits retain the monthly-lock guard and add nonnegative-result validation.

Candidate preflight: one initialization, no negative balances, no active serial/item mismatch, no duplicate serial within a transaction, no latest IN/OUT status mismatch, no effective RETURN rows. No history repair or data rewrite is required by these checks.

## Implementation and migration record — 2026-09-18

Candidate-only applied migrations (filenames synchronized to Candidate migration-history versions):

- `20260918135747_inventory_canonical_atomic_writes.sql`: balance, actor/audit/history helpers; atomic CREATE/EDIT/VOID; pending/batch registration; unlinked-serial deletion; item-opening guard; locked initialization wrapper; revoke legacy direct ledger/serial/link/batch DML.
- `20260918135951_inventory_canonical_project_binding.sql`: fixes `projects.project_name`, discovered by testing the real Candidate schema. The first migration is retained exactly as applied; this follow-up makes fresh replay and the deployed Candidate converge.
- `20260918140309_inventory_canonical_baseline_grants.sql`: revoke direct initialization-baseline writes and TRUNCATE; add active-member SELECT RLS. Deleting a baseline previously could reinterpret excluded ledger, so this is part of canonical write safety.
- `20260918142313_inventory_canonical_opening_guard.sql`: reject negative new-item opening and non-finite openings; verify initialization capability before bypassing the update balance check.
- `20260918145128_inventory_conflict_http_status.sql`: return business conflicts as `PT409` (HTTP 409) so stale submissions reach the UI without serialization retries.
- `20260918145904_inventory_serial_audit_snapshots.sql`: capture serial identities, status, project and receipt batch in before/after audit snapshots, including serial-only edits.

RETURN corrections restore the preceding receipt batch as well as status/project. Existing normalized-full uniqueness remains; no permanent serial-link uniqueness is introduced. The original cutoff trigger's search path is pinned so it remains usable inside restricted RPC search paths.

Application adapters now call one RPC per mutation. The overview, transaction list, serial completion page, and item-detail batch registration use these adapters. Old `updateInventorySerial` fails closed; no formal UI calls it. Item-detail registration/deletion displays server errors. A count form retains the balance seen when opened; background changes cannot silently rebase expected_balance. No retry of stale counts occurs. The transaction list displays the minus sign for negative ADJUST quantities.

## Verification record

| Gate | Result / evidence |
| --- | --- |
| Targeted Node | PASS, 8 tests: `node --test src/lib/inventory-atomic.test.js src/lib/dashboard-navigation.test.js` |
| SQL/RLS | PASS on local PostgreSQL 17 and actual Candidate, `supabase/tests/inventory-canonical.sql`; entire test is BEGIN/ROLLBACK |
| Fresh migration replay | PASS in separate local `inventory_canonical_final` DB with the existing inventory baseline and all six migrations; SQL/RLS and initialization tests also pass after replay |
| Initialization success | PASS, `supabase/tests/inventory-initialization-local.sql` in the empty local DB; retained historical ledger is excluded, opening becomes 4, effective balance becomes 4; rolled back |
| Canonical parity | PASS using actual App `isActiveFormalTransaction` and `getInventoryTransactionQuantityDelta` against the same DB rows: opening + IN/OUT/RETURN/positive and negative ADJUST, void, initialization exclusion = 15 |
| Concurrency | PASS, `node scripts/test-inventory-concurrency.cjs`, independent local psql sessions with observed `pg_stat_activity.wait_event_type='Lock'`; cleanup completed |
| OUT 4 vs OUT 4 from 5 | One success; final balance 1 |
| OUT vs count=0/expected=5 | One success, stale competitor; reverse order also tested, OUT rejected as insufficient |
| Same serial OUT vs OUT | One success; no double consumption |
| Edit swaps serial A→B vs OUT A | Both can succeed after serialization; two distinct consumed serials, no shared effective outgoing serial |
| Void positive credit vs OUT | One success; nonnegative final balance |
| Mid-write failure | PASS: deliberately failing audit trigger runs after ledger/link/status writes; ledger count, serial row and all serial links unchanged after rollback |
| Edit failure | PASS: restoring old serial followed by invalid replacement rolls back status and links |
| Permissions | Viewer CREATE OUT/ADJUST, EDIT, VOID denied; editor IN void denied; ADMIN IN void passes; direct ledger/serial/baseline DML denied |
| Month close / cutoff | Sealed-month and pre-baseline writes rejected; pending serial registration on a sealed receipt fills identity without rewriting its ledger |
| Serial history | IN→OUT→RETURN→OUT passes; nonterminal correction rejected; void reversals and original receipt batch verified; linked deletion rejected |
| Quantity corrections | Positive/negative counted ADJUST and edit pass; consumed positive credit cannot be voided; larger OUT edit rejected when insufficient |
| Opening | Negative item creation, non-finite opening and an opening decrease causing negative effective balance rejected |
| TypeScript | PASS, `node node_modules/typescript/bin/tsc --noEmit` |
| Diff | PASS, `git diff --check`; Windows line-ending notices only |
| Mobile Header | PASS, rerun against extracted current JSX and Tailwind: all 12 mobile cases (3 perspectives × 320/375/390/430) and 9 desktop geometry comparisons (768/1024/1200); desktop matches HEAD baseline |
| Actual local UI | PASS: ordinary OUT and quantity edit; counted ADJUST; stale-count alert with no new row; serial IN/OUT, serial swap edit, RETURN, reissue and Void; history and serial-only audit visible |
| Excel | PASS: actual monthly UI export downloaded and parsed; signed ADJUST -3, void marker, RETURN/serial/project, date cells and monthly closing quantity verified |

Concurrency is verified against a disposable LOCAL database, not claimed as concurrent Candidate HTTP testing. Candidate independently passed the SQL/RLS and rollback suite.

## Actual local UI verification

Inventory mutation verification initially used `http://127.0.0.1:3000`. The unrelated old localhost service was subsequently stopped with user authorization, and `http://localhost:3000` now serves this worktree. The old client's attempted direct OUT had been correctly denied by Candidate and wrote no ledger.

The count fixture started at 5. Submitting counted quantity 2 created ADJUST -3. A second form retained expected_balance=2 while an intervening fixture OUT reduced the balance to 1. Its stale submission displayed exactly “庫存已在盤點期間發生異動，請重新載入後再確認。” and created no additional ADJUST. Candidate PostgREST 14.5 retried the original SQLSTATE 40001 indefinitely; business conflicts now use PT409, consistent with the [Supabase troubleshooting guidance](https://github.com/orgs/supabase/discussions/50151).

The serial fixture registered UITEST001-AA and UITEST002-AA, issued the first, atomically swapped to the second, returned the second and issued it again. Voiding the reissue restored both serials to 在庫 with no project while retaining voided history and all historical links. The existing native reason prompt was accepted concurrently with its click operation to avoid the browser automation focus timeout; product interaction was preserved. A subsequent serial-only edit showed both old and new identities, actor and reason in the actual history modal.

The actual monthly export `C:\Users\Pei\Downloads\庫存月結_2026-09 (1).xlsx` was downloaded on 2026-09-18 at 23:03:56 local time and parsed using the repository's xlsx dependency. Assertions passed for signed ADJUST -3, voided reissue, RETURN serial/project, date cells and closing quantity 1. The existing similarly named download was left untouched.

Candidate UI cleanup verified the exact two `76000000-...` item IDs, [TEST] names/codes, creation timestamp, seven marked transactions and two serials before deletion in one guarded transaction. All dependent fixture batches, links and audit rows were removed. Earlier `74000000-...` UI fixtures and rollback SQL fixtures `72000000-...` also left no rows. Final checks: fixture items/transactions/serials/batches/audits 0, negative balances 0, serial/item mismatches 0, latest serial-state mismatches 0, initialization count 1 and active inventory RPC requests 0.

Security advisors after baseline RLS correction report no RLS-disabled initialization tables. Intentional authenticated SECURITY DEFINER RPC notices remain: functions validate actors internally and fix search_path. Existing unrelated notices for `set_updated_at`, public `pg_net`, and leaked-password protection were not changed. References: [definer RPC advisory](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [search-path advisory](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), [extension advisory](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## Final release gate — 2026-09-19

The final Dashboard header uses two rows below 1200px and the existing single row from 1200px. Both navigation groups retain their content width without horizontal scrolling. Actual authenticated localhost verification passed all 21 combinations of 320/375/390/430/768/1024/1200px and Engineering/Project/Design. The 1200px title and navigation geometry matches the pre-change live baseline. Perspective/subpage switching and reload memory passed. This supersedes the earlier isolated Header fixture evidence.

The full JS gate initially exposed a test-loader compatibility failure: work-group-integration.test.js replaced unmapped imports with an empty object. Its explicit dependency mapping now loads the real inventory-atomic module and related pure modules; unknown dependencies fail immediately with a named error. Existing assertions remain unchanged, with one added missing-dependency test. No production fallback was added.

Final gate: targeted Work Group tests 39/39; full JS 479/479; local and Candidate rollback SQL/RLS; six two-session concurrency cases with observed lock waits and fixture cleanup; fresh local baseline plus all six migrations, SQL/RLS and initialization; git diff --check; tsc --noEmit; npm run build:verify — all PASS. The isolated .next-verify build leaves the running .next development output intact. Two existing React Hooks lint warnings in DateDualInput.tsx and useRowAutosave.ts remain outside this scope.

Result: **FINAL GATE PASS; Production release is a separate subsequent step.** Phase B remains paused. At completion of this gate Production was untouched and no commit/push had occurred. Branch `feat/maintenance-material-usage-phase-b`, worktree `C:\Vibecode\maintenance-material-usage-phase-b`, release parent `bb451a68f7272cd51bf1de3df9d84f2a5d9f58ef`.
