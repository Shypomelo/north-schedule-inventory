# Workspace Perspectives V1 — HOLD

Date: 2026-09-11. Candidate only; no release, push, merge, remote migration or Production write.

## Blocking decisions

1. **Authoritative membership edge case:** existing Foundation policy `member_work_groups_active_read` hides memberships belonging to inactive work groups from non-admin readers. The new selector correctly uses all rows it receives, but cannot distinguish a genuinely unconfigured ENGINEERING member from one whose only memberships were hidden by RLS. Consequently that edge case can incorrectly invoke the legacy ENGINEERING fallback. The proposed candidate-only read-policy expansion was **rejected by auto-review** because exposing inactive-group memberships changes a security boundary. It was **not applied or bypassed**. Approval or a revised product contract is required before declaring this feature fully complete. Active-group membership scenarios are covered and pass.
2. **Browser review unavailable:** Google OAuth automation remains AUTOMATION BLOCKED per the user's manual confirmation. No retry occurred. This new worktree was tested without real Supabase/Google credentials. At `http://127.0.0.1:3002/login`, the dev server returned HTTP 200 but the browser stayed on `系統載入中...`; no login card or interactive elements rendered. The exact internal cause of that loading state has not been established. No App Auth changes were made to get past it.
3. Authenticated acceptance is **MANUAL UI REVIEW REQUIRED**. A configured, authenticated disposable/test App environment is still required to exercise new persistence/UI together; a PostgreSQL SQL-test cluster alone is not a Supabase Auth/PostgREST server. Do not apply these migrations to Production merely to unlock review.

The `vercel:verification` skill's first-broken-boundary stop condition ended browser verification at the Login loading state. This is not a claim of App Auth FAIL. Browser loading-state geometry is not a Login or Dashboard PASS.

## Requested 55-item report

Here `PASS (code/test)` means the named code/unit/SSR/SQL evidence passed; it does **not** mean authenticated browser acceptance passed.

