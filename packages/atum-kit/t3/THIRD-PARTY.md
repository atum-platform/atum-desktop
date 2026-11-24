# T3 Code design layer (third-party)

`upstream/` holds files from [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc., copied byte for byte
at tag `v0.1.11` (commit `59651c1761f6c63e9b6056839067066968e6a406`). `PIN.json` records each file's SHA-256.
They are licensed under the MIT License; the full text is `upstream/LICENSE`:

> Copyright (c) 2026 T3 Tools Inc.

Atum uses them as the base of the Atum Kit (owner decision 2026-11-24, option B):

- `apps/web/src/index.css`: the control radius and glass values (`--control-radius`, `--glass-*`), read into
  `dist/atum-kit.css` by `scripts/t3-theme.mjs`.
- `apps/web/src/themePalette.ts`: T3's colour roles and their `--app-theme-*` variables. Atum's palette is a T3 theme
  file in that format (`dist/atum-t3-theme.json`).
- `apps/web/src/components/chat/ComposerSurface.tsx` and `components/ui/button.tsx`: the composer and control
  recipes the desktop composer copies (`apps/desktop/src/styles.css`, "T3 composer").
- `components/ui/menu.tsx`, `popover.tsx`, `dialog.tsx` + `dialog-styles.ts`, `tooltip.tsx`, `toast.tsx`: the overlay
  recipes (glass, radius, rows, backdrop) that `apps/desktop/src/styles.css` ("T3 overlays") paints Atum's Radix menus,
  popovers, dialogs, tooltips and toasts with (migration step 3).
- `apps/web/src/appearanceContrast.ts`, `panelAnimations.ts`: the next migration steps (panels).

Atum keeps its own icons (Phosphor), brand, avatars and Vietnamese type. Re-sync or move the pin with
`npm run --workspace @atum/kit sync:t3`; `npm run --workspace @atum/kit check` fails if these files drift.
