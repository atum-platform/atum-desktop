# Atum Kit on T3, step 4: the rest of the layout (2026-11-24)

Owner decisions 2026-11-24: "go with your recommendations" on the layout spec (owner evidence
`layout-language-1124/r2/LAYOUT.md`), option B (T3's design system as the Kit base, Phosphor kept), Add friends at
the foot of Chat, New is a plus menu, the bell is removed. Follows `docs/kit-t3-step3-1124.md`.

## What changed

1. **The bell is gone; its items live on the account face.** `matrix/attention-indicator.tsx` now exports
   `MatrixAttentionSection` (the same rows and in-place details the bell's list had: another device asking for
   approval, a sign-in elsewhere, this Mac's damaged device, an assistant's stopped listening, out of Protons,
   Update Atum…), `useMatrixAttentionSummary` (count, label, marker) and `MatrixAttentionAnnouncer` (the polite
   live region, kept mounted on the rail). `matrix/rail-account.tsx` draws the section at the top of the account
   face and a red dot on the face while an item waits; the face carries `data-matrix-attention` as the bell did.
   Nothing actionable was dropped: every row acts from where it is, as before.
2. **Back / forward.** `matrix/navigation-history.ts` is the window's history (screen + room / Store shelf /
   Drive place), a nanostore beside the shell, capped at 100, with a "travel" window so a step that lands in
   several renders is one step. `matrix/nav-arrows.tsx` draws ← → (T3's quiet icon pair, Phosphor arrows, ⌘[ ⌘])
   where the bell was: on the left panel's right edge, after the panel toggle when the panel is hidden. A
   screen with its own history (Drive's folders) registers it with `setMatrixNavLocal`; ← → step it first, then
   the window's places, so Drive's own ‹ › could go without losing subfolder navigation.
3. **Plus menus.** `matrix/plus-menu.tsx` (`MatrixPlusMenu`, T3's MenuPopup recipe over Radix) and its words in
   five locales. Team Space: New channel, New message ⌘N, New task, Add people. Drive: New folder ⇧⌘N, New
   document, Upload files…, Upload a folder… (main: `MatrixDrive.create` / `upload`, `drive-ipc.ts`; one plain
   name, never a path from the window; uploads through main's own picker, never over an existing file). Work:
   T3's pencil becomes the plus menu through the host band (`app/work/work-band.tsx`; New thread ⌘N, New thread
   in a worktree, Add project, as T3 commands in atum-work's `workCommands.ts`). ⌘N runs the open screen's
   primary item; a menu without it leaves ⌘N to Chat's New message.
4. **Feet and right panels.**
   - Store foot: Top up + gear, no balance. The Store's title-bar balance is gone too: it shows only on the
     top-up shelf (spec: never on an everyday surface).
   - Team Space foot: the company switcher (opens upward), Activity, Add people, gear. The company name moved
     into the switcher; the search row now leads with the plus.
   - Drive foot: storage meter + gear. Drive's search moved into its left panel (row D).
   - Neutral right panels (`.atum-neutral-panel`): Team Space channel overview
     (`team-space/channel-overview.tsx`: purpose, Chief of Staff with Ask, the board at a glance, members with
     Add people), Store "Your Store" (`store/your-store-panel.tsx`: recent purchases with Open, All purchases,
     one featured item, no balance), Drive folder info (size and count, where, changed, sync, Show in Finder).
   - `matrix/right-panel.ts`: open by default on Chat and Team Space, closed on Store and Drive, remembered per
     screen on this Mac. The title bar's C toggle shows and hides the neutral panel on Team Space, Store and
     Drive; on Chat each conversation opens with the person's or group's card unless the person closed it (or
     the window is narrower than 1180 px).
5. **Rail badges for Work and Store** (`matrix/rail-badges.ts`). Work: a red count of T3 threads asking for the
   person (approval or input), else an ink dot for a thread finished unseen; the view reports only the two counts
   (`AtumAttentionReport` in atum-work → `matrix:work:attention-changed` → `MatrixWorkBridge.onAttentionChanged`).
   Store: an ink dot when something got (purchase, gift) arrived after the Store was last opened on this Mac.
6. **Work's frame.** atum-work selects T3's own `variant="inset"` under `VITE_ATUM_WORK_BUILD`; the host region
   sits in the shared panel frame and main rounds the native view to the panel radius (`WORK_VIEW_RADIUS`,
   `electron-view.ts` `setBorderRadius`).

## Decisions made this round

- Bell items → top of the account face (the owner's step-3 question, decided by the brief). The face's dot is
  red for every waiting item (the spec says red); each row keeps its own amber/red dot.
- Activity stays an icon beside the company switcher (an earlier owner rule, encoded in its test), now in the
  foot.
- New document is Markdown (`.md`): a plain file every assistant and editor reads; no Office template ships.
- Drive's gear opens Settings › General; Store's gear opens Settings › Protons; Team Space's gear opens the
  company's settings (overview for members).
- The window history records places, not every folder: Drive's deeper folders are Drive's own history.

## Known gaps (next round)

- Atum's own assistant chat has no right-panel card yet (its card is a separate sheet), so Chat's default-open
  applies to person and group chats. The spec's assistant card (Now, Files, Controls) in the right panel is its
  own slice.
- The channel overview has no pinned list yet (pins live in their own detail pane) and shows the member count,
  not faces; the company-home overview is unchanged.
- Drive's folder panel has Show in Finder; Share and "Ask Atum about it" need a folder share/ask path in the
  Drive bridge.
- Work's ← → do not step T3's own route history yet (the band bridge has no history command).
- Chat's last conversation still isn't persisted across relaunch (r2 §3 gap, unchanged).

## Verification

See the commit message and owner evidence `kit-t3-1124/step4/` (before/after, light and dark, playground and
the real Work web app).
