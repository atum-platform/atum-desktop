# Work opens in place; Chat reopens the last conversation

Owner reports (2026-11-24): Work "sweeps out from the left. No other screen behaves this way."
"Chat screen should not have an empty state. Navigating back to it should show last convo."
Status: implemented locally on `fix/work-sweep-chat-restore-1124` (from the 0.20.56 head
`5f5454ec`); integration and installed-app acceptance stay with the coordinating release.

## Work sweep

Cause: opening Work hides Atum's left panel. The panel ran its 160 ms collapse, the Work host
region grew leftwards with it, and `useWorkViewPlacement` moved the native T3 view on every frame.

Fix, adopting T3's own rule (`usePanelNavigationSuppression`: no panel motion on a route change):

- `AtumShellFrame` takes the current `screen`. A panel (roster slot, compact drawer, split
  workspace) that opens or closes in the same render as a screen change does so instantly: no
  entering/exiting phase, and `data-atum-motion-instant` turns the CSS transitions off. A change
  on the same screen (the sidebar toggle) still animates. `matrix/app.tsx` passes the rail
  destination as `screen`.
- `placeOwnerView` (`electron/work/surface/place-view.ts`) sets the native view's bounds before
  attaching it to the window. Before, a detached view was attached first and painted for a frame
  at its stale (preload, full-window) bounds.

## Chat restore

The 0.20.56 memory of the last Chat lived in an in-memory atom. It is now
`$matrixLastChatByAccount` (`matrix/last-chat.ts`), a `persistentAtom` keyed by Matrix user id,
storing room ids only (`atum.desktop.lastChatByAccount.v1`).

- Launch, a cleared selection, and pressing Chats all open `matrixChatRoomToOpen`: the
  remembered chat while it is still a joined personal conversation (not Team Space, not a former
  assistant's read-only history), else the primary agent's conversation, including a cloud-only
  primary with no local enrollment (previously launch needed `snapshot.assistant`).
- With no agent at all, pressing Chats still opens the latest conversation; a launch leaves that
  choice to the person.
- The roster's launch landing prefers the remembered chat over Trợ lý.

An existing test changed meaning: when main clears the selection, Chat now returns to the last
conversation (Morgan) rather than the assistant. That is the owner's rule.

## Verification

- New shell-frame tests fail on the old `shell-frame.tsx` (2 of 17) and pass after (17/17).
- `npx vitest run src/matrix src/app/atum src/app/work electron/work/surface`: 495 files,
  8204 tests passed, exit 0 (before the final lint-only edits); rerun of the Matrix app,
  atum, work, surface and last-chat suites after them: 73 files, 2048 passed, exit 0.
- `npm run typecheck` (boundary, renderer, consumer browser, Electron, E2E): exit 0.
- ESLint on touched files: 0 errors; `app.tsx` keeps its 3 pre-existing warnings.
- `git diff --check`: exit 0. Shared dependencies symlinked; no install.
- After `git fetch origin main`, `python3 scripts/public_guard.py --base origin/main --head HEAD`:
  exit 0 (10 new commits; ancestry, paths, identifiers, secrets, metadata passed).

No push, PR, CI, deployment or nested agent.
