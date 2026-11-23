# Work UI revamp: one frame, one title, a centered card (2026-11-23) — built, not live

Owner (2026-11-23, installed 0.20.52): "Get Opus to do a comprehensive revamp of the UI for Work, following our
consistent aesthetics." Four findings from the owner's screenshots, each traced to a line and fixed. Builds on
`docs/work-ui-0113-shell.md` (U1, U3′, U7) and the fork's `docs/work-ui-0113-presentation.md`. The fork half is
atum-work `feat/work-ui-revamp-1123`; Work's runtime pin moves when the coordinator bumps it.

## Findings and fixes

| Owner saw | Cause | Fix |
|---|---|---|
| A sharp edge on the thread list panel; it sits flush on the rail | T3 spreads `data-app-sidebar` onto the sidebar **container** itself, so the theme's `[data-app-sidebar] [data-slot='sidebar-container']` (descendant) never matched: T3's full-height `border-r` stayed beside the card and the card ran to the view's left and bottom edges | `scripts/work-theme/atum-work.css`: compound selector `[data-app-sidebar][data-slot='sidebar-container']`, 8 px in from the rail and the window's foot (STYLE §2 materials), border gone, the resize handle's hover hairline transparent (the gap is frame, never a seam) |
| The pencil (New thread) in the title band does nothing | On an empty draft T3's `chat.new` reuses that draft, so the press changed nothing visible; the click also left keyboard focus in the Atum renderer, so nothing in the view could take it | Desktop: `WorkSurface.runCommand('chat.new')` focuses the owner view first (`WorkViewHandle.focus`, `electron-view.ts`). Fork: after `chat.new` runs, the composer takes the caret unless the "new thread in…" palette opened |
| "Work" on the left and a Work/Code switch on the right | Two controls for one fact (the page and its mode) | `work-band.tsx` `WorkTitle`: with a project open the band's title **is** the `.ak-seg` "Work · Code" (full size, where a page's name sits; `h1` kept for assistive tech); with none open it is the plain "Work" headline. The right side keeps only the page's live controls (Add Protons, Assistants pill) |
| Main panel lopsided in Work | The canvas kept a 280 px lane for the Thread details card, which Work never renders (the store still said "inline open" and a stale measurement survived) | Fork: `ChatView` passes `detailsCardHidden={atumWork}` to `ChatCanvas`, and its own canvas read ignores the inline-open flag in Work; the conversation and the empty-state hero centre in the card |

Also, from the same rules (no T3 chrome inside Atum chrome, one control per action):

- T3's roster **New thread** pencil is hidden (`data-sidebar-new-thread` hook): the band carries it (STYLE §2, "Above the roster: the sidebar toggle and New chat").
- T3's floating sidebar toggle (`[data-sidebar-control]`) is hidden; with the roster closed it sat inside the main card as a second copy of the band's. It stays mounted (it carries the shell's shortcuts), and the thread header no longer reserves its leading space.

## Files

- Desktop: `scripts/work-theme/atum-work.css` (+ regenerated `electron/work/sidecar/atum.json`, generated only),
  `src/app/work/work-band.tsx`, `src/app/work/work-screen.tsx`, `electron/work/surface/surface.ts`,
  `electron/work/surface/electron-view.ts`, tests in `work-screen.test.tsx` and `surface.test.ts`.
- `atum.json` sits in `electron/work/sidecar/`, which the parallel sidecar lane owns. It is generated: on a
  conflict, take theirs and rerun `node scripts/build-work-theme.mjs`.

## Verification

- `npx tsc -p tsconfig.electron.json --noEmit`, `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `npx eslint` on the touched files: exit 0. `node scripts/build-work-theme.mjs --check`: exit 0.
- `npx vitest run src/app/work src/app/atum shared/matrix-work electron/work/surface scripts/build-work-theme.test.mjs`:
  71 files, 1569 tests, exit 0.
- Rendered against the fork's dev server (isolated home, Replay provider, this theme published) inside a harness that
  reproduces the Atum frame: Work thread (roster open and closed), Work empty draft, Code thread, light. The band's
  New thread on an existing empty draft lands the caret in the composer once the view has focus.
- Not run: the signed app (P1 vibrancy in the gaps, P2 drag region). The owner view's focus call is covered by the
  surface unit test, not by a live Electron run.
