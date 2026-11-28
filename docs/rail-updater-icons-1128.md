# Rail updater in Kit glyphs; Work's nudge counts what Work shows (2026-11-28)

Owner, 2026-11-28: "The updater icons on the side rail - the check, the download box etc. - are
they consistent with the rest of our icon use? Doesnt look that way" and "i think relayed convos
are hidden now but the Work icon on side rail still showing the nudge?"

## Updater (this repo)

The control grafted from T3 in #149 drew lucide glyphs (2 px stroke) on a round 32 px tile, with
extra round buttons for "Update everything", What's new and a countdown number in the rail. Every
other rail item is a Phosphor Light glyph, 16 px, in a 36 px `atum-nav-item`, muted ink.

Now `src/matrix/updates/sidebar-pill.tsx` draws one `atum-nav-item` button with one Kit glyph:

| State | Glyph | Ink |
| --- | --- | --- |
| Up to date / idle (click checks) | `arrow-clockwise` | muted |
| Checking, and restarting after the countdown | Kit `Spinner`, turning | muted |
| Update available (click downloads) | `download-simple` | muted |
| Downloading | Kit `Spinner` ring, determinate (`value`), arc = progress | muted |
| Downloaded, ready to restart | `arrow-circle-down` + the rail's ink dot | full ink |
| Failed (check, download or install) | `warning-circle` | danger |

No text in the rail: the state is the tooltip and the accessible name; failures also go to an
sr-only status. "Update everything" (restart after T3's 5 s countdown), the countdown with its
Later, and What's new moved into the restart dialog. Closing the dialog during the countdown is
Later. Colour follows STYLE.md §3 (ink only; danger for an error glyph; attention is a dot).

`src/components/ui/spinner.tsx` gained `value` (0-100): the same ring and track, its arc drawn as a
path from twelve o'clock (dash arrays repeat under the icon system's non-scaling stroke).
`src/lib/icons.ts` adds `CircleArrowDown` (Light). The vendored `DesktopUpdateStatusIcon` is no
longer imported.

Before / after, rendered from the real components with `src/icon-system.css`:
`docs/rail-updater-icons-1128/rail-updater-light.png`, `rail-updater-dark.png`.

## Work nudge (atum-work)

The badge is computed inside Work (`apps/web/src/atum/AttentionReport.tsx`) and only relayed here.
Hidden relay threads were already out of its list. The dot came from three relay threads made
before the `hidden` launch flag (runtime design keeps their original visibility): they sit in Work's
folded Settled shelf, yet their unseen completions still counted. Fix on atum-work
`fix/work-nudge-settled`: a settled thread no longer counts as finished-unseen; a thread that asks
for an approval or answer still counts wherever it sits. See that branch's
`docs/work-nudge-settled-1128.md`. Ships with the next Work runtime pin.

## Verification

- `npx vitest run src/matrix/updates src/matrix/desktop-settings.test.tsx src/app/atum/shell-surface.test.tsx src/components/ui src/matrix/rail-badges` — 124 passed, 1 skipped.
- `npx vitest run src/matrix/app.test.tsx -t update` — 2 passed.
- `npm run typecheck`, eslint on touched files — clean.
