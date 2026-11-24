# UI consistency pass (2026-11-24) — built, not live

Owner, testing 0.20.55: Work's Atum models showed as raw "Anthropic · claude-…" rows with a black-dot
mark; every picker logo carried an "AT"/"CO" badge; Work's New thread button did nothing; Work, Chat and
Team Space placed the bell and the hide-left-panel button differently. Companion fork change: atum-work
branch `feat/ui-consistency-1124` (`docs/work-ui-consistency-1124.md` there).

## What changed here

- **Atum's line-up in Work's picker.** Work's "Atum" instance is `acp_adapter.managed`; its model state
  came from the whole Hermes inventory, so every configured provider's raw ids appeared under Atum's name.
  A session on `atum-managed`/`atum-gateway` now offers Atum's served line-up only, by product name
  (`acp_adapter/model_labels.py` `ATUM_LINEUP`, mirroring `shared/matrix-models.ts`); a retired
  `binh-minh` resolves to Nguyệt Thực. Thái Cực is announced, not served, so ACP (which has no
  "announced" row state) does not list it. Test: `tests/acp_adapter/test_atum_model_lineup.py`.
- **New thread works.** The band's button runs `chat.new` inside the Work view, which on an empty draft
  only moves the caret into its composer. The click left keyboard focus in the desktop renderer, so the
  caret never showed and the button looked dead. `WorkHost.runCommand` now focuses the view before
  `chat.new` (`electron/work/sidecar/host.ts`).
- **One title-bar order on every page.** Lights, then hide-left-panel, then the bell at the left panel's
  far edge, as the chat roster's top row has it (owner 2026-11-13). Team Space gains the hide button
  (`$teamSpaceSidebarHidden` in `matrix/team-space-sidebar.tsx`; compact windows keep their one-pane flow)
  and its bell moves to the sidebar's edge (`styles.css`). Work's hide-threads button moves beside the
  lights; the bell follows it, then New thread.

## Round 2 (same day): the bell's edge, one picker, the Work search box

Coordinator decisions on the round-1 questions (owner may override): the Work bell lines up with the
thread list; both chips are T3's mark + name; Thái Cực stays out of Work until served.

- **Work's bell at the thread list's edge.** The view reports its list (open, right edge in CSS px)
  through the existing owner preload (`atumWork.reportSidebar`, fork `apps/web/src/atum/SidebarReport.tsx`);
  `WorkHost` keeps the live view's last report (`host.ts` `sidebar()`, IPC `matrix:work:sidebar-changed`),
  main publishes it, and the band reads it once and follows changes (`useWorkSidebar` in
  `src/app/work/work-band.tsx`). `work-screen.tsx` sets `--atum-work-roster-edge`; `styles.css` ends the
  leading cluster one header inset inside it, as the chat roster and Team Space do. List hidden or no
  report: the bell follows the hide button.
- **The Work search box.** `scripts/work-theme/atum-work.css` had a global unlayered
  `:focus-visible { outline: 3px }`. It beat T3's layered `outline-none`, and Chromium counts every
  focused text field as `:focus-visible`, so the model search showed a grey box over its underline.
  Text fields are now left to T3 (reproduced in Electron with the installed theme; fixed after).
- **Switches, for real.** Round 1 set Kit proportions in the fork's own theme, which the desktop
  replaces with `electron/work/sidecar/atum.json`. The rule now lives in `atum-work.css` (38×22, 18px
  knob, line-2 track when off).
- **One model picker.** `src/matrix/model-picker-spec.json` holds the shared measures: T3's geometry
  (rail 44/36/20 with a 3×20 ink indicator, 26px search on a hairline, 32px rows with 16px marks,
  192px thinking column, 346px body) and the Kit's type (13px), capsule chip (28px, mark + name, no
  chevron) and focus colour. The desktop picker reads it through CSS custom properties
  (`model-picker-style.ts` `MODEL_PICKER_VARS`); `build-work-theme.mjs` `workPickerCss()` gives Work's
  picker only what T3 lacks (chip, `--text-sm`, the search's focus colour). The thinking column's
  heading now sits on the search row's line, as in T3. Tests: `model-picker-style.test.ts` (every
  measure reaches a variable), `build-work-theme.test.mjs` (a spec change moves Work's CSS), and the
  fork's `ProviderModelPicker.atumSpec.browser.test.tsx` (T3's real layout still matches its
  byte-identical copy, `atum-work/model-picker-spec.json`). Change both copies together.
- **Signed-out marks.** A signed-out connection keeps its full mark in the rail, as T3 draws a
  reachable unready provider; dimmed to 45% under the pointer or the active bar it read as missing.
  `data-matrix-model-rail-signed-out` carries the state.

Evidence (before/after): `~/.atum/operations/evidence/ui-consistency-1124/r2/`.

Known differences kept: surface tints (T3's rail and list tints versus the desktop card's glass),
the desktop's ⌘1–⌘9 hints and Atum taglines on rows, and the chip's warning glyph replacing the mark.

Verification: desktop typecheck 0; eslint 0 errors on touched files; vitest 858 + 512 (app shell) pass;
`tests/acp_adapter` 518 pass.
