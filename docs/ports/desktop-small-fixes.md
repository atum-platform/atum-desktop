# Desktop small fixes (failed-turn status, prepared updates)

Two independent desktop fixes. Neither changes a contract or a server.

## Failed turns read as Atum system status

- A failed turn is platform state, not words the assistant wrote. Desktop now
  publishes it as an `m.notice` (it was `m.text`) and keeps the closed code under
  `io.atum.result.status = failed` (`src/matrix/publish-result.ts`). Real answers
  stay `m.text`.
- The chat bubble shows Atum's neutral sentence for a notice whose code is
  `failed` ("Atum couldn’t complete this request. Please try again.", five
  locales in `shared/matrix-agent-status-copy.ts`) instead of the body's
  fallback. Every other status notice keeps its own body: those bodies carry
  details the bare code does not (the device a turn resumes on, the attachment
  kind, the devices a cut-off turn may have used).
- The mobile design snapshot's copy for `failed` changes with it
  (`packages/mobile-design-exports/dist/Localizable.xcstrings`; the manifest hash
  is the file's SHA-256).

## Prepared (staged-swap) updates are the default

- `stagedSwapEnabled` (`electron/atum-staged-swap/store.ts`) is now on unless
  `updates.json` holds a literal `updates.stagedSwap: false`. Missing, malformed
  and older settings files get the prepared path. The opt-out stays the
  per-Mac rollback switch. Only packaged Apple-silicon builds use it.
- The staged updater has already prepared the new copy before Restart, so it
  sets `showRestartFeedback = false` and the desktop updater skips the blocking
  restart window for it. Cancel/fail only close a window that was opened
  (`electron/desktop-updater.ts`).

## Verification

From `apps/desktop`: `npm run typecheck` (pass) and
`npx vitest run shared/matrix-agent-status-copy.test.ts src/matrix/message.test.ts
src/matrix/publish-result.test.ts electron/atum-staged-swap electron/desktop-updater.test.ts
src/matrix/app.test.tsx` (10 files, all pass).

Built, not released.
