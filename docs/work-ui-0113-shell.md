# Work UI 0.1.13 in the Atum shell (U1, U3′, U7, E5′) — built, not live (2026-11-23)

Owner (2026-11-23): "Work seems to be T3 inside Atum shell — panels are inside Atum panels? … UI looks weird";
"the design of Work isn't in line with our consistent aesthetics - icon uses for example"; "get the mode split
folded in". Implements U1, U3′, U7 and E5′ of design spec `70dd4ea7` (docs/work-ui-1123). The fork half (F2, F3,
band commands) is atum-work `feat/work-runtime-0113-1123` (`docs/work-ui-0113-presentation.md`). Runtime version
and pin are unchanged; the coordinator bumps them after hosted CI builds Work 0.1.13.

This branch first merges `feat/work-subs-integration-1123` (#106): see the merge commit for the four conflict
resolutions (surface-mode requests beside account reads and per-plan contracts).

## U1: Work takes the region right of the rail

- `work-screen.tsx`: no card around the host while the view is ready; the host fills the column under the band
  (the quiet states keep a plain card). `styles.css` drops the main column's own card on Work.
- `electron-view.ts` / `main-work.ts`: the owner view is transparent and square (radius 0), so the frame shows in
  the gaps the theme leaves between T3's panels.
- Title band: sidebar toggle and New thread (`work-band.tsx` → `work.runCommand` → host `executeJavaScript`
  of the fork's `window.atumWorkCommands`), then "Work"; at the right the mode switch, then the Assistants pill.
  The Assistants band and relay line under the band are unchanged (U2 is not part of this slice).

## U3′ + E5′: the Atum theme from the Kit

- `scripts/build-work-theme.mjs` writes `electron/work/sidecar/atum.json` (already staged into the runtime by
  `stage-work-runtime.mjs`): every T3 color role from one Kit token per appearance (light, dark variant), plus CSS =
  the Kit's generated stylesheet + `scripts/work-theme/atum-work.css` (region map on T3 `data-` hooks: roster
  panel, main card, hidden brand row, capsules, focus, Atum mark, atom motion, file card/ask radii, mode density).
  `--check` fails on a stale theme; `scripts/build-work-theme.test.mjs` asserts it matches the Kit build.
- `supervisor.py`: publishes and sets the theme whenever the shipped file's SHA-256 differs from the one last set
  (marker `.atum-theme-installed` now holds the digest). An owner who picks another theme keeps it until the Atum
  theme itself changes; a missing theme file skips installation.
- Not done (E5′ remainder): Work project defaults (`defaultThreadEnvMode: local`, `defaultRuntimeMode: auto`) and
  creating relay projects as Work; Kit icon paths are already vendored in the fork by F4.

## U7: mode switch and rail glyph

- `.ak-seg ak-seg--sm` "Work · Code" in the band, from `getSurfaceMode`/`onSurfaceModeChanged`; optimistic, put
  back when the view refuses; hidden when no project is open. Copy en/vi in `copy.ts` (`band`).
- Rail: Work's glyph is `pen-nib` (Light at rest, Fill when current), same size as its neighbours.

## Probes

- P1 (transparent view shows vibrancy in the gaps) and P2 (drag region inside the view) need the signed app on
  macOS; not run headless. P1 fallback if it fails: paint the gaps with the frame color in `atum-work.css`.
- P3 (selectors survive a pin bump): selectors are `data-` hooks only; re-shoot the three mockup states per bump.

## Verification

- `npx vitest run src/app/work src/app/atum shared/matrix-work electron/work/sidecar electron/work/surface
  scripts/build-work-theme.test.mjs` (apps/desktop).
- `npx tsc -p tsconfig.electron.json --noEmit` and `npx tsc --noEmit -p tsconfig.json`: exit 0.
- Headless Chrome screenshots of the fork with this theme published (see the worker handoff for paths).
