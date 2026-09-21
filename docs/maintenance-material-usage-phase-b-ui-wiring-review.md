# Phase B UI wiring review — 2026-09-21

Result: **PASS — READY FOR PHASE B LOCAL UI REVIEW**

Scope: repair the real Schedule maintenance completion entry. This is a targeted UI wiring review, not production release approval or a repeat of the full Phase B backend acceptance suite.

## Localhost source confirmed before editing

- URL: `http://localhost:3000/schedule`, real authenticated application.
- Worktree: `C:\Vibecode\maintenance-material-usage-phase-b-integration`.
- Branch: `feat/maintenance-material-usage-phase-b-integration`.
- HEAD: `9b99ef38b7c7f9b2f234d64a107cc0346de00045`.
- Port 3000 listener PID 2808 → Next launcher PID 27488 → managed dev owner PID 23164.
- Next launcher command points to this worktree. `scripts/next-process.mjs` explicitly starts Next with this project's root as its working directory. The dependency junction resolves into another worktree's `node_modules`; this does not change the application source directory.
- Local environment targets Candidate `fssogssryeunkjkdgewx`; external side effects are disabled. Production was not used.

## Root cause

The Schedule card opens `ScheduleTaskFormDialog` → `ScheduleTaskForm`. Its visible `任務狀態 → 完成` control was a radio option. Saving followed `handleCreateOrUpdateTask` → `updateScheduleTaskWithActivity`, bypassing the shared Phase B completion UI.

The previous implementation connected Schedule's right-click `COMPLETE_TASK` path and Dashboard's `ScheduleTaskDetail` completion path. It omitted the ordinary Schedule edit form that the user actually opened.

The live task type value and displayed option are both `維修`. Existing semantic normalization handles surrounding regular/fullwidth spaces. This failure was missing wiring, not a string/enum mismatch.

## Changes in this UI repair

- `src/components/ScheduleTaskForm.tsx`: an existing maintenance schedule's completion control invokes the optional shared completion callback. Non-maintenance controls retain the existing radio/save flow. Completed, viewer, and submitting states prevent completion. Unsaved changes stay in the editor and prompt the user to save first, avoiding completion against stale project data.
- `src/components/ScheduleTaskFormDialog.tsx`: forwards the callback.
- `src/app/schedule/page.tsx`: resolves the persisted schedule and opens the existing `MaintenanceCompletionModal`; successful completion closes the editor and refreshes the list. Editor and completion modal use distinct keys. No duplicate completion component was introduced.
- `scripts/test-maintenance-ui-wiring.cjs`: five targeted UI wiring regression tests.

Earlier uncommitted Phase B changes remain in the worktree. Dashboard, the completion modal, database adapter/types, serial selector, and migration were checked against hashes captured before this repair and were unchanged by this repair.

## Real authenticated localhost verification

| Path / action | Observed result |
| --- | --- |
| Existing unfinished maintenance card → edit form → 完成 | Shared dialog displays `完成維修` and `＋使用物料`. The existing business task was not completed. |
| Disposable maintenance card → edit form → 完成 | Same dialog; adding a material row works; removing it and cancelling returns to the editor. |
| Disposable maintenance card → right-click → 完成 | Same shared dialog. Cancelled without completion. |
| Dashboard maintenance list → task detail → 完成 | Same shared dialog. Cancelled without completion; Dashboard code unchanged in this repair. |
| Disposable maintenance card → edit form → 完成 → 確認完成, zero material rows | Completion succeeds; completed checkmark persists after reload; reopening shows the completion action disabled. |
| Non-maintenance construction card → edit form → 完成 | Existing status radio behavior; no maintenance dialog. Cancelled without saving. |

One disposable Candidate schedule named `PHASE-B-UI-WIRING-0921` was created for the no-material completion check. It was deleted through the real UI afterward; a fresh authenticated tab confirmed it is absent from the normal schedule list. The application's normal soft-delete/audit history remains. No inventory usage was submitted and no existing business schedule was completed.

## Verification and boundaries

- `node --test scripts/test-maintenance-ui-wiring.cjs`: **5/5 PASS**.
- `git diff --check`: **PASS**.
- `node node_modules/typescript/bin/tsc --noEmit`: **PASS**.
- Full suite / build / DB tests: **not run in this repair**.
- DB schema / migration / RPC / canonical inventory / RLS / grants / serial selector / Dashboard changes in this repair: **NO**.
- Candidate business-data writes: one disposable UI test schedule, completed without materials and then deleted as described above.
- Production changes: **NO**.
- Commit: **NO**. Push: **NO**.
