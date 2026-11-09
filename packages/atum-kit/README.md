# Atum Kit 0.1

The shared token and component layer for desktop, web and phone. The owner
approved these values after the 2026-10 UI audit; `approved-0.1.css` is that
stylesheet, verbatim, and the tests fail if a generated value drifts from it.

- `tokens.json`: the only source of `--ak-*` values. Semantic colour roles
  (light and dark), type roles, space, radii, control heights, icon sizes,
  motion, glass, plus a `phone` group for phone-only deltas.
- `components.css`: the hand-maintained `.ak-*` component rules. It must not
  declare tokens.
- `icons.json`: the Phosphor icons the kit exposes, from the pinned
  `@phosphor-icons/core` 2.1.1 (MIT). `src/icon.tsx` renders one by name
  (`<AkIcon name="compass" weight="fill" size="lg" />`) with `.ak-icon` sizing
  and `fill: currentColor`.
- `dist/` (generated, committed): `atum-kit.css` (token blocks + components),
  `atum-kit-tokens.json` (the phone projection, shipped through
  `packages/mobile-design-exports`) and `phosphor-icons.json`.

Regenerate with `npm run --workspace @atum/kit build`; never edit `dist/`.
`npm run --workspace @atum/kit check` fails when `dist/` is stale, then runs
the typecheck and tests.

Theme scope: light tokens on `:root` and `.ak-light`; dark tokens on
`.ak-dark` and on the desktop's `.dark` root class (set by `applyTheme`).
`color-scheme` is set only by `.ak-light` and `.ak-dark`, so the desktop's own
inline `color-scheme` is untouched. Every class is `ak-` prefixed, so loading
the kit (desktop `src/styles.css`, and through it the web app) changes no
existing surface; surfaces adopt it in their own changes.

To change an approved value, update `approved-0.1.css` with the owner's new
approval in the same change as `tokens.json`.
