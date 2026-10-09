# UI Integration Loop 2 — Candidate verification

Branch: `feat/ui-integration-loop1` (based on `7c03168`). Candidate project: `fssogssryeunkjkdgewx`. Production project: `dghozkqvxlwpjmgleekw` (untouched).

## Candidate migrations

1. `20261009070532_ui_integration_loop2_core.sql`: verified database owner identity; owner-only inventory preview/initialization and activity read; scoped activity RPC; toolbox creator/RLS and personal order; shared project work-item positions; milestone contractor and equipment registration.
2. `20261009071535_ui_integration_loop2_reorder_fix.sql`: fixes JSON key concatenation found by the first Candidate sort test.
3. `20261009072009_ui_integration_loop2_atomic_project_progress.sql`: one transaction for project form writes and construction progress rows.
4. `20261009073251_ui_integration_loop2_stale_order_guards.sql`: rejects stale project/toolbox order submissions after advisory locking.

The local filenames match the versions recorded by Candidate. Candidate already contains separate SolarEdge migrations not present on this branch; none were copied into this worktree.

## Verified in Candidate

- OWNER identity matches the protected team-member record, its enabled protection trigger, and the Auth account. OWNER can read the activity table and preview initialization. A JWT with the owner email but a different Auth user ID is not OWNER.
- A transactionally simulated non-owner ADMIN cannot preview or initialize inventory, read the full activity table/RPC, or see another user's PERSONAL tool. ADMIN can edit shared tools and still read the four existing deleted-schedule logs through the narrow RPC. The fixture role change was rolled back and checked.
- USER direct activity table read returns zero rows; scoped task history returns five existing entries and inventory transaction history two. A new activity insert without `RETURNING` succeeds and its own row is readable via the SELF RPC. The insert was rolled back.
- VIEWER with a department membership can create PERSONAL, DEPARTMENT, and GLOBAL tools. Creator is captured by the insert trigger. Another user cannot edit/delete the shared tool or read the personal tool; members in another department cannot read the department tool. All fixtures were rolled back.
- Two users can save different mixed toolbox orders. A stale submission is rejected; global `sort_order` remains unchanged. The original one-argument RPC is no longer executable by authenticated callers.
- Mixed milestone/construction drag order persists in the shared position table. Incomplete and stale payloads are rejected without changing rows. Template refresh appends a newly added milestone and keeps all prior positions. Tests were rolled back.
- Equipment registration's planned date does not complete it. Explicit completion and cancellation work without changing the meter milestone. Milestone contractor update resolves its name without changing construction rows. Tests were rolled back.
- Project create and update with construction progress succeed together. Invalid later progress operations roll back the project write. All transient test rows were rolled back.
- Existing Candidate tools: 3 before/after; construction progress: 34 before/after; activity logs: 100 before/after; inventory items: 41, serials: 138, transactions: 37, initializations: 1 after. Milestones: 184 before, 193 after (nine new equipment rows); shared order references: 227. No transient test project remains.

## Code verification and remaining gates

- `npx tsc --noEmit`: pass after an isolated offline `npm ci`; the earlier ZXing error came from missing packages in the original shared dependency directory. Both ZXing packages are in the lockfile.
- `npm run build`: pass. Existing unrelated React hook warnings remain.
- Relevant workflow, toolbox, work-group, and schedule history tests: 145 pass; the focused workflow refresh test: 1 pass.
- A clean migration replay was not run because the local Docker daemon was unavailable and Candidate already has data and additional migrations. Candidate did apply all four migrations successfully and the final schema objects/policies were checked.
- Live multi-session race testing was inconclusive because the Candidate SQL connector serialized the attempted sessions. Advisory locks, stale-position rejection, and rollback were verified in transactions.
- Signed-in browser UI acceptance remains for drag interactions, equipment editing in the metered list, OWNER-only navigation, and toolbox editing across real accounts. The worktree has no Candidate UI credentials; the other checkout's local environment points to Production and was not used.

Production database and deployment were not modified. No release or merge was performed.
