# Atum Kit on T3, step 5: the remaining gaps (2026-11-25)

Owner decisions 2026-11-24 (option B, Atum's icons, plus menus, "go with your recommendations", "make them match").
Closes the known gaps listed in `docs/kit-t3-step4-1124.md`. Paired atum-work branch: `feat/kit-t3-sync-step5-1125`.

## What changed

1. **The assistant's card in Chat's right panel** (`matrix/assistant-info-panel.tsx`). An assistant's own chat
   opens with its card beside it, as a person's chat opens with theirs (layout r2 §2). The panel holds the
   real `AssistantCard`, the one the sheet shows (`placement="panel"`), so the primary assistant keeps every
   row other assistants have plus its own (main badge, Check-ins) and nothing is hidden. Only the sheet's
   chrome goes: Done (the panel's × closes) and Message (you are in the chat). The primary has no Delete row
   in either place, because it is never retired. What the chat opens (a document, the desk) still lives in the
   workbench. The toggle reopens the workbench while it holds tabs, and the desk path is unchanged
   (`conversationInfo` stays null for assistant rooms). A card panel opened in a chat now closes on Drive,
   Store or Team Space instead of leaving that chat's workbench beside them. It reopens on return.
2. **Faces and pins in the Team Space channel overview** (`team-space/channel-overview.tsx`). Members show as up
   to six circles (people are circles) with "+N" for the rest, beside Add people. Pinned messages (up to three,
   sender and two lines) appear only when something is pinned. A click jumps to the message, or to its
   thread. Data comes from the open room's Matrix snapshot (`members`, `pinnedMessages`) through
   `workspace.tsx`. Nothing new is fetched.
3. **Drive folder panel: Share and "Ask Atum about it"**.
   - Share: `MatrixDrive.share()` in main resolves the open folder itself and shows macOS's own share menu
     (`ShareMenu`, as `electron/main.ts` already does for Office exports). No path or id comes from the window
     (`drive-ipc.ts` takes `{ kind: 'share' }` only). Off macOS it reveals the folder in the file manager.
   - Ask: goes to the primary assistant's chat with "About the folder “Atum Drive › …”: " in its box. The
     person finishes the question; nothing is sent. The words travel in a one-shot atom
     (`$matrixComposerAsk`, `destination-requests.ts`) that the open chat's composer takes through its own
     `edit()`. Main's Drive task path still accepts files only (`drive.ts` `mode !== 'create'` ⇒ file). A
     folder is named by its place, never attached.
4. **Work's ← → step T3's own history first.** atum-work's sidebar report now carries `back` / `forward` from T3's
   `navigationHistory.ts` (the Navigation API T3's own arrows use), and `workCommands.ts` runs `history.back` /
   `history.forward`. The desktop adds both to `WORK_BAND_COMMANDS`, parses the two optional booleans in
   `parseWorkSidebar`, and `useWorkHistoryArrows` (`app/work/work-band.tsx`) registers them with
   `setMatrixNavLocal`, as Drive does with its folders. At T3's first page, ← → fall through to the window's
   places.

## Decisions made this round

- The assistant card fills the panel as the sheet draws it, including the long "What does Atum help you
  with?" field. Parity was the owner's rule, so no rows were trimmed for the panel.
- "Ask Atum about it" names the folder rather than attaching it. A folder-wide task input would be a new main
  capability with its own size and consent questions, which this step does not open.
- Share uses the system share menu, so Atum adds no share UI of its own.

## Known gaps

- Chat's last conversation still isn't persisted across relaunch (r2 §3 gap, unchanged).
- atum-work's change was not typechecked locally: no checkout on this Mac has its dependencies installed, and
  free disk (about 7 GiB) was below the floor for a pnpm install. The diff is 3 files and about 20 lines and
  calls T3's existing `navigationHistory.ts` helpers. Its CI is the check.
- Work's ← → has no screenshot, because the playground's Work is a fixture without T3's router. The behaviour is
  covered by `app/work/work-history.test.tsx`.

## Verification

See the commit message. Evidence: `kit-step5-1125/` (light and dark: chat-assistant-card, team-space-overview,
drive-folder-panel, drive-ask-result), captured from the real playground on fixture data.
