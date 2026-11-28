# Rail tips over Work, updates in General (2026-11-28)

Owner, 2026-11-28, testing 0.20.55 (desktop `942096b7`, Work runtime 0.1.20): "Work still seems to be
layered differently - covering tooltips. Settings look the same as before? Filter button now added to
Chat but gone from Work?" Earlier: "versions and updates should probably be in General".

The Work filter is fixed in `atum-work` (`fix/work-list-filter`, `docs/work-list-filter-1128.md`); it
reaches the app with the next Work runtime pin. This note covers the desktop's two.

## 1. Rail tips under the Work view

**Cause.** Work is a native `WebContentsView` placed over the Work card (`use-work-view-placement.ts`,
`electron/work/surface/place-view.ts`), and a native view paints above every DOM node. The rail's tips
are Kit chips in the DOM. They open to the right of the 52 px rail (destinations, the account) or above
the button and wider than the rail (the update button's "Up to date"), so in Work they land on the view
and are drawn underneath it. In Chat nothing native sits there, so the same tips show.

**Why not the other ways.**
- Keep the tips inside the rail: the rail is 52 px; nearly every label ("Up to date", "Discover", a
  name) is wider.
- The app-view overlay hold (`app-view-overlay.ts`), which detaches a native view while a surface
  covers it: Work would vanish on every pass of the pointer across the rail, the blink that hold was
  already narrowed to avoid for the PDF viewer.

**Change.** While the Work view is on screen (`workOnScreen` and the view `ready`), the rail's tips are
the system's own tooltip (`title`), which macOS draws in its own window above every view. Everything
else, including the rail in Chat, keeps the Kit chip.
- `src/components/ui/tooltip.tsx`: `TipNative`. Inside it, a `Tip` with a text label sets `title` on its
  trigger and opens no DOM chip (so it never asks a native view to detach). A rich label keeps the chip.
- `src/matrix/app.tsx`: the rail (destinations and foot) sits in `TipNative`, on while Work is shown.
- `electron/native-tooltip-delay.ts`: AppKit waits about a second before a tooltip; the app registers
  `NSInitialToolTipDelay` = 120 ms in its own defaults' registration domain, so the system tip comes
  close to the Kit's instant one. macOS only; a failure never blocks startup.

What the owner sees: in Work, hovering a rail button shows its name above the Work view after a beat,
in the system's tooltip style. In Chat nothing changes.

## 2. Version and updates in General

`MatrixUpdateSettings` (the Updates section: "Atum <version> · <status>", check, download, restart,
channel) moved out of Help into the top of Settings › General, above Look. It reads the same updater the
rail's button runs (`desktop-services.ts`: `update` and `desktopUpdate` both come from the grafted T3
updater). Help keeps "Help improve Atum", contact and legal. Nothing else in Settings moved; the larger
Settings restructure is its own row.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| typecheck | `npm run typecheck` (apps/desktop) | rc 0 |
| eslint | touched files, and `app.tsx`, `app.test.tsx`, `electron/matrix/main.ts` | 0 errors (warnings only on untouched lines) |
| vitest | `tooltip.test.tsx`, `native-tooltip-delay.test.ts`, `desktop-settings.test.tsx`, `settings-revamp.test.tsx`, `settings-sheet.test.tsx`, `overlay-inventory.test.ts`, `app-view-overlay-hold.test.tsx`, `shell-surface.test.tsx`, `src/matrix/updates`, `app.test.tsx` | all pass |
| public guard | `python3 scripts/public_guard.py --base origin/main --head HEAD` | rc 0, PASS |

Not verified visually: the system tooltip above the Work view needs the signed app with a running Work
runtime, which this lane did not build.
