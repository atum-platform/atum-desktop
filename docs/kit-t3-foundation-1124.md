# Atum Kit on T3's design system: foundation and composer (2026-11-24)

Owner decision 2026-11-24: "we take the middle path first - option B". T3 Code's design system becomes
the Atum Kit base; Atum keeps its Phosphor icons, brand, avatars and Vietnamese type. Plan of record:
the round-3 design-system assessment (owner evidence folder `layout-language-1124/r3/`). This change is
migration steps 1 (foundation) and 2 (composer).

## What changed

- **Vendored T3, pinned.** `packages/atum-kit/scripts/sync-t3-design.mjs` copies nine files from
  `pingdotgg/t3code` tag `v0.1.11` (commit `59651c17`, MIT) into `packages/atum-kit/t3/upstream/`
  byte for byte, with SHA-256s in `t3/PIN.json`. `--check` (offline, part of the Kit's `check`) fails
  when they drift. Notice: `t3/THIRD-PARTY.md`, `apps/desktop/third-party/app-components.json`
  (`t3code-design-system`), `THIRD-PARTY.json`.
- **One palette.** `packages/atum-kit/scripts/t3-theme.mjs` maps the Kit's tokens onto T3's colour roles
  (the mapping that lived in `build-work-theme.mjs`) and writes `dist/atum-t3-theme.json`, a T3 theme file.
  `dist/atum-kit.css` declares the same roles under T3's own `--app-theme-*` names (read from the vendored
  `themePalette.ts`), plus T3's `--control-radius` and `--glass-*` (read from the vendored `index.css`).
  The colours are byte-identical to Work's previous theme.
- **Work** installs `dist/atum-t3-theme.json` as `electron/work/sidecar/atum.json` (colours only). The 35 KB
  CSS block, `scripts/work-theme/atum-work.css` and the generated picker CSS are gone: Work is stock T3 in
  Atum's colours. The supervisor re-sets the theme because the file's digest changed.
- **Radius and type.** Kit controls (`.ak-btn`, `.ak-iconbtn`, `.ak-seg`, `.ak-field--search`, `.ak-ask-line`)
  take T3's 8 px radius instead of capsules; desktop/web `--ak-t-body` is 14/20 through a new `desktop`
  group in `tokens.json` (the phone projection keeps 13/18). `approved-0.1.css` is amended with the
  owner's approval. The model chip is 14 px on 8 px (`model-picker-spec.json`; digest updated).
- **Composer.** `ComposerSurface` gains `recipe="t3"` (editor above a footer). The Matrix composer (Chat,
  DMs, Team Space) uses it; `styles.css` "T3 composer" paints it from T3's variables: 16 px card, 1 px outline,
  T3 glass, 14/22.75 editor two lines tall, 28 px ghost paperclip, 32 px round send. The attach "+" is a
  Phosphor paperclip (same menu). The pet chat and the legacy Hermes chat keep the Atum recipe.

## Verification

- Kit: `npm run --workspace @atum/kit check` pieces: build `--check`, sync `--check`, tsc, 19 tests, eslint: all 0.
- Desktop: `npm run typecheck` 0; eslint on touched files 0 errors; vitest `src/matrix src/app/chat/composer
src/lib scripts/build-work-theme.test.mjs electron/work`: 572 files / 8072 tests passed.
  Full desktop vitest: 18 failures, all electron tests that spawn the repo's Python `.venv` (absent in the
  lane's clone): environment, not UI.
- Real renders (matrix playground, headless Chrome, light and dark): owner evidence `kit-t3-1124/`
  `before-*` (origin/main 2365efe8) and `after-*`. Measured after: card 16 px radius, 110 px tall
  (T3 112), editor 14/22.75 at 46 px, send 32 px round; model chip only in the assistant chat.

## Known gaps and next steps

- Copy `model-picker-spec.json` and `model-picker-digests.json` to atum-work (the two repos keep
  byte-identical copies).
- "Add friends at the bottom of Chat" (owner override) belongs to the layout lane (left-panel foot);
  not in this change.
- Next migration step (3): menus, popovers, dialogs, tooltips and toasts from the vendored `menu.tsx` /
  `dialog.tsx`; then the remaining hand-rolled capsules outside the Kit (Tailwind `rounded-full` buttons).
