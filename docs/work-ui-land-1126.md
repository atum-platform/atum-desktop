# Work UI land (2026-11-26)

Owner, 2026-11-26: "i see the Work UI is still ugly as before? Not done yet? already requested it?"
The 11-25 Work fixes were built but sat on unmerged branches, so the installed test app (0.20.55) still
showed the old Work: an inner "Work" header with its own hide button inside Atum's panel, folder chips,
a tinted notice over the greeting.

## What this branch is

`feat/work-ui-land-1126` = `origin/main` + `feat/work-panel-layout-1125` (which contains
`feat/kit-t3-step5-1125`). Conflicts, resolved toward main's newer behaviour:

- `src/matrix/destination-requests.ts`, `src/matrix/app.tsx`: main replaced the branch's `$matrixLastChat`
  with the persistent `last-chat.ts`; that atom is dropped. The branch's `$matrixComposerAsk` (Drive's
  "Ask Atum about it") is kept, with its import.
- `src/app/work/work-screen.tsx`: main's Google write-proposal line above the view is kept; the comment
  takes the branch's panel-frame description (host fills the main column, the view draws two cards).

Paired runtime branch: atum-work `feat/work-ui-land-1126` (merges `feat/work-panel-layout-sync-1125` onto
`feat/work-runtime-0.1.16`, then fixes the remaining differences from Chat in the Atum theme CSS: filled
search, no duplicate pencil, no folder chips/filter/crumb in Work mode, notice never over the greeting; see
that repo's `docs/work-ui-land-1126.md`). The desktop shows the new look only with a Work runtime archive
built from that branch.

## Verification

`npm run typecheck` 0; eslint on the changed files 0 errors; vitest `src/app/work src/app/atum
src/matrix/app.test.tsx src/matrix/drive.test.tsx src/matrix/team-space/channel-overview.test.tsx
src/matrix/playground electron/matrix/drive-ipc.test.ts electron/work electron/matrix/main-work.test.ts`:
2775 passed, 10 skipped. Live: the playground's Work host
(`matrix-playground.html?evidence=1&work=ready&workView=<dev Work URL>`) with the runtime branch's dev web
UI, light and dark. Evidence: `~/.atum/operations/evidence/work-ui-1126/` (`before/`, `after/`).
