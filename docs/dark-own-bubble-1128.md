# Your own bubble in dark: near-white with ink text

Date: 2026-11-28. Owner decision ("go with your recommendations"): in dark mode your own chat
bubble keeps its identity. Light mode is unchanged.

## Problem

In dark, `--ak-bubble-own` was a raised grey (#3d3f47, 2026-10-28) only slightly lighter than
everyone else's quiet bubble. Measured in the playground, your bubble against the quiet one was
**1.35:1**, so "mine" versus "theirs" read by alignment alone. In light your bubble is ink with
white text, the strongest element on screen.

## Change (roles only, one source)

`packages/atum-kit/tokens.json` (the Kit's single source; `approved-0.1.css` records the approval):

| Role | Light (unchanged) | Dark before | Dark after |
|---|---|---|---|
| `bubble-own` | #1b1d22 | #3d3f47 | **#ecedf0** (the dark `ink`) |
| `bubble-own-hover` | #2c2f36 | #464851 | **#d6d8dd** (the dark `ink-press`) |
| `on-bubble-own` | #ffffff | #f4f5f7 | **#17181c** (the dark `on-ink`) |

Your bubble is now the theme's ink with on-ink text in both themes, mirroring light. Generated with
`npm run --workspace @atum/kit build` (`dist/atum-kit.css`, `dist/atum-kit-tokens.json`). The phone
snapshot `packages/mobile-design-exports/dist/atum-kit-tokens.json` is byte-identical to the Kit's
`dist/atum-kit-tokens.json`, and `dist/manifest.json` changes only that file's hash.

What sits on your bubble used the window's light ink tones, which vanish on near-white. In
`apps/desktop/src/styles.css`, inside a dark own bubble only (not one being edited, which returns
to the quiet field), the ink roles take the bubble's own ink, quietened: `--atum-ink`,
`--atum-ink-soft` (84%), `--atum-ink-muted` and `--dt-muted-foreground` (68%), `--atum-ink-faint`
(66%), `--atum-line` and `--dt-border` (18%), `--atum-hover` (7%). They are mixed from
`--ak-on-bubble-own` and `--ak-bubble-own`, so an app look that sets its own bubble colours
(`matrix/look/resolve-look.ts`) gets matching inks too.

## Contrast (WCAG 2.x, alpha composited)

Measured live in the playground (`apps/desktop/scripts/own-bubble-shots.mjs`, `chat-people` and
`chat-group-runs`, dark): the quiet bubble is #2a2b2f on the main panel.

| Pair | Before | After | Target |
|---|---|---|---|
| Your bubble vs the quiet bubble | 1.35 | **12.12** | ≥ 3 |
| Your text (and links, which inherit it) | 9.62 | **15.15** | ≥ 4.5 |
| Your text on the hover shade | 8.35 | **12.44** | ≥ 4.5 |
| Time, "edited" and the delivery tick (66% of the bubble's ink) | 5.24 | **5.33** | ≥ 4.5 |
| Time on the hover shade | 4.70 | **4.89** | ≥ 4.5 |
| Reply quote text | 7.58 | **9.69** | ≥ 4.5 |
| Selected text (selection fill over the bubble) | 5.74 | **11.83** | ≥ 4.5 |

Computed from the same mixes for elements the fixtures do not show in an own bubble:

| Pair | Before | After | Target |
|---|---|---|---|
| Quote "in thread" label, file chip text | 4.09 | **5.69** (5.19 on hover) | ≥ 4.5 |
| File chip text on its 8% fill | – | **5.12** | ≥ 4.5 |
| Quote text and "in thread" on the quote's hover | – | **8.44 / 4.96** | ≥ 4.5 |
| Inline code on its 8% fill / code fence on its 5% fill | 7.66 / – | **12.93 / 13.74** | ≥ 4.5 |
| Mention pills | not drawn in own bubbles | – | – |

Without the ink-role remap, the reply quote would have been 1.18:1 and "in thread" 2.19:1 on the
new bubble.

## Surfaces checked

- 1:1 chat (`chat-people`: edits, a reply quote, reactions, delivery) and group chat
  (`chat-group-runs`): own bubbles flip; incoming bubbles unchanged.
- The thread panel (`MatrixThreadPanel`) lists thread rows and draws no own bubble. Your replies
  in a thread render through the same message row and `.composer-human-message`, so they inherit
  the change. Not captured separately.
- Team Space channels (`team-space-threads`) are flat Slack-style rows with no own bubble; unchanged.
- Link previews sit under the bubble on the surface, not on it; unchanged.
- The assistant chat and pet chat use the same `.composer-human-message`; covered by the same rule.
- Light: every measured value identical before and after.

Screenshots: `node scripts/own-bubble-shots.mjs http://127.0.0.1:5197 <dir> <chrome> <label>`
against `npx vite --host 127.0.0.1 --port 5197` in `apps/desktop` (dark and light, three scenarios,
plus `<label>-contrast.json`).

## Verification

- `npm run --workspace @atum/kit check`: `build --check`, `sync-t3-design --check`, typecheck pass.
  The 19 tests pass with `--testTimeout=120000`; at the 5 s default, 4 timed out on a slow external
  disk, with no assertion failures.
- `apps/desktop`: `npm run typecheck` passes (needs `NODE_OPTIONS=--max-old-space-size=4096` on an
  8 GB machine). `npm run lint` shows 0 errors. Vitest `design-contract` (729 tests), `look/`,
  `matrix-mentions` and `start-dialog` pass.

## Known issues, follow-ups

- **Light, existing (not changed here):** a reply quote inside your own light bubble is
  `--atum-ink-soft` #3b3f47 on #1b1d22, **1.6:1**. The same remap without the `.dark` scope would
  fix it; that needs an owner call because light was kept unchanged.
- **Playground on main renders blank in dev:** since #149, `matrix/workbench.tsx` imports
  `shared/browser/update-restore.ts` → `shared/browser/policy.ts`, which reads `isIP` from
  `node:net` at import, and Vite's browser stub throws. The screenshot script stubs that one module
  in the page. The product build is unaffected by this change.
- Phone: repin atum-mobile-client to this change's merge commit (`atum-kit-tokens.json` SHA-256
  `71aaba3863620a2e758cad6e6981fd5fa164691679e25c768f0b983f9f6edc50`). The phone needs the same
  in-bubble ink treatment for its reply quote and chips in dark, and its `AtumKit.swift` comment
  ("a lifted grey in dark") needs updating.
