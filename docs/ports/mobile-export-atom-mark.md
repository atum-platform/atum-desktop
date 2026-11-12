# Mobile export: the Kit working atom (schema 2)

Date: 2026-11-12. Owner feedback from the wave 3 iPhone TestFlight build (phone `5018d28`,
pinned to this repo at `055bd491`): the phone's working row showed the old three-orbit atom,
not the single-orbit "tracing" atom desktop draws.

## Cause

Desktop's working glyph (`apps/desktop/src/components/brand/atum-atom.tsx` + `atum-atom.css`)
has been the Kit atom since atum-app #823 (merged 2026-11-04): one orbit circle, a centred
nucleus, one electron turning clockwise. The mobile snapshot in
`packages/mobile-design-exports/dist` was cut from an earlier producer run and still carried
the schema 1 mark (three tilted orbits). Later copy refreshes (wave 1, wave 3) touched only
the copy files, so `marks/atom.json` was never regenerated. The phone already draws both
schemas (`ios/App/Chat/Views/AtomMark.swift`); it draws whatever the pin carries.

## Change

- `dist/marks/atom.json` is replaced by the producer's schema 2 output, byte-identical to the
  private atum-app `packages/mobile-design-exports/dist/marks/atom.json` at its latest change
  `4be0a0d3808` ("fix(desktop): align working atom with kit"); the manifest records its SHA-256.
- `dist/manifest.json` changes only that file's hash.
- No other export file changes. The file has no copy, identifiers or addresses.

## Parity check against desktop's CSS

| Export field | Value | `atum-atom.css` |
|---|---|---|
| `orbit.radius` in a 24 viewBox | 10.5 | `<circle r="10.5">` in `viewBox 0 0 24 24` |
| `stroke.opacity`, `width`, `nonScaling` | 0.55, 1, true | `stroke-opacity: 0.55; stroke-width: 1; vector-effect: non-scaling-stroke` |
| `nucleus.diameterPercent` | 15 | `width/height: 15%` |
| `electron.diameterPercent`, `minimumDiameterPx` | 13, 2.25 | `max(2.25px, 13%)` |
| `electron.restingAngleDegrees` | −45 | `--atum-atom-rest-angle: -45deg` |
| `motion.durationMs`, `timing`, `direction` | 1600, linear, clockwise | `--atum-atom-turn: 1600ms`, `linear infinite`, `+1turn` |
| `motion.reducedMotion` | static | `prefers-reduced-motion` → no animation at the rest angle |

## Phone follow-up

Repin atum-mobile-client to the merge commit of this change (`scripts/import-design-exports`).
