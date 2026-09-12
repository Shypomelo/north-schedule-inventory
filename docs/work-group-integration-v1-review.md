# Work Group Integration V1 — UI review candidate

## Version boundary

- Branch: feat/dual-schedule-google
- Production App / origin/main: 4095e7704500cb27e95295fa9da0197e08f3b451
- PRE_WORKGROUP_INTEGRATION_HEAD: 12bf94df248c535c12a5d76abc734439b1f66fc0
- Initial state: clean; ahead 1 / behind 0. Existing dual-schedule commit retained.
- Foundation: 20260910011827_workgroup_workbench_foundation (unchanged).
- This integration is a new commit after the above boundary; it can be reverted independently.
- No release, merge, deployment, migration, Production membership/business/Google writes.

## Implemented contracts

- Existing member_work_groups adapter: authenticated client, ADMIN preflight, Foundation RLS and partial unique default index retained.
- Admin Users has an independent active-member workspace section with membership checkboxes and one default radio group. Roles, legacy category and positions are not repurposed.
- Saving memberships uses multiple checked requests (not a DB transaction). Additions are non-default first, old default is cleared before setting the new default, removals are last. Partial failure is explicitly reported; reload and review before retrying. No best-effort rollback overwrites concurrent administrator edits.
- One shared resolver selects active default, deterministic membership by group sort_order/key/id, then ENGINEERING compatibility fallback. The fallback never writes rows.
- Schedule initial tab uses that resolver; both tabs stay accessible. Existing edits retain work_group_id; current primary/collaborator rules and Google eligibility remain intact.
- TEAM Todo queries filter scope and group before the existing 50-row limit. Schedule loads each group's TEAM list separately. Dashboard remains ENGINEERING TEAM only; PRIVATE My TODO remains global.
- New TEAM Todo payloads explicitly include group; new PRIVATE payloads explicitly use NULL. Todo conversion in the existing entry points inherits the source group, never the actor's default.
- Dashboard and /todos use one touch-accessible text-edit dialog and one text-only mutation helper. Metadata/status/creator/group and converted Schedule are not edited. Existing TEAM DB history remains authoritative; PRIVATE history remains excluded.
- Login changes are limited to device viewport and shrinkable responsive layout. Google OAuth/Auth implementation is unchanged.

## Verification evidence

- New fixture integration suite: 31/31.
- Targeted Work Group / Schedule / Todo / Dashboard / Google / responsive suites: 110/110.
- All src/lib JS tests: 237/237.
- TypeScript noEmit: PASS.
- Production build: PASS (build process used isolated dummy/no-service credentials, not Production data).
- Existing DateDualInput useEffect dependency warning remains unchanged.
- git diff --check: PASS.
- Fixture tests execute membership writes and Todo create/edit against an in-memory query double, not Supabase.
- PROJECT CREATE / UPDATE / DELETE tests execute the sync route with fixture dependencies: zero Google client calls, zero failed-sync DB writes; request-side forged ENGINEERING group does not override persisted PROJECT eligibility.
- These checks do not claim live Production RLS mutation tests or authenticated browser acceptance.

## Unauthenticated Login browser evidence

agent-browser 0.37.1, local /login, height 900. No OAuth click or login attempt.

| Width | Document scrollWidth | Card width | Button font | Overflow elements | Result |
| --- | --- | --- | --- | --- | --- |
| 390 | 390 | 358 | 16px | 0 | PASS |
| 402 | 402 | 370 | 16px | 0 | PASS |
| 430 | 430 | 398 | 16px | 0 | PASS |
| 768 | 768 | 448 | 16px | 0 | PASS |
| 1200 | 1200 | 448 | 16px | 0 | PASS |
| 1440 | 1440 | 448 | 16px | 0 | PASS |
| 1920 | 1920 | 448 | 16px | 0 | PASS |

390 and 1440 screenshots were visually inspected. Screenshots remain only in gitignored .codex-logs.
Authenticated automation: AUTOMATION BLOCKED by Google's prior automated-browser rejection, not App Auth FAIL.

## Manual UI review required

Use normal authenticated Chrome at http://127.0.0.1:3000.
Check widths 390 / 402 / 430 / 768 / 1200 / 1440 / 1920.

1. Admin Users membership/default controls, active-member layout and distinction from roles/category/positions.
2. With disposable/local data: no membership fallback, PROJECT default initial Schedule, multi-membership default, manual tab switching.
3. Engineering existing data; Project empty state; week/month/detail/add/edit; existing Schedule group read-only; primary candidates and cross-group collaborators.
4. TEAM Todo group selector, explicit new group, global PRIVATE list; Todo conversion inherits source group.
5. Desktop/mobile text editing, long text, keyboard, converted-record notice; title/content only; no hidden metadata/status changes.
6. Dashboard cross-group Today Schedule and badge, Engineering TEAM only, project progress, PRIVATE Todo, mobile tabs.
7. Hamburger and left-edge swipe; no unintended horizontal page overflow.

If localhost connects to Production: read-only review only. Do not confirm membership save, Todo save, Schedule creation/edit/cancel or any other business mutation.
Use fixtures or disposable/local test data for actual mutation validation.
Local server is launched with Google Calendar and service-role variables disabled at process level; the gitignored .env.local file is not altered.

## Changed files

- src/app/admin/users/page.tsx
- src/app/layout.tsx
- src/app/login/page.tsx
- src/app/page.tsx
- src/app/schedule/page.tsx
- src/app/todos/page.tsx
- src/components/MemberWorkGroupEditor.tsx
- src/components/TodoForm.tsx
- src/components/TodoTextEditDialog.tsx
- src/hooks/useWorkGroups.ts
- src/lib/db/index.ts
- src/lib/db/poc-supabase.ts
- src/lib/db/types.ts
- src/lib/db/work-group-adapter.ts
- src/lib/dual-schedule.test.js
- src/lib/engineering-dashboard.test.js
- src/lib/responsive-layout.test.js
- src/lib/todo-text-actions.ts
- src/lib/work-group-integration.test.js
- src/lib/work-groups.ts
- docs/work-group-integration-v1-review.md

Status: WORKGROUP INTEGRATION READY FOR UI REVIEW. No release authorization implied.
