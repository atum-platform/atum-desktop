# Store to Chat navigation

Owner report (2026-11-24): Store could not return to Chat, including through
Team space. Status: implemented locally; integration and installed-app acceptance
remain with the coordinating release.

The rail already gives Store and Chat separate destinations. In MatrixAccountView,
selectDefaultConversation returned immediately whenever a personal room was
selected, without checking whether the visible destination was Store or an app.
The playground's discoverApps retains roomId (playground/bridge.ts), so Chat sent
no select command and Store stayed open. A native SDK Store snapshot instead
clears roomId; Chat then selected the default assistant rather than the previous
personal conversation. The older rail test covered only that default conversation
with roomId cleared.

Chat now sends the existing select command when an app/Store destination is
visible. A small nanostore in destination-requests remembers the last personal
Chat, scoped by account and device, without storing transcript content. Return
navigation validates that the remembered room is still joined in the current
roster; otherwise it uses the existing default-room resolution. Team Space rooms
are excluded. Store/app snapshots never overwrite that memory. Other rail
screen state and the SDK remain unchanged.

The Matrix app integration tests exercise all 25 ordered transitions (including
same-screen clicks) across Chats, Store, Team space, Atum Drive, and Work, for
both retained-room and cleared-room Store snapshots. Each return to Chat keeps a
non-default personal conversation and repeated sync snapshots preserve the
chosen screen. The two new tests failed before the fix; the focused rail group
passes all 10 tests after it.

Verification:

- Before fix: two regression tests fail, exit 1.
- Focused Matrix rail group: 10 passed, exit 0.
- Full Matrix app plus rail/shell/navigation/document-action suites: 484 passed
  across 8 files, exit 0.
- Desktop npm run typecheck (boundary, renderer, consumer browser, Electron,
  E2E TypeScript): exit 0.
- ESLint for touched TypeScript: exit 0, existing warnings remain.
- git diff --check: exit 0.
- Shared dependencies are symlinked; checkout footprint about 370 MB.
- After git fetch origin main, python3 scripts/public_guard.py --base origin/main
  --head HEAD: exit 0 (9 new commits; ancestry, paths, identifiers, secrets,
  metadata passed). Rechecked after recording this result.

No push, PR, CI, deployment, release build, or nested agent was started.
