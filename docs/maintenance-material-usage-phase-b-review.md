# Phase B Maintenance Material Usage

Result: **BLOCKED on browser UI verification only**. Implementation and development checks described below are complete. Real localhost UI cases A–G have not been executed; do not treat HTTP or Node checks as browser acceptance.

## Baseline

- Fetched `origin`; `origin/main` and worktree HEAD are `9b99ef38b7c7f9b2f234d64a107cc0346de00045`.
- Branch: `feat/maintenance-material-usage-phase-b-integration`.
- Worktree: `C:\Vibecode\maintenance-material-usage-phase-b-integration`.
- Fresh worktree from origin/main; no reset, reuse of dirty changes, commit, or push.
- Matching package-lock SHA256: `4D48FB1A918E3009077EA81912B43C2842531D1C95139FE5659A36370341BC80`. Windows Junction shares existing node_modules; package files unchanged.
- Production latest migration: `20260920010308_inventory_client_maintenance_grants`; preceding convergence migration `20260920010301_inventory_canonical_grant_convergence`. Production checked read-only.
- Candidate: `fssogssryeunkjkdgewx`; verified `review_private.environment_guard` and `candidate_review_production_shape_baseline`.
- Candidate and Production canonical OUT function MD5 both `04455adfbc37cce57e66489c49c97a55` before implementation. Candidate function remains unchanged afterward.

## Canonical API calibration

1. Released top-level API: `public.write_inventory_transaction_atomic(text,jsonb,jsonb,uuid,text,timestamptz)`, action `CREATE`, transaction type `OUT`.
2. Internal helpers: `app_private.inventory_actor`, `inventory_effective_balance`, `inventory_audit`, `inventory_transaction_serial_snapshot`, plus existing history helpers. Item/serial locks and ledger insert remain inside the public writer.
3. No extraction or replacement needed: this PostgreSQL function is safely callable from another function in the same transaction. Phase B calls it directly, and never catches its errors to continue processing.
4. Existing completion: `completeScheduleTaskWithActivity` → adapter `updateScheduleTask` → `public.schedule_tasks.status='完成'`, plus a separate activity log. Both maintenance completion entry points now use the shared atomic RPC instead. Other schedule types retain existing behavior.
5. Baseline had no Schedule-to-Inventory relation. The only new ledger relation is nullable `inventory_transactions.schedule_task_id`.
6. `schedule_tasks.project_id` is nullable **text**, not UUID. The wrapper resolves the live, nondeleted `projects` row by its UUID text representation; Inventory receives the resolved UUID and its canonical writer captures `project_name`.
7. Schedule completion source of truth is `status='完成'` (legacy `已完成` also recognized). There is **no `schedule_tasks.completed_at` column**. Completion timestamp is recorded in the existing activity log; no speculative Schedule column was introduced.

## DB and atomic integration

- Repo/Candidate migration: `20260921131242_maintenance_material_usage_phase_b.sql`. Created with CLI, then filename aligned to the version assigned by Candidate apply_migration.
- Migration SHA256: `39771328AB54A9AF9A18C90D09AFB079793CD9C729BEAEB1401ECBD250211FD2`.
- `schedule_task_id uuid NULL` → Schedule FK with `ON DELETE RESTRICT`; hard deletion cannot erase or detach ledger history. Existing Schedule soft deletion remains possible.
- Partial Schedule lookup index; partial unique `(schedule_task_id,item_id)` for `transaction_type='OUT'`, `is_voided IS NOT TRUE`, `excluded_by_initialization_id IS NULL`, and nonnull relation. There is no ledger `deleted_at` predicate to invent.
- New RPC: `complete_maintenance_with_inventory_usage(uuid,jsonb)`.
- Uses the existing actor helper, locks the Schedule row, validates maintenance/state/material structure/project, then acquires all requested item mutexes in UUID order. Each canonical OUT retains existing quantity, balance, serial, cutoff, audit, and atomicity logic.
- Attaches the returned transaction to the Schedule and records a relation/serial snapshot through `inventory_audit`. After all OUTs succeed, updates Schedule status and records completion in existing `activity_logs`. Any failure rolls everything back.
- Empty materials produce zero ledger transactions. The existing completion audit includes an execution marker for safe retries of empty-material completion; no second ledger or execution table.
- Completed + existing Phase B OUT/execution returns the existing result. A completed legacy Schedule without either conflicts. Reopened schedules with a prior execution also conflict. Different retry payloads cannot append OUTs.
- SECURITY DEFINER with fixed empty search_path; authenticated EXECUTE only, anon/PUBLIC revoked. Existing actor verification rejects Viewer/inactive/nonmember callers. No Inventory client mutation grants were opened.
- Advisor recognizes the intentionally authenticated SECURITY DEFINER endpoint; existing unrelated advisories remain unchanged. The new function has no mutable-search-path finding.

