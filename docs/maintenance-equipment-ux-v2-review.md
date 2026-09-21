# Equipment Maintenance UX V2 — Candidate / localhost review

Result: **PASS — READY FOR EQUIPMENT MAINTENANCE LOCAL UI REVIEW**.

Branch: `feat/maintenance-material-usage-phase-b-integration`.
Worktree: `C:\Vibecode\maintenance-material-usage-phase-b-integration`.
HEAD: `9b99ef38b7c7f9b2f234d64a107cc0346de00045`.
Date: 2026-09-21. Existing dirty work preserved. No reset/clean/discard/commit/push/build/full suite.

This report supersedes the earlier add/view-only and UI-selection review where their behavior differs.

## SE cross-project

- Cross-project is now explicit confirmation, not a source identity conflict. The server returns original SE project, maintenance project and `cross_project`; UI and RPC both require confirmation.
- A valid `project_id` is authoritative. Without an ID, only an unambiguous exact project-name match avoids confirmation; missing/uncertain names remain selectable with confirmation.
- SE `project_id` / `project_name` are preserved. Events use the persisted Schedule project; SE `replace_date` uses the Asia/Taipei business date. Audit records confirmation and both project contexts.
- Duplicate SE identities, quantity > 1, unavailable Inventory counterparts, conflicting model/FK/short-key identities remain blocked. Editing a current source rechecks ownership and duplicate identities too.

## Compact UI and records

- Equipment and quantity share a row, then model, scoped serial search, actual replacement time and optional notes.
- Serial results are compact two-line rows, capped at 160px with internal scrolling. Exact count and scope-reset rules remain. Single-device selection can replace the previous choice with one click.
- Date defaults to now for new entries and the saved value for edits. Notes start collapsed, including an “已有內容” indicator for existing notes.
- Group key: exact `model_snapshot` + normalized `replaced_at` instant + `source_type`. `request_id` is per device, so it is not treated as a batch ID. This is presentation grouping only.
- Groups default collapsed, showing model × count and date/source once. Expand reveals serials, relevant notes and each record’s 修改 action. New and edit share one modal; project/Schedule cannot be edited there.

## Atomic correction

Candidate forward migration: `20260921153442_equipment_maintenance_ux_v2.sql`. Local filename matches the applied Candidate migration version.

- Event revision/updated actor/time support stale-edit rejection. A private request journal stores immutable retry responses; repeated requests do not reapply stock movements. No direct authenticated event mutation is granted.
- Existing SE date ownership must be proven from original event audit during migration; unprovable ownership fails the migration. New registration establishes ownership only after the atomic SE update. Corrections verify the owned date before restoring or moving it.
- Locks follow schedule → event → SE table/source → sorted Inventory items → transaction → serials. Existing canonical Inventory writer is reused unchanged.
- Inventory→Inventory calls canonical EDIT; old serial restores, replacement serial goes OUT, ledger ID remains linked.
- SE→SE restores old owned replace_date to NULL and updates the new original SE row.
- Inventory→SE calls canonical VOID and retains the voided ledger history; SE→Inventory calls canonical CREATE OUT.
- BOTH transitions compose both sides, event and audits in the same DB transaction. Any error rolls everything back.
- Inventory EDIT retains the original posting date. New OUT posts today. Actual replacement time is separate; existing month-close/cutoff guards remain enforced, including date-only edits involving Inventory.
- Audit appends before/after events, original/new SE snapshots, canonical transaction and cross-project confirmation. No audit rewriting or business-record hard-delete endpoint.
- Standalone “作廢紀錄” UI: **deferred**. Canonical VOID is used internally only when a correction removes the Inventory source.

## Verification

| Check | Result |
| --- | --- |
| Targeted Node | 22/22 PASS: selector, compact notes/date, cross-project confirmation/reset, edit revision/identity payload, grouping/render path and existing regression tests |
| SQL/RLS | Existing equipment regression suite PASS on local PostgreSQL and Candidate, fixtures rolled back |
| Correction atomic | PASS on local and Candidate: Inventory→Inventory, SE→SE, Inventory↔SE, SE→BOTH, BOTH→SE, actual-date/posting separation, month-close denial, idempotency, stale revision, ownership, duplicate source, anon/viewer/direct-write denial |
| Failure injection | Event write, SE update, final audit and canonical VOID rollback paths leave no partial event/Inventory/SE changes |
| Concurrency | 7/7 PASS with independent LOCAL psql sessions and observed lock waits: five existing races plus same correction request retry and competing stale-revision corrections |
| TypeScript | `npx.cmd tsc --noEmit` PASS |
| Diff | `git diff --check` PASS |
| Real UI | Authenticated actual App at `http://localhost:3000/schedule`; no isolated page used |

Commands:

