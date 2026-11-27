# Consistency audit: every screen against the approved layout (2026-11-27)

Owner, testing the installed build (desktop main `73b0ba1a`, Work 0.1.19), 2026-11-27: "Work screen UI layout -
better, but not *quite* consistent with the rest of the screens yet. The search bar for example; the settings gear
at the bottom is on the left instead of right etc. … the search bars seem slightly different on every screen in
color, style etc. - we might need a full consistency audit so we have consistent layout across screens, to the
point that when users navigate between screens, some elements don't even change. Also work/code toggle - I thought
our mock up was to put it on the right side on the titlebar? … Too many misses."

Design of record: the owner-approved layout language (`layout-language-1124/LAYOUT.md`, `r2/LAYOUT.md`,
`r3/README.md`, `r3/design-system-assessment.md` and their pictures, in owner evidence), with option B (T3's design
system is the Kit base on every screen and in Work). Zones: **A** title bar left (hide-panel toggle, Atum mark and
name, ← →), **B** page title, **C** title bar right (from the far right: panel toggle, mode switch, "…", search),
**D** left panel top (search + quick buttons), **E** left panel foot (context on the left, icon buttons on the right,
**the gear last**), **F** right panel (details), **G** rail badges.

## How it was checked

- The desktop playground (`npx vite --host 127.0.0.1 --port 5174`, `matrix-playground.html?evidence=1`), 1440×900
  at 2x, light and dark: Chat (Linh), the agent side panel (`card=primary`), Team Space
  (`scenario=team-space-threads`), Store, Drive, Settings.
- **Work is the real Work 0.1.19 web UI.** The installed app's own runtime (`Atum Matrix Candidate.app/…/work-runtime`,
  pin 0.1.19) served with `t3 serve` in a throwaway `T3CODE_HOME`/`HOME`, its Atum theme set with `t3 theme set
  atum.json`, paired with `t3 auth pairing create`. The playground lays it where main lays the native view
  (`?work=ready&workView=<url>`; the script strips the server's `frame-ancestors`/`X-Frame-Options` for the capture only).
- Each screen was measured in the page, not by eye: every search field's box (height, radius, fill, border, text
  size, icon), every title-bar button's position, every foot button's position (`scripts/shoot.mjs` →
  `before/measure.json`).
- Evidence: `~/.atum/operations/evidence/consistency-audit-1127/` (`before/`, `after/`, `scripts/`).

## Measured search fields (before)

| Screen | Placeholder | Box | Fill (light) | Radius | Border | Text | Icon | Recipe |
|---|---|---|---|---|---|---|---|---|
| Chat | Search | 206×**34** | `--atum-sunk` 5 % | 8 px | none | **12–13 px** | 14 px | `SearchField` (the old borderless field, restyled inline) |
| Team Space | Search Atum Studio | 198×32, **x 68** (8 px further in) | Kit `--ak-fill-quiet` | 8 px | none | 14 px | 16 px | `ak-field--search` |
| Store | Search the store | 244×32 | **transparent** | 8 px | **1 px outline** | 14 px | 16 px | `Input` + `desktop-input-chrome` (+ Kit class, outline wins) |
| Drive | Search Drive | 244×32, x 60 | Kit `--ak-fill-quiet` | 8 px | none | 14 px | 16 px | `ak-field--search` ← the reference |
| Work (T3) | Search | **no box** | none | – | none | 14 px | 16 px | T3's sidebar search (atum-work) |

Four recipes for one control. The Kit's `ak-field--search` (Drive) is the one the r2/r3 mockups draw and the one most
screens already use, so it is the standard: 32 px tall, 8 px radius, `--ak-fill-quiet`, no border, 14 px text, a
16 px magnifier, flush with the panel's 8 px gutter, plus button beside it where the screen has one.

## Findings

Repo **desktop** = atum-desktop. Repo **atum-work** = the Work fork's own web UI (the Work screen's left panel,
thread and right-panel contents are the sidecar's native view; Atum owns only the rail and title zones A–C).