| # | Item | Result |
|---|---|---|
| 1 | Baseline | PASS: local origin/main `4095e7704500cb27e95295fa9da0197e08f3b451`; checkpoint ancestry and clean dual worktree verified before creation |
| 2 | Starting HEAD | `45ca66be7220ef53af8b3e5e74aa7838a0e4b319` |
| 3 | New branch/worktree | `feat/workspace-perspectives-v1`; `C:\Vibecode\workspace-perspectives-v1` |
| 4 | Perspective schema | New `dashboard_views`, `member_dashboard_views`, three seeds; separate from role/position/work group |
| 5 | Admin assignment | PASS (SQL and code); atomic INVOKER RPC, invalid/inactive assignment rollback tested |
| 6 | ADMIN all-view access | PASS (unit); assignment checkboxes never restrict ADMIN |
| 7 | ADMIN management menu | PASS (static); existing role condition retained independently of perspective |
| 8 | Default resolver | PASS (unit); admin-selected default, engineering fallback only for no configuration, assigned-active-view restriction; no automatic DB writes |
| 9 | Engineering View | PASS (code/regression); original Today/progress/Todo structure reused; manual UI pending |
| 10 | Project Management View | PASS (code/SSR); personal Today + whole-project milestones + PROJECT TEAM Todo; manual UI pending |
| 11 | current_nodes | PASS (unit); all IN_PROGRESS/BLOCKED, else minimum incomplete batch |
| 12 | next_nodes | PASS (unit); next incomplete batch beyond maximum current order, ties retained |
| 13 | Design View | Implemented; code/SSR tests pass; full browser functional review pending |
| 14 | Two-zone workbench | PASS (SQL/SSR); two active columns, no empty third |
| 15 | Three-zone workbench | PASS (SQL/SSR); over-three rejected; removal safely requires destination for items |
| 16 | Timeline | PASS (unit/static); received/start/due/completed day fields; no dependency engine |
| 17 | Todo promotion | PASS (Foundation SQL + adapter contract); original RPC, source linkage, stored status, repeated promotion denial |
| 18 | Direct inline edit | PASS (executable in-memory events); Enter, Esc, IME, blur, Ctrl+Enter, payload whitelist |
| 19 | Mobile inline edit | Shared touch-accessible component, event tests PASS; real mobile browser review pending |
| 20 | Participant-group visibility | PARTIAL / HOLD: active-membership cases pass; inactive-group RLS ambiguity remains |
| 21 | PROJECT owner + ENGINEERING assistant | PASS (synthetic selector test); real TEST record was not read or modified |
| 22 | Owner badge | Existing owner-based presentation untouched; regression PASS; visual review pending |
| 23 | Google ownership-only eligibility | Existing server tests PASS; participant visibility does not invoke Google or enable sync |
| 24 | Date trace | Legacy DateDualInput used past-date cutoff to label planned dates actual; other displays were partly explicit |
| 25 | Checkpoint date correctness | PARTIAL |
| 26 | Canonical date semantics | PASS (unit/regression): shared `presentBusinessDate`, explicit actual/completed flags |
| 27 | Past incomplete never actual | PASS (unit); remains planned + overdue |
| 28 | Sync rename | PASS (static); `同步模板新增項目`, existing refresh RPC remains unchanged |
| 29 | Rebuild preview | PASS (SQL/unit/static); counts + required stale-resistant preview token |
| 30 | Dynamic phases | PASS (SQL/SSR/static); snapshot names/order rendered; CONSTRUCTION still uses semantic key |
| 31 | Old phase restriction | Template editor was already data-driven; no enum rewrite required; renderer ordering updated |
| 32 | Business progress preserved | PASS (real SQL): status, planned/actual dates, notes preserved |
| 33 | Removed template history | PASS (SQL/code): archived_at, no deletion, history disclosure, excluded from current and drag order |
| 34 | Custom milestones | PASS (SQL): snapshots and original numeric sort order retained with deterministic display ties |
| 35 | New migrations | `20260911052802_workspace_perspectives.sql`; `20260911054254_workflow_framework_rebuild.sql` |
| 36 | Migration tests | PASS: Foundation rehearsal plus 20 perspective assertions and 15 populated-workflow upgrade/rebuild assertions on PostgreSQL 17.11 |
| 37 | Changed files | Listed below; package manifests, lockfile, App Auth and released Foundation migration unchanged |
| 38 | Commits | Listed below; normal commits only, no amend/rebase/reset/force push |
| 39 | Targeted tests | 52/52 new JS tests; 35 candidate SQL assertions; existing relevant regressions included in full suite |
| 40 | All JS tests | 289/289 PASS |
| 41 | git diff --check | PASS |
| 42 | tsc --noEmit | PASS |
| 43 | Production-mode build | PASS locally; never deployed; existing DateDualInput hook warning retained |
| 44 | Responsive/static verification | SSR/static layouts and touch contracts PASS; all seven browser widths HOLD (only loader measured) |
| 45 | Browser status | CLI 0.37.1 and runtime launch PASS; Google OAuth AUTOMATION BLOCKED; Login remained loading |
| 46 | Manual UI remaining | All authenticated flows and seven widths listed below |
| 47 | Production DB writes | NO |
| 48 | Production business data writes | NO; Production membership writes also NO |
| 49 | Production Google mutation | NO |
| 50 | Production deploy | NO; no merge/push/release |
| 51 | Original dirty worktree touched | NO |
| 52 | Final worktree clean | Verify using final `git status --short`; local logs/cache/disposable DB are gitignored |
| 53 | Revertability | Original checkpoint untouched. Candidate commits are separate; revert dependent App commits before their shared helpers/schema. Not claiming arbitrary-order dependency-free reverts. No DB rollback is required on Production because nothing was applied there. |
| 54 | Final HEAD | See final handoff / `git rev-parse HEAD` (the review document cannot embed its own commit hash) |
| 55 | Final judgment | **HOLD**, not READY FOR UI REVIEW or Release |

## Commits

- `6c14c04` — Perspective schema, ADMIN assignment, sidebar/provider, atomic owner-zone configuration.
- `a97ac09` — Canonical dates, workflow batches/archive support, safe rebuild preview/RPC and real SQL tests.
- `a919914` — Project dashboard, Design workbench, shared inline Todo editing.
- `98cbc4e` — Schedule participant-group visibility; ownership unchanged.
- Final review/test commit — new 52-test suite, inactive-view assignment validation and local cache ignore rules, this report.

## Actual browser evidence

| Width | Observed document width | Horizontal overflow | Login card | Acceptance |
|---:|---:|---:|---|---|
| 390 | 390 | 0 | absent | HOLD |
| 402 | 402 | 0 | absent | HOLD |
| 430 | 430 | 0 | absent | HOLD |
| 768 | 768 | 0 | absent | HOLD |
| 1200 | 1200 | 0 | absent | HOLD |
| 1440 | 1440 | 0 | absent | HOLD |
| 1920 | 1920 | 0 | absent | HOLD |

