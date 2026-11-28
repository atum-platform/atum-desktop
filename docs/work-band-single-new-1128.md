# Work: one New, on the list (2026-11-28)

Owner, 2026-11-28: "there's also still a straggling redundant plus icon on the titlebar in Work? What
does that do".

**What it did.** The band's `+` (`WorkRosterControls`, tooltip "New…") opened New thread / New thread in
a worktree / Add project, running T3's own commands in the view (`runCommand` → `window.atumWorkCommands`).
The view's list header draws the same menu with its own `+` (atum-work `SidebarThreadHeader`
`AtumNewMenu`, whose comment already planned for the band to drop its plus). Two buttons, one menu.

**Change.** The band's plus is gone. The band keeps the list toggle, history arrows, title, Work/Code
switch and right-panel toggle. New lives on the list's `+` (Work says New session there, atum-work
`feat/work-cowork-projects`), on ⌘N, and on the Work home's composer. The band's list toggle now reads
"Show or hide sessions". `WORK_BAND_COMMANDS` and the host's `runCommand` stay: the band's other
buttons and app menus still use them.

**Verification.** `npx vitest run src/app/work/` (60 pass; the band test now asserts no plus before or
after the view is ready), `npm run typecheck`, `npx eslint src/app/work/`: pass.

**Rebase note.** Open #163 moves the band header block in `work-screen.tsx`; resolve by dropping the
`WorkRosterControls` line and import from its moved block.

Mockups: `docs/mockups/work-cowork/04-title-band-light.png` (branch `docs/work-cowork-mockups`).