| # | Element | Screen(s) | Mockup | Actual (before) | Fix | Repo |
|---|---|---|---|---|---|---|
| 1 | Logo and name (A) | all | the mark and the word "Atum" (r1 A, r2 arrows boards, r3 chat) | the eclipse on its dark tile, **no name**; in dark mode a black tile on the dark band (owner item 3) | the bare mark (ring + dot, from `atum-mark.svg`'s geometry) in `currentColor` beside the "Atum" wordmark: ink on light, bone on dark, no tile | desktop |
| 2 | Title-bar tooltips | all; visible on Work (owner item 5) | — | tips open upwards, collide with the window top and flip **down**, where Work's native view (and Chat's document views) paint over them; at the right edge the tip is also clipped | every tip inside the title band opens sideways (left in C, right in A), as the hide-panel toggle's already did; an explicit side still wins | desktop |
| 3 | Mode switch (C) | Work | Work · Code in C, just left of the panel toggle (r1 table, r2 `work-neutral`) | the switch **replaces the page name at the left** of the band (11-23 decision, superseded by the 11-24 spec) | page name "Work" stays in B; Work · Code moves into C before the panel toggle | desktop |
| 4 | Mode switch (C) | Team Space | Chat · Board in C (r1 delta 5: "supersedes STYLE §14 centred") | **centred** in the band | moved into C before the panel toggle | desktop |
| 5 | Search field (D) | Chat | the standard (above) | 34 px, 12–13 px text, `--atum-sunk`, 14 px icon | one shared `MatrixPanelSearch` | desktop |
| 6 | Search field (D) | Store | the standard | transparent, 1 px outline | `MatrixPanelSearch` | desktop |
| 7 | Search field (D) | Team Space | the standard, flush with the gutter | 8 px further in than every other screen | `MatrixPanelSearch`, row on the shared gutter | desktop |
| 8 | Search field (D) | Work | the standard | T3's borderless search | atum-work: draw the sidebar search with the Kit recipe under the Atum build (filled, 32 px, 8 px radius, 14 px, 16 px icon) | atum-work |
| 9 | New (D) | Work | New lives in D as a plus menu (r2 §4: "T3's pencil maps onto this menu") | **Atum's plus in the title bar** (after ← →) **and** T3's pencil in the search row | atum-work: replace the pencil with the plus menu (New thread ⌘N, New thread in a worktree, Add project; the same `workCommands`); then desktop drops `WorkRosterControls` from the band | atum-work, then desktop |
| 10 | Gear in the foot (E) | Work | the gear last, on the right (r1 E) | Settings gear **first, on the left** (T3's foot) | atum-work: under the Atum build, put the foot's Settings gear last on the right; PRs/Issues stay left | atum-work |
| 11 | Panel toggle (C) | Chat, agent panel | always last, **pressed while the panel is open** | last, but the open panel's toggle is not marked pressed | `aria-pressed` on the open workbench's toggle | desktop |
| 12 | Agent panel (F) | Chat › assistant | Now, Files, Controls (r2 neutral table) | Pause shows only once the host lists at least one routine; Files only when something was sent here or the home lists files. A cloud agent with no routines yet, or a read that failed, shows **neither** (owner item 1) | for a cloud Hermes agent both rows are always there: Pause with its real state (switch; "Nothing scheduled yet"; "Couldn't check…" + Try again), Files with its real list ("No files yet"; "Couldn't load…" + Try again) | desktop |
| 13 | Page title (B) | Work | thread name · repo · branch | "Work" | needs the view to report the open thread's name, repo and branch in its sidebar report | atum-work, then desktop |
| 14 | Right-panel header (F) | Chat, agent panel | a 52 px header inside the panel with the name and × (r1 F) | the workbench's tab strip sits in the title band (tab, Expand, toggle) | **deferred**: the workbench's tabs (documents, desk) live in that strip; a 52 px in-panel header for single-tab panels is its own slice (`workspace-surface.tsx`), listed here so it is not lost | desktop |

Checked and consistent (no change): the rail and its badges; ← → ending on the left panel's edge on every screen,
Work included; the panel toggle's place on Team Space, Store, Drive and Work; the feet of Chat (Add a friend · ⚙),
Team Space (company · Activity · Add people · ⚙), Store (Top up · ⚙) and Drive (⚙), with the gear last on the right;
Settings (a sheet over the current screen; its title band is the screen's own).

### Mismatches per screen

| Screen | Mismatches | Rows |
|---|---|---|
| Chat | 5 | 1, 2, 5, 11, 14 |
| Agent side panel | 6 | 1, 2, 5, 11, 12, 14 |
| Team Space | 4 | 1, 2, 4, 7 |
| Store | 3 | 1, 2, 6 |
| Drive | 2 | 1, 2 |
| Work | 7 | 1, 2 (where the owner saw it), 3, 8, 9, 10, 13 |
| Settings | 0 | (sheet; inherits the screen behind it) |

## atum-work fixes (separate lane)

All under the Atum build flag (`VITE_ATUM_WORK_BUILD`), paired with this desktop branch:

1. **Search (row 8):** the sidebar search drawn with the Kit recipe: filled `--ak-fill-quiet`-equivalent from the Atum
   palette, 32 px, 8 px radius, 14 px text, 16 px magnifier, flush with the 8 px gutter.
2. **Plus menu (row 9):** T3's pencil becomes a plus menu with New thread ⌘N, New thread in a worktree, Add project
   (the existing `workCommands.ts` commands). Once that runtime is pinned, desktop removes `WorkRosterControls` from
   the band so New exists once, in D.
3. **Gear (row 10):** the foot's Settings gear last, on the right; PRs and Issues stay on the left.
4. **Page title (row 13):** the sidebar report carries the open thread's name, repo and branch; desktop shows them in B.
5. **Verify the accent:** in the capture, T3's empty state ("Add project") drew its button in T3's blue rather than
   Atum's ink, with the Atum theme set. Confirm in the installed app; if it reproduces, the palette's `accent` isn't
   reaching that button.

## Part B: what this branch changes (desktop)

Paths are under `apps/desktop/src/`.

| Item | Change | Where |
|---|---|---|
| Row 1, owner item 3: logo and name | `AtumGlyph`, the bare mark in `currentColor` from `atum-mark.svg`'s geometry (ring + dot, no tile, no halo), and `AtumBrandLockup` (mark + "Atum", 15 px semibold). The title bar wears the lockup on every screen. **One optical change:** at title-bar size the dot melted into the ring and read as a loading spinner, so the ring stops short of the dot (a 7.4-unit gap in the mask). Everything else is the brand geometry. The dark tile `BrandMark` stays for avatars and the roster. | `components/brand-mark.tsx:43`, `:63`; `app/atum/shell-surface.tsx:104` |
| Row 2, owner item 5: tooltip behind Work | `TipSide`, a default side for every `Tip` inside it; an explicit `side` still wins. The title bar's leading side opens tips to the right and its right cluster to the left; the workbench's tab strip opens left; ← → open outwards (Back left, Forward right). So no title-bar tip lands under a native view. | `components/ui/tooltip.tsx:151`; `app/atum/shell-surface.tsx:41`, `:53`; `app/atum/workspace-surface.tsx:237`; `matrix/nav-arrows.tsx:64` |
| Row 3: Work · Code in C | `WorkTitle` is the plain name (B); `WorkModeSwitch` renders in the band's right cluster, before the panel toggle. It shows only while a project is open, as before. | `app/work/work-band.tsx:157`, `:168`; `app/work/work-screen.tsx:116` |
| Row 4: Team Space's switch in C | The shell draws a mode slot (`data-atum-page-mode`) just left of the panel toggle; `CompanySpaceTabs` portals there when it exists and skips the centring measurements. Without a slot (stories, other shells) the old centred place remains. | `matrix/app.tsx:9155`; `matrix/company-space-tabs.tsx:71` |
| Rows 5–7: one search field | `MatrixPanelSearch` + `MatrixPanelSearchRow` (Kit `ak-field--search`, 32 px, 8 px radius, quiet fill, 14 px text, 16 px magnifier, × and Escape clear it, on the panel's 8 px gutter). Chat, Store, Team Space and Drive use it. Measured after: all four are 32 px tall at x 60 with the same fill, radius and text size (`after/measure.json`). | `matrix/panel-search.tsx:24`, `:74`; `matrix/app.tsx:6835`; `matrix/store/store-sidebar.tsx:133`; `matrix/drive.tsx:276`; `matrix/company-workspace.tsx:3058` |
| Row 11: toggle pressed while open | The open workbench's toggle carries `aria-pressed`, and `.atum-icon-btn[aria-pressed='true']` draws the pressed fill, the same on every screen. | `app/atum/workspace-surface.tsx:327`; `styles.css:2929` |
| Row 12, owner item 1: Pause and Files | **Why they were missing:** the panel showed Pause only once the host listed at least one routine, and Files only when this chat had sent files or the cloud home listed some. A read that failed was swallowed. A cloud agent with no routine and no file yet, or a failed read, showed neither. **Now**, for a cloud Hermes agent the host serves (`runtime: 'hermes'` with the host desk route), both rows are always there and each does something real. Pause is the existing host agent-control route (native cron pause/resume, no new path): with routines it is the switch; with none it says "Nothing scheduled yet." and the switch waits; on a failed read it says "Couldn't check its schedule." with Try again. Files lists what was sent here and its computer's files: "No files yet.", or "Couldn't load its files." with Try again. An agent the host doesn't serve still shows neither, because neither could act. **Decision:** the brief's "the agent's Drive folder" has no counterpart in the product (Drive has no per-agent folder). The agent's own files live on its cloud computer, which the existing Files read already lists, so that is the Files entry. New copy in five locales. | `matrix/assistant-card/agent-controls.tsx:101`; `matrix/agent-desk.tsx:595`, `:763`, `:1053`; `shared/matrix-agent-desk-copy.ts` |
| Owner item 2: picker blip | **Cause:** closing the picker cleared every pending pick and retired the in-flight write's result (`changeOpen(false)` bumped the selection counter, and `beginSelection().current()` required the card to be open). The chip fell back to the stored value (the old Nguyệt Thực) until the acknowledgement or the close-triggered re-read landed. **Fix:** the shared store owns a write in flight. `beginAgentPlansWrite(key, intent)` publishes it as `pending`, and every picker shows it (`agentPlansShownSelection`). A read that overlaps a write (begun before it, or settling while it is out) is dropped. The latest-started write wins, an acknowledgement settles it, and `failAgentPlansWrite` restores what the server last said. Closing the card no longer retires a pick: its result still settles the chip, and only the card's own error lines wait for the next open. | `matrix/agent-plans-store.ts:170`, `:218`, `:232`; `matrix/model-picker.tsx:398`, `:430`, `:1481`, `:1628` |
| Playground | `?workMode=work\|code` stands in for the view's open-project report, so the title-bar switch can be captured. | `matrix/playground/work-fixtures.ts:116` |

Not changed here: row 14 (deferred, above), and rows 8–10 and 13, which belong to atum-work. Until atum-work moves
T3's pencil into a plus menu (row 9), the band keeps `WorkRosterControls`; removing it first would drop "New thread
in a worktree" and "Add project" from one place without adding them to the other.

atum-work item 5 (verify the accent) also covers, from the same capture: Work's dark surfaces drew near-black
rather than the Atum dark panel shades. Both are worth one look in the installed app before changing the palette.

The mobile export (`packages/mobile-design-exports/dist/copy-contract.json`) lists `matrix-agent-desk-copy.ts`.
The five new keys reach atum-mobile at its next pin refresh; nothing in this repo checks it.

## Verification (2026-11-27, Asia/Ho_Chi_Minh)

Run in `apps/desktop`, exit codes read directly (no pipes):

| check | command | result |
|---|---|---|
| typecheck | `npm run typecheck` | rc 0 |
| lint | `npx eslint <every changed .ts/.tsx>` | rc 0, 0 errors (the warnings are on lines this branch didn't write) |
| affected suites | `npx vitest run src/matrix/app.test.tsx src/matrix/drive.test.tsx src/matrix/store src/matrix/company-workspace.test.tsx src/matrix/agent-desk.test.tsx src/matrix/assistant-card src/matrix/assistant-info-panel src/matrix/model-picker src/matrix/agent-plans-store.test.ts src/matrix/team-space src/app/work src/app/atum src/components src/matrix/company-ai-ui.test.tsx src/matrix/company-marketplace.test.tsx src/matrix/playground src/matrix/start-chat src/matrix/workbench` | rc 0, 3825 passed, 1 skipped |
| full renderer suites | `npx vitest run src/matrix src/app` | rc 0, 669 files, 9732 passed |
| public guard | `python3 scripts/public_guard.py --base origin/main --head HEAD` (repo root) | rc 0, "PASS: 4 new commits", no leaks |
| packaging | none: no DMG or package build in this lane | n/a |

New behaviour tests, each confirmed to fail on the code before the fix:
- `matrix/model-picker.test.tsx`: "never paints the previous model when the picker closes while a plan pick is in
  flight and the close-read answers first" (acknowledged and refused; the close-read is a deferred promise
  released before the write settles); "keeps naming an in-flight local pick after the card closes"; "goes back to
  the running model when an in-flight local pick fails after the card closed".
- `matrix/agent-plans-store.test.ts`: the write-in-flight block (pending shown, overlapping read dropped, a read begun
  before the write dropped even after the acknowledgement, failure restores, a clear in flight names no plan).
- `matrix/assistant-card/agent-controls.test.tsx`: Pause and Files stay for a hosted cloud agent (empty, failed with
  Try again, then real), and neither shows for an agent the host doesn't serve.
- `app/atum/titlebar-consistency.test.tsx`: the lockup (bare mark + "Atum", no tile), tips sideways in the band
  with an explicit side winning, and the panel search (Kit recipe, Escape and × clear it).
- `matrix/company-ai-ui.test.tsx`: Team Space's tabs sit in the mode slot before the panel toggle.
- `app/work/work-screen.test.tsx`: the Work name stays in B; Work · Code sits in the band's right cluster.

Updated tests: `model-picker.test.tsx` ("retires an in-flight local pick when the card closes" encoded the blip and
now asserts the opposite); `roster-panel.test.tsx` (the title bar's own "Atum" is not a row's);
`design-contract.test.ts` (Drive's search is `MatrixPanelSearch`).

Screenshots: `~/.atum/operations/evidence/consistency-audit-1127/before/` and `after/`. Each has chat,
agent-panel (plus `agent-panel-end`, a hosted agent with Pause and Files), team-space, store, drive, settings,
work and work-standalone, in light and dark, with `measure.json`. `after/titlebar-mark-*.png` is the title bar at
2x. Reproduce with `scripts/shoot.mjs` (playground on 5174 and a local Work 0.1.19 on 3811, as described above).
