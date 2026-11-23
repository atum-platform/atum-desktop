# Chat presentation: bubble times and machine noise

Owner asks (2026-11-18), on PR #82 (`feat/chat-message-actions`):

1. Times inside the bottom-right of sent and received bubbles, like Telegram.
2. No machine-like commentary in chats: no tool logs such as "📚 Reading skill
   content-strategy", no canned lines with internal IDs such as
   "I updated your schedule (routine-<UUID>). You can see it in your schedule
   list." Natural interim remarks from the agent stay.

## Bubble times (desktop, this repo)

- `apps/desktop/src/matrix/app.tsx` (`MatrixEventMessageBubble`) builds one
  corner per bubble: "edited" (if any), `<time>` from the Matrix event
  timestamp (`matrixClock` / `matrixFullTime` tooltip, unchanged), then on your
  own messages the sending clock (`role=status`, "Sending") while the message is
  still going, and nothing after the time once the server has it.
- Placement: inside the text bubble (absolute, bottom right); on the size line of
  a file card (`MatrixFileCard` `meta`); under a deleted message or a bot photo.
  Team Space (flat) keeps its header and hover-gutter times. Status lines,
  working lines and check-in cards get no corner.
- No overlap: `--matrix-meta-room` (per message, in the corner's own `ch`) sizes
  an invisible `::after` spacer at the end of the last paragraph/list item
  (`data-matrix-meta-flow` = `plain` | `markdown`, `src/styles.css`). Content
  ending in anything else (code block, table, quote, bot text, Chief of Staff
  answer card) gets `padding-bottom` so the corner has its own row.
- Receipts (`src/matrix/send-state.tsx`): one read signal only — the readers'
  faces under the message (`data-matrix-seen`, labelled "Seen"/"Seen by N").
  The bubble used to carry a Sent tick (sr-only "Sent") on your newest message
  and a double tick once a read receipt named it; both were removed (owner
  2026-11-19: the faces and the ticks said the same thing twice). A message
  nobody has read yet shows just its time, as in any messaging app; the state
  stays announced through the faces' `aria-label`.
- The under-bubble run time (`data-matrix-run-time`) and the hover-toolbar time
  are gone for bubbles; every bubble now shows its own time.

## Tool-status noise (source)

Hermes's messaging gateway posts a status message per started tool when
`display.tool_progress` resolves to anything but `off` for the platform
(`gateway/display_config.py`: `display.platforms.<p>.<key>` → `display.<key>` →
platform tier; Matrix registers tier `medium` = `new`). The desktop and the cloud
controller write `MATRIX_NARRATION_DISPLAY` with a global `tool_progress: 'all'`
(needed by tui_gateway's `tool.start`, which reads only the global key,
`tui_gateway/agent_factory.py` `_load_tool_progress_mode`), so the Matrix gateway
inherited `all` and posted "📚 Reading skill …" lines. Fix:
`MATRIX_NARRATION_DISPLAY.platforms.matrix.tool_progress = 'off'`
(`apps/desktop/shared/matrix-turn-style.ts`). Interim remarks
(`interim_assistant_messages: true`) and commentary stay on; the typing row's
working line comes from the presentation extension's codes
(`plugins/platforms/matrix/PRESENTATION.md`). No assistant text is filtered.

A Mac home gets the full profile once (`ensureMatrixFullHermes`), so existing Mac
homes keep their old display block until re-provisioned; cloud turns write the
configuration afresh every turn once the controller picks up this constant.

## Private seams (not in this repo)

- Cloud controller `packages/cloud-controller/src/executor/hermes-control.ts`
  (`cloudConfig`) imports the private copy of `MATRIX_NARRATION_DISPLAY`; it needs
  the same `platforms.matrix.tool_progress: 'off'` (and its test literal in
  `test/hermes-control.test.ts`).
- The schedule line was a controller notice (private
  `packages/cloud-controller/src/host-authority/publications.ts`). Since
  2026-11-21 schedule changes publish silently: an occurrence waits on the exact
  enabled revision having been published before its slot, not on a chat notice,
  and no owner-visible line is sent.

## Roster preview and Watch (2026-11-21)

- An assistant's working line is redacted by its own sender with the reason
  `Turn ended` (`MATRIX_TRANSIENT_REDACTION_REASON`) when the turn settles. The
  transcript already treated that as transient (`removedWorkingLine` in
  `src/matrix/message.ts`); the roster preview (`src/matrix/room-preview.ts`)
  read it as a deletion, so every assistant row said "Message deleted". The
  preview now skips it and shows the message before it. Any other deletion
  still previews as "Message deleted".
- The working line's Watch button is hidden (`DESK_WATCH_SHOWN = false` in
  `src/matrix/app.tsx`) until a cloud agent's screen can be watched. The desk
  panel and its wiring stay; flip the constant to bring Watch back.
- Verified: `npx vitest run src/matrix/room-preview.test.ts` (17 pass, one new),
  `npx tsc -p . --noEmit` clean.

## Verification (2026-11-18)

- `npx tsc --noEmit -p tsconfig.json` and `-p tsconfig.electron.json`: clean.
- `npx eslint` on touched files: 0 errors (pre-existing warnings only).
- `npx vitest run src/matrix/app.test.tsx src/matrix/message-actions.test.tsx
  shared/matrix-turn-style.test.ts electron/matrix/hermes-setup.test.ts
  src/app/atum/design-contract.test.ts`: all pass.
- `node packages/atum-kit/scripts/build.mjs --check`: dist current.
- Not verified: visual layout in the running app (jsdom has no layout).