Only the loading screen was measured. No OAuth button clicked, no credentials entered, no cookies/session copied, no new auth bypass, no other browser tooling installed. No Login responsive changes were made.

## Manual UI checklist (390 / 402 / 430 / 768 / 1200 / 1440 / 1920)

- ADMIN/non-admin perspective availability/defaults, switching without changing role/position/work groups; management menu retained for ADMIN.
- Engineering Dashboard preserved; Project dashboard parallel current/next batches and existing Project Detail navigation.
- Design: assigned projects only, zero-zone setup, 2/3 zones, rename/reorder/removal destination, item dates/status, timeline, inline editing and Todo promotion.
- Both Schedule tabs, existing tasks, week/month, detail, add/edit field behavior, true owner badge, cross-group participant visibility.
- My Todo global, TEAM Todo ownership-only, mobile navigation and horizontal overflow.
- Rebuild preview/confirmation/stale preview; dynamic phases and construction embedding; archived/custom/progress preservation.
- Mutations only in an authenticated disposable/test backend. Production-connected review must remain read-only; existing Project Detail fields can save on change, so do not type into those fields during Production review.

## Reproduce local tests safely

The session used `C:\Vibecode\tools\postgresql-17.11\bin` and a newly created, loopback-only cluster at `.codex-logs/perspectives-pg`, port **55440**, populated with synthetic `example.test` members. It is not the earlier `workflow-rls-pg` cluster and contains no Production export.

Against a newly initialized empty disposable DB only:

```powershell
psql -X -h 127.0.0.1 -p 55440 -U postgres -d postgres -v ON_ERROR_STOP=1 -v KEEP_SCHEMA=1 -f supabase/tests/workgroup-workbench-foundation.sql
psql -X -h 127.0.0.1 -p 55440 -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/workspace-perspectives.sql
psql -X -h 127.0.0.1 -p 55440 -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/workflow-framework-rebuild.sql
node --test src/lib/*.test.js
npx.cmd tsc --noEmit
```

The Foundation rehearsal commits only its local synthetic baseline. Both candidate SQL suites roll back, can be rerun, and test the real released migration files without editing them. New migration files were created using already-cached official Supabase CLI 2.117.0. No global/package.json/package-lock installation was performed. Existing project dependencies were installed from the unchanged lockfile using `npm ci --ignore-scripts`.

The new SQL functions use invoker security and existing authorization helpers, following the [Supabase database-function guidance](https://supabase.com/docs/guides/database/functions). No new SECURITY DEFINER functions or expanded table privileges were introduced for rebuild. Existing Foundation test fixture helpers reproduce the older definer contract only inside disposable SQL fixtures.

## Changed files relative to 45ca66b

```text
.gitignore
docs/workspace-perspectives-v1-review.md
src/app/admin/users/page.tsx
src/app/layout.tsx
src/app/page.tsx
src/app/schedule/page.tsx
src/app/todos/page.tsx
src/components/ConstructionProgressSection.tsx
src/components/DashboardViewContext.tsx
src/components/DateDualInput.tsx
src/components/DesignWorkbench.tsx
src/components/MemberDashboardViewEditor.tsx
src/components/ProjectOverviewCards.tsx
src/components/ProjectWorkflow.tsx
src/components/SidebarV3.tsx
src/components/TodoInlineText.tsx
src/components/WorkflowRebuild.tsx
src/lib/construction-progress.test.js
src/lib/construction-workflow-ui.test.js
src/lib/dashboard-perspectives.ts
src/lib/date-presentation.ts
src/lib/db/perspective-adapter.ts
src/lib/db/poc-supabase.ts
src/lib/db/types.ts
src/lib/db/workbench-adapter.ts
src/lib/engineering-responsibilities.ts
src/lib/project-workflow.test.js
src/lib/project-workflow.ts
src/lib/schedule-selectors.ts
src/lib/test-load-ts.cjs
src/lib/utils/date-utils.ts
src/lib/workbench.ts
src/lib/workspace-perspectives.test.js
supabase/migrations/20260911052802_workspace_perspectives.sql
supabase/migrations/20260911054254_workflow_framework_rebuild.sql
supabase/tests/workflow-framework-rebuild.sql
supabase/tests/workspace-perspectives.sql
```
