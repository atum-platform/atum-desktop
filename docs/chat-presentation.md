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
  own messages the sending clock (`role=status`, "Sending") or the receipt tick.
- Placement: inside the text bubble (absolute, bottom right); on the size line of
  a file card (`MatrixFileCard` `meta`); under a deleted message or a bot photo.
  Team Space (flat) keeps its header and hover-gutter times. Status lines,
  working lines and check-in cards get no corner.
- No overlap: `--matrix-meta-room` (per message, in the corner's own `ch`) sizes
  an invisible `::after` spacer at the end of the last paragraph/list item
  (`data-matrix-meta-flow` = `plain` | `markdown`, `src/styles.css`). Content
  ending in anything else (code block, table, quote, bot text, Chief of Staff
  answer card) gets `padding-bottom` so the corner has its own row.
- Receipts (`src/matrix/send-state.tsx`): `matrixReceiptTick` gives one tick on
  your newest message once sent (with sr-only "Sent"), two ticks when a read
  receipt names the message; the readers' faces (`data-matrix-seen`, labelled
  "Seen"/"Seen by N") stay under it. The double tick is Phosphor `checks`, added
  to `packages/atum-kit/icons.json` and its generated `dist/phosphor-icons.json`.
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

## Verification (2026-11-18)

- `npx tsc --noEmit -p tsconfig.json` and `-p tsconfig.electron.json`: clean.
- `npx eslint` on touched files: 0 errors (pre-existing warnings only).
- `npx vitest run src/matrix/app.test.tsx src/matrix/message-actions.test.tsx
  shared/matrix-turn-style.test.ts electron/matrix/hermes-setup.test.ts
  src/app/atum/design-contract.test.ts`: all pass.
- `node packages/atum-kit/scripts/build.mjs --check`: dist current.
- Not verified: visual layout in the running app (jsdom has no layout).