```text
node --test scripts/test-maintenance-equipment-selection.cjs scripts/test-maintenance-ui-wiring.cjs scripts/test-maintenance-usage.cjs scripts/test-maintenance-record-groups.cjs
node scripts/test-equipment-concurrency.cjs
psql -v ON_ERROR_STOP=1 -f supabase/tests/maintenance-equipment.sql
psql -v ON_ERROR_STOP=1 -f supabase/tests/maintenance-equipment-correction.sql
npx.cmd tsc --noEmit
git diff --check
```

## Real localhost evidence

Dedicated temporary task `[UXV2] 設備維修驗收`, item `EQ-UXV2-0921`, five Inventory serials and three SE rows were used. Business devices were not consumed.

1. Initial modal measured about 406px tall in a 760px viewport. Equipment/quantity shared a row, notes were collapsed, no serial cards appeared initially. Visual screenshot inspected.
2. Three Inventory devices registered through the real UI. Summary was `EQ-UXV2-0921 ×3 / 09/21 23:40 · 庫存`; serials and 修改 appeared only on expansion.
3. Edited `UXV200001-AA` to `UXV200004-AA`, added a note, and saved through the UI. DB confirmed old serial 在庫, new serial 已出庫, revision 2, unchanged ledger ID and correction audit.
4. Cross-project `UXV2SE001-AA` was selectable; submission stayed disabled until explicit confirmation. Original SE project remained NULL / `UXV2 原供貨案場`; maintenance event used the Schedule’s project and audit recorded the cross-project context.
5. Edited that SE event to BOTH `UXV200005-AA` and actual time 2026-08-01 14:20. Old SE replace_date returned to NULL; new SE date became 2026-08-01; Inventory posting stayed 2026-09-21.
6. Reloaded the App and reopened the task. Both groups were collapsed; expanding showed corrected serial `UXV200004-AA`, its note, and BOTH `UXV200005-AA` at 08/01 14:20.
7. Also selected the existing real SE `7515CA50-A4` / 李正治 without submitting. It was enabled, showed both original/current projects, and submission required confirmation. Cancelled; original replace_date remains NULL.

Desktop real-App layout was visually inspected. No separate mobile-device emulation was performed.

## Candidate cleanup / boundaries

- Candidate only: `fssogssryeunkjkdgewx`, verified `review_private.environment_guard = CANDIDATE_REVIEW` before changes.
- UI fixtures, fixture audits/request responses/ledger rows, SQL fixtures and local concurrency fixtures cleaned: **0 remaining**.
- Existing business equipment events: **4 retained**. Final checked Inventory linkage violations: **0**; negative balances: **0**. Existing 李正治 SE project/date unchanged.
- Original applied Phase B migrations preserved; only one new forward migration added.
- Production untouched: **YES**. Commit: **NO**. Push: **NO**.

Security advisors were reviewed before/after. The private retry journal intentionally has RLS with no policies and no client grants (deny all). New authenticated SECURITY DEFINER RPC notices are intentional endpoints with active-member/editor checks and fixed empty search_path, tested against anon/viewer/direct writes. Existing mutable-search-path, pg_net placement and leaked-password notices are outside this change. References: [function security/privileges](https://supabase.com/docs/guides/database/functions), [RLS without policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [authenticated function advisor](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).

## Final release gate — 2026-09-22 Asia/Taipei

User local UI acceptance: PASS. This checkpoint precedes commit/push and Production migration.

- Canonical `node scripts/test-js.mjs`: 474/474 PASS; equipment targeted tests: 22/22 PASS.
- Candidate Inventory canonical/grants, equipment SQL/RLS, Schedule audit RLS and correction/idempotency suites: PASS, transaction fixtures rolled back.
- Local independent-session concurrency: 7/7 PASS, fixtures cleaned.
- Fresh local database `phase_b_final_20260922`: existing Inventory/Schedule/SE baseline, eight canonical/grant migrations and all four Phase B migrations replayed successfully. Initialization, equipment and correction SQL tests passed against the resulting database. This is the relevant migration chain, not an unrelated whole-application bootstrap.
- `git diff --check`, `npx.cmd tsc --noEmit`, `npm.cmd run build:verify`: PASS. Build used `.next-verify`; three non-blocking hook lint warnings remain (DateDualInput, MaintenanceEquipmentModal, useRowAutosave).
- Candidate final baseline `20260921153442`: fixture residual 0, negative Inventory 0, serial/item mismatch 0, equipment link mismatch 0. Five legitimate equipment records retained, including the SE record created during human acceptance. Initialization retained and canonical writer MD5 unchanged (`04455adfbc37cce57e66489c49c97a55`).
- Remote main before release: `9b99ef38b7c7f9b2f234d64a107cc0346de00045`; ancestry safe. Production pre-release DB baseline: `20260920010308`.
- Vercel connector preflight could not retrieve the project: declared `projectId` input was rejected internally as missing `idOrName`; team list was empty. This is an API interface/tool limitation, not a confirmed HTTP 403. No deployment was triggered through that connector.
