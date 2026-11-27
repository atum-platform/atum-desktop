# New assistant: a roster row, never hidden by Protons (2026-11-27)

Owner, 2026-11-27: "the create new assistant button is not in the plus icon menu for me … proton
should not block it … it should be at the bottom of the assistant section in the chat roster, not
in the plus menu."

## Root cause

The renderer gated New assistant on `snapshot.assistant && snapshot.agentCreation`.
`snapshot.assistant` is the primary's *local* Matrix login (`apps/desktop/electron/matrix/main.ts`,
`assistant: primary?.identity`, set only when a local host starts with an enrollment, ~11111).
A cloud-only primary never has one, so a multi-agent cloud account saw no New assistant even
though main had `agentCreation = true` (its log showed "agents synced: 4 other agents").
Main's own create/hire guards never required it. Protons played no part in the hiding.

## Change

- `matrixCanCreateAssistant` (`src/matrix/roster-create.tsx`): signed in + `agentCreation`.
- `NewAssistantButton` (`src/matrix/agent-roster.tsx`) is now a quiet roster row: circle dashed
  "+" where the avatar sits, the `newAssistant` copy, row height/padding/hover/focus of the
  roster's rows (`atum-row`, `data-roster-row` for arrow-key walking). `app.tsx` passes it through
  the roster's existing `agentActions` slot, so it ends the Assistants section.
- Removed from the "+" menu. The Start a chat sheet's footer keeps its New assistant action
  (not named by the owner; it stays as is).
- Short of Protons on a hire: the sheet's hire band turns into "Not enough Protons" with
  **Top up Protons** (the shared `openMatrixTopUp`, Store top-up or the payments page) and
  **Not now**. It no longer shows a failure or opens the top-up by itself. No price or billing
  change.

## Verification

Typecheck, eslint (0 errors), vitest on new-assistant, roster-create, roster-conversations,
listing-hire, agent-profile, vietnamese-copy-guard and app suites. Playground screenshots in
light and dark: `~/.atum/operations/evidence/roster-new-assistant-1127/`.