## Maintenance UI

- Dashboard Schedule detail completion and Schedule context-menu completion share `MaintenanceCompletionModal` and `createMaintenanceCompleter`.
- Compact optional material rows, quantity/unit, remove/new row, duplicate-item prevention, in-flight submission guard, clear stock/project/conflict errors.
- Serial list loads through the same Inventory adapters and uses existing `getAvailableSerialsFIFO`, `filterAvailableSerials`, `findExactAvailableSerial`, and no-match helper. Filtering preserves selection, selected serials can be removed, and the DB remains authoritative.
- No-material completion is available even if optional inventory lookup fails.
- Existing completed rows cannot reopen the editable completion flow. A committed completion followed by a refresh failure explicitly reports that completion succeeded and freezes its material form.
- `MaintenanceUsageView` queries the canonical ledger relation and displays quantity/unit/serials in Dashboard detail and Schedule day detail. No material edit/delete/RETURN/correction controls.

## Verification

| Check | Result |
| --- | --- |
| Targeted Node + existing serial selector | 8/8 PASS |
| Phase B SQL/RLS on disposable local PostgreSQL | PASS |
| Same SQL/RLS on Candidate | PASS |
| Cases 1–8, 10–13 | PASS: empty/plain/multiple, rollback, serials, retries, missing project, wrong type, Viewer, usage query |
| Extra SQL cases | PASS: final Schedule-update failure reverses serial OUT/link/project; empty retry; legacy-completed conflict; duplicate item; invalid quantity/count; anonymous/nonmember denial; Admin success; direct ledger grant denial; actual unique-index rejection; FK history retention |
| Concurrency / case 9 | 5/5 PASS with actual observed lock waits |
| git diff --check | PASS |
| tsc --noEmit | PASS |
| localhost `/`, `/schedule` | HTTP 200; dev compilation successful |
| Real browser UI A–G | **NOT RUN / BLOCKED**: browser inventory empty; `iab` and `chrome` unavailable |

Concurrency uses a new disposable PostgreSQL cluster, loopback port 55447, replayed canonical migrations and a minimal Schedule baseline. Tests exercise two entries on one Schedule, empty retries, competing stock across schedules, reversed item order, and conflicting retry payloads. Two idempotent success responses represent **one** execution, not two writes. Remote Candidate SQL/RLS additionally exercises its actual schema, triggers, grants and policies. The disposable PostgreSQL server was stopped after testing; the Next.js dev server remains running.

Commands:

```text
node --test scripts/test-maintenance-usage.cjs scripts/test-inventory-serial-selector.cjs
node scripts/test-maintenance-concurrency.cjs
psql ... -v ON_ERROR_STOP=1 -f supabase/tests/maintenance-material-usage.sql
git diff --check
node node_modules/typescript/bin/tsc --noEmit
```

No full suite, production build, Final Gate, commit, push, deployment, or Production mutation was performed.

## Candidate cleanup and next step

Candidate migration is applied. SQL fixtures were transactional and rolled back. Local concurrency fixtures were explicitly cleaned and zero remaining fixture rows verified. Candidate before/after row counts and hashes match for Schedule, ledger, serials, links, batches, items, audit and Auth IDs; see `maintenance-material-usage-phase-b-evidence.json`.

Candidate `.env.local` was verified as Candidate-only with `DISABLE_EXTERNAL_SIDE_EFFECTS=true`. Dev server remains at `http://localhost:3000` for review. Production untouched: **YES** (read-only baseline inspections only). Commit: **NO**. Push: **NO**.

Next required step: connect an available browser, log into Candidate, and execute user-requested real UI A–G through both completion entry points. Until then the overall result remains **BLOCKED**, not a claimed UI PASS or release readiness.
