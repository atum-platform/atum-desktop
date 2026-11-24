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

Known differences kept after round 2 (closed in round 3, below): surface tints, the ⌘1–⌘9 hints and
taglines. Still kept: the chip's warning glyph replacing the mark.

Verification: desktop typecheck 0; eslint 0 errors on touched files; vitest 858 + 512 (app shell) pass;
`tests/acp_adapter` 518 pass.

## Round 3 (same day): one set of thinking words, the pickers match

Owner, 2026-11-24: thinking levels "go consistent" (Quick / Balanced / Thorough everywhere, one extra
top level only where a model offers it); the remaining picker differences "make them match - UI should
be consistent to our Atum kit". Companion: atum-work `feat/ui-consistency-1124` (round 3 in
`docs/work-ui-consistency-1124.md`).

- **One set of words.** `src/matrix/model-picker-labels.json` holds the thinking heading and levels in
  every desktop locale, keyed by the provider's id (`low` Quick, `medium` Balanced, `high` Thorough,
  `xhigh` Extra thorough, `max` Maximum, `minimal` Instant, `none`/`off` Off; aliases fold
  `extra-high`, `maximum`), plus Atum's line-up taglines and "Suggested". `model-picker-copy.ts`
  `pickerLabels()` reads it; the ids sent to providers are untouched. The desktop offers only
  low/medium/high, so its visible words do not change. Work relabels every provider's reasoning
  control from its copy of the same file.
- **The pickers match, per the Kit.** Decisions (recorded in `model-picker-spec.json` and
  `packages/atum-kit/STYLE.md` §12): the card is the Kit's frosted glass at the menu radius (§7,
  `ak-glass`, `--ak-r-lg`) with no tint on rail, list or thinking column and no rule under Favorites;
  a row is T3's shape: mark, name, the check beside the name, Atum's muted line, the star on hover
  and ⌘1–⌘9 as the Kit's menu key (`.ak-menu-key`, plain ink-3 text, no keycap). Desktop:
  `model-picker-panel.tsx` (`MODEL_PICKER_GLASS`), `model-picker-list.tsx` (check, menu key). Work:
  the generated theme (`build-work-theme.mjs` `workPickerCss()`: glass, untinted columns, no rule,
  menu key) and Atum-build-only code in the fork (taglines, labels).
- **The two copies cannot drift silently.** `model-picker-digests.json` records the sha256 of the
  spec and the labels file; each repo keeps byte-identical copies of all three and tests its copies
  against it (`model-picker-style.test.ts` here; `apps/web/src/atum/pickerLabels.logic.test.ts` in
  the fork, now in Atum's CI). Editing one copy fails that repo's test until the digest is updated,
  and the digest file says to copy all three files across. It cannot see the other repo's working
  tree: a change made and re-digested in one repo only is caught when the files are copied, by review.
  The JSON is laid out as the fork's formatter wants it, so both repos accept the same bytes.

Evidence: `~/.atum/operations/evidence/ui-consistency-1124/r3/` (`desktop-picker-*`, `work-picker-*`:
default, open light and dark with the thinking column, hover).

Verification: desktop typecheck 0; eslint 0 on touched files; `build-work-theme.mjs --check` 0;
vitest 735 (picker, work, theme, app, agent home, composer) + 96 (i18n, mobile copy) pass.

