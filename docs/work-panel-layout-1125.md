# Work's panel layout matches every other screen (2026-11-25)

Owner bug report 2026-11-25, on the installed test build: Work's left and main panels were one joined
surface, the left panel had a second hide button, the Atum mark was missing from every title bar (Work showed
a "◐ Work" block at the top of its left panel instead), and Work's right-panel toggle sat inside the main
panel. Paired atum-work branch: `feat/work-panel-layout-sync-1125`.

## Root causes and fixes

| Issue | Cause | Fix |
|---|---|---|
| One joined surface | atum-work's Atum build used T3's `inset` sidebar (list on a painted chrome ground, the thread a card in it), and the desktop's `[data-atum-main]::before` card also painted under the whole view. The host's own `me-gap`/`mb-inset` doubled the main column's padding. | atum-work: a `panels` sidebar variant (two rounded cards, 8 px apart, transparent ground; the page is transparent while it shows). Desktop: no main card under Work (`styles.css`), the host fills the main column. The theme's `chrome` is now Kit `chrome` and `sidebar` is Kit `panel` over it, the shades of every left panel. |
| Two hide buttons | T3's floating `SidebarTrigger` (AppSidebarLayout `SidebarControl`) still rendered inside the view under the Atum build. | Not rendered under the Atum build; ⌘B and the band's `sidebar.toggle` still work. The title bar's button is the only one. |
| No Atum mark; "◐ Work" in the left panel | `AtumWindowControlsSurface` had no mark; T3's `SidebarChromeHeader` brand row (rebranded to the eclipse and "Work") rendered at the top of the list. | The mark (`BrandMark`) sits after the hide button in `AtumWindowControlsSurface`, so every screen's title bar wears it. The brand row is not rendered under the Atum build; the list starts with its search row, as Drive's starts with its search. |
| Right-panel toggle inside the main panel | T3's `PanelLayoutControls` right-panel toggle rendered in the view. | Hidden under the Atum build. The view reports `rightPanel: 'open' | 'closed'` in its sidebar report (`atum/rightPanel.ts`, offered by ChatView while a project thread is open), and the title bar shows the same toggle Chat, Team Space and Drive wear (`WorkRightPanelToggle`), running the new band command `rightPanel.toggle`. |

## Decisions

- In Code mode the thread-details and terminal toggles stay in the thread's own header. They are tools of
  the thread, like Chat's search and menu, not the screen's panel controls.
- The mark is the existing `BrandMark` at 20 px, with no link. It names the app and does nothing.
- An older runtime that does not report `rightPanel` shows no title-bar toggle. Upgrading the runtime with
  this desktop build brings it back. The view's own toggle is gone only in the new runtime, so a person is
  never left without one.

## Verification

Desktop: `npm run typecheck` 0; eslint on touched files 0 errors; vitest `src/app/work src/app/atum
src/matrix/app.test.tsx src/matrix/playground electron/work electron/matrix/main-work.test.ts` 2681 passed. New
tests: report parse of `rightPanel`, the title-bar toggle. atum-work: see its commit.

Evidence (`~/.atum/operations/evidence/work-panel-layout-1125/`): Work, Chat, Team Space and Drive, light and
dark. Work is the real T3 web UI (Atum build flag, Atum theme set with `t3 theme set`, decoy home) placed by
the playground where main lays the native view (`?workView=<url>`, new in `work-fixtures.ts`).
