# Phase B equipment maintenance — local review

Result: **PASS — READY FOR EQUIPMENT MAINTENANCE LOCAL UI REVIEW**.

This report supersedes the completion-coupled Phase B review and UI wiring report. No Final Gate, commit, push, build, full suite, or Production operation was performed.

## Environment and conversion

- Worktree: `C:\Vibecode\maintenance-material-usage-phase-b-integration`.
- Branch: `feat/maintenance-material-usage-phase-b-integration`; HEAD `9b99ef38b7c7f9b2f234d64a107cc0346de00045`.
- Real UI: authenticated Chrome at `http://localhost:3000`, Schedule and SE supply pages.
- Candidate only: `fssogssryeunkjkdgewx`; verified `review_private.environment_guard` and Candidate baseline before mutations.
- KEEP: ledger `schedule_task_id`, FK/lookup index, canonical OUT, audit and rollback composition.
- MODIFY: business RPC, adapter, modal, record list, detail/form wiring, regression tests.
- REMOVE: schedule/item active-OUT uniqueness, completion-gated material form, general consumables, completed-schedule registration denial.
- Original applied migration `20260921131242_maintenance_material_usage_phase_b.sql` remains byte-for-byte unchanged (SHA256 `39771328ab54a9af9a18c90d09afb079793cd9c729beaeb1401ecbd250211fd2`).

## Database

Candidate migration history and local filenames agree:

1. `20260921143119_maintenance_equipment_records.sql`: independent business events, explicit equipment marker, optional reviewed SE→Inventory serial FK, shared candidate resolver, search/register RPCs, RLS/grants, old RPC revoke, source protection.
2. `20260921144354_maintenance_equipment_identity_recheck.sql`: include identity labels in selection version; reject conflicting FK/text identities and duplicate SE rows; acquire canonical item mutex before resolving item eligibility.

`maintenance_equipment_records` contains request/project/schedule/source IDs, typed Inventory and SE FKs, model/serial snapshots, replaced_at, notes, actor and creation time. The three source combinations are CHECK-constrained. request_id, inventory_transaction_id and se_supply_record_id provide event-level uniqueness; there is no permanent uniqueness on a serial's lifetime.

Active members can read; direct authenticated insert/update/delete is not granted. Registration uses existing editor membership checks. The old completion-with-materials RPC is no longer executable by authenticated clients.

Exactly 18 existing serialized inverter/optimizer codes from the supplied inventory workbook are marked. No prefix/category inference, Router, general consumables or ambiguous R800-NORTH inclusion. Unconfirmed equipment remains unmarked. SE-only sources do not require Inventory item mapping.

## Source identity and transaction behavior

- One server resolver is shared by search and registration. The client applies substring/case-insensitive serial/model/item-name filtering, without changing source eligibility.
- Whole-string trim/case equality or a reviewed FK resolves identities. Partial/short matches never establish identity.
- BOTH is one result retaining both source IDs. Duplicate supply serials, model/project conflicts, uncertain unit identity, quantity > 1, and unavailable Inventory counterparts cannot be submitted.
- Search returns an identity version; registration locks and rechecks it. A stale candidate cannot silently register a different identity.
- The RPC serializes request retries, locks the schedule and SE source, and composes the existing canonical writer with source updates, event insertion and audit. The SE table lock also prevents ordinary SE insert/edit from introducing an identity phantom during registration. Its duration is limited to this business transaction; Inventory's item/transaction/serial algorithm is unchanged.
- Inventory registration is quantity=1, project from the persisted schedule, with ledger schedule_task_id attached in the same transaction.
- SE replace_date uses the Asia/Taipei date of replaced_at. Procurement/receipt fields and receipt history are untouched.
- Actual replaced_at can be historical. Inventory transaction_date is the current Asia/Taipei registration date, with all existing monthly/cutoff guards intact. If today's posting is disallowed, the entire registration fails.
- No schedule status mutation occurs during equipment registration. Completed schedules remain eligible.
- Add/view only. Referenced SE identity cannot be changed beneath an existing event; no equipment edit/delete/RETURN/correction UI is added.

## Real localhost verification

One dedicated schedule `設備維修驗收 EQ-UI-0921`, one fixture Inventory item, four Inventory serials, and three SE sources were used. Existing business schedules/devices were not consumed.

| Case | Result |
|---|---|
| Unfinished maintenance card → edit form | Equipment records and add action visible without completing |
| Inventory-only search/register | Source 庫存; immediate OUT and event |
| SE-only search/register | Source SE供貨; no Inventory OUT; actual SE page displays 已更換 |
| BOTH | One search result; one registration creates OUT, updates original SE record and creates one event |
| Add equipment | Schedule remained unfinished until its independent completion action was clicked |
| Complete schedule → supplement | Add action still works; another device of the same item registered |
| Reload | All four registered events persisted and displayed, including notes and sources |
| Unavailable Inventory + unfinished SE | Single disabled BOTH result with 需確認; confirmation disabled without an eligible selection |
| Historical datetime | BOTH event shows 2026-08-01 14:20 Taipei and SE replace_date 2026-08-01; completed supplement shows 2026-09-20 15:10; all three maintenance OUTs post on 2026-09-21 |

The date control was verified against the persisted event, not only its visible input value. It reads the native datetime value on submit so changes survive other form edits.

The Schedule form and Dashboard task detail use the same records component. Completion no longer invokes an equipment modal. Unsaved schedule edits prompt a save before opening equipment registration against the persisted schedule.

## Verification

- Targeted Node: **8/8 PASS** — `node --test scripts/test-maintenance-usage.cjs scripts/test-maintenance-ui-wiring.cjs`.
- SQL/RLS: **PASS** on isolated local PostgreSQL and Candidate — `supabase/tests/maintenance-equipment.sql`, all fixtures BEGIN/ROLLBACK.
- SQL includes specified CASE 1–13 plus stale identity, duplicate SE, model mismatch, reviewed FK, unmarked-item fallback denial, mismatched request retry, historical/current posting separation, anon/direct-write denial.
- Rollback injection: canonical OUT failure, SE update failure after OUT, event insertion failure, and final event audit failure all leave no partial event/SE/OUT result.
- Concurrency: **5/5 PASS**, independent LOCAL psql sessions with observed `wait_event_type=Lock`. Same request BOTH retry; same BOTH serial across schedules; competing SE-only; equipment vs ordinary canonical OUT; same schedule/item with distinct devices. No claim of concurrent Candidate HTTP testing.
- `git diff --check`: **PASS**.
- `tsc --noEmit`: **PASS**.
- No full suite / build / Final Gate.

## Cleanup and boundary

Candidate UI fixture items/tasks/SE sources/events/transactions: **0** after guarded cleanup. SQL fixtures: **0**. Local concurrency fixtures: **0**. Final Candidate negative balances: **0**. Production untouched: **YES**.

The original Phase B SQL/concurrency entry points now route to the equipment suites. Earlier review files remain historical evidence.

Commit: **NO**. Push: **NO**.
