# Work: the open thread in the title bar, New in one place (2026-11-27)

Follow-up to the consistency audit (`docs/consistency-audit-1127.md`, rows 9 and 13), stacked on PR #147
(`feat/consistency-audit-1127`) because both touch `app/work/work-band.tsx`. Paired with atum-work
`feat/atum-layout-consistency`, whose view now draws its own plus menu (New thread, New thread in a
worktree, Add project) and reports the open thread on the existing sidebar report.

## Contract

The view's sidebar report (`window.atumWork.reportSidebar` → `matrix:work:sidebar-changed`) gains an optional
`thread`:

- absent: an older runtime. The title bar keeps "Work" and its own + (`WorkRosterControls`);
- `null`: a newer runtime with no thread open. "Work", and no title-bar +;
- `{ title, repo?, branch? }`: a newer runtime with a thread open. The title reads "name · repo · branch",
  with repo and branch in the muted ink, and the full line as its tooltip. No title-bar +.

The field's presence is the capability: atum-work shipped the plus menu and the field in the same commit,
so no version check is needed. Until the view's first report the band shows no +, so a newer view never
flashes a second one; a bridge that cannot report at all keeps the +.

`parseWorkOpenThread` trims the strings, caps each at 500 characters and drops empty repo or branch. A
thread without a title names no thread (null).

## Changes

| Change | Where |
|---|---|
| `WorkSidebarSnapshot.thread`, `WorkOpenThread`, `parseWorkOpenThread`, `workViewHasNewMenu` | `apps/desktop/shared/matrix-work.ts` |
| `WorkTitle` names the thread | `apps/desktop/src/app/work/work-band.tsx` |
| The band's + only for views without their own menu | `apps/desktop/src/app/work/work-screen.tsx` |
| Playground `workThread=<name>\|<repo>\|<branch>` (or `none`) stands in for a newer view's report | `apps/desktop/src/matrix/playground/work-fixtures.ts` |

## Verification

Run in `apps/desktop` (exit codes read directly):

| Check | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | rc 0 (incl. the client boundary check) |
| lint | `npx eslint <changed files>` | rc 0, 0 errors, 0 warnings |
| focused | `npx vitest run src/app/work` | 6 files, 65 passed |
| wider | `npx vitest run src/app/work src/app/atum src/matrix/playground electron/work electron/matrix/main-work.test.ts` | 102 files passed (2 skipped), 1737 tests |
| public guard | `python3 scripts/public_guard.py --base origin/main --head HEAD` (repo root) | see the commit's lane report |

New tests: `work-history.test.tsx` (thread parsing; the capability), `work-screen.test.tsx` (name · repo ·
branch and no band + for a newer view; "Work" without a thread; an older view keeps "Work" and the +, and
no + shows before the first report).

Screenshots (playground with the real atum-work view, light and dark):
`~/.atum/operations/evidence/work-consistency-1127/after/desktop-{older,newer}-view-*.png`.
