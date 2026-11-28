# New user flow: storyboard

What a brand-new person sees and experiences, from first launch to the 48th hour. Open
[`index.html`](index.html) for the frames in order, with a light/dark toggle.

- Plan of record: `docs/plans/2026-11-28-unified-first-run-and-48h.md` (branch `docs/unified-first-run`).
- Owner decisions behind it (2026-11-28): the 48-hour clock starts at the agent's welcome (or first owner
  message), not at sign-up; first learning starts with whatever is connected and deepens when Google arrives;
  the starter-grant line leaves the first chat.
- Rebuild: `python3 docs/mockups/new-user-flow/src/build.py` (real Atum Kit CSS and Phosphor icons,
  headless Chrome). `--html-only` skips the screenshots; frame ids as arguments rebuild only those.

Every PNG carries its own timeline strip and one-line trigger caption. Agent lines are **examples of the
agent's own voice**; the product never ships them as fixed text. Names are generic: the assistant is "Nova",
the owner is unnamed, the people in the example work are roles. Dashed pills inside a chat are storyboard
notes, not UI.

## Frames

| # | Frame | When | What triggers it | Light | Dark |
| --- | --- | --- | --- | --- | --- |
| 01 | Welcome story | before sign-in | First launch on this Mac; plays once | ✓ | |
| 02 | Sign in | before sign-in | The story ends on Continue with Google / Continue with email | ✓ | ✓ |
| 03 | Sign up with email | sign-up | Email sign-up in the browser; Turnstile checks for a human before the account exists | ✓ | |
| 04 | Launch screen | sign-up | Account created; during the ≈2.6 s hold Atum reads this Mac's AI plans and picks one | ✓ | ✓ |
| 05 | Nova is writing | T+0 | The chat opens and the welcome request goes out; the chip shows the plan Atum picked | ✓ | |
| 06 | Taking longer | T+0 | No welcome after 20 s: Atum asks once more (no ready-made greeting stands in) | ✓ | |
| 07 | Still no answer | T+0 | The retry also went unanswered: one quiet line and Try again; Connections still work | ✓ | |
| 08 | The welcome | T+6 s | Nova's own welcome; **starts the 48-hour clock**; one Connections list follows | ✓ | ✓ |
| 09 | Connect Google | +2 min | One browser trip per provider: Google covers mail, calendar and Drive | ✓ | |
| 10 | This Mac: folders | +2 min | macOS asks for each folder in turn, from the Folders row only | ✓ | |
| 11 | This Mac: use the Mac | +2 min | One password prompt turns on Remote Login; Messages waits on Full Disk Access | ✓ | |
| 12 | Everything answered | +2 min | Every row connected or skipped; the list stays in the chat as a past item | ✓ | ✓ |
| 13 | First learning | +2 min | The first Connect starts learning on what is connected (Mac and chats) | ✓ | ✓ |
| 14 | Learning goes deeper | +4 min | Google arrives; the same run reads calendar and mail (no second run) | ✓ | |
| 15 | Nudge 1 | +5 min | Warm-up nudge 1, five minutes after the welcome | ✓ | ✓ |
| 16 | Nudge 2 | +15 min | Nothing worth saying: silent | ✓ | |
| 17 | Nudge 3 | +35 min | The next useful offer | ✓ | |
| 18 | Nudge 4 on the phone | +60 min | Reaches the phone when the Mac is away | ✓ | |
| 19 | Day 1 evening | 18:00 | Hourly day-1 check-in that has something to say | ✓ | |
| 20 | Morning brief | Wed 08:00 | The 08:00 brief | ✓ | ✓ |
| 21 | Morning brief on the phone | Wed 08:00 | The same brief as a notification and in the phone chat | ✓ | ✓ |
| 22 | Quiet suggestion | 11:30 | At most one a day | ✓ | |
| 23 | Day 2 taper | from hour 32 | Check-ins every 2 h until hour 48, mostly silent | ✓ | |
| 24 | Steady state | hour 48 | Ordinary follow-up sweep (every 2 h, 09:00–20:00), 08:00 brief, 11:30 suggestion | ✓ | ✓ |
| 25 | Phone first | T+0 | No welcome request from a phone; the first message starts the clock | ✓ | |

## The Connections list (what slice A builds)

One list under the welcome, in the T3 Agents-row style, built from one data list. Three groups, a row per
connection, one action per row:

| Group | Rows | Connect does |
| --- | --- | --- |
| AI plans | ChatGPT, Claude, Antigravity, OpenCode | The provider's own sign-in in the browser (OpenCode: the key sheet). The default model re-picks. |
| Accounts | Google (mail, calendar and Drive) | One browser trip for every Google source |
| This Mac | Folders, Messages, Browser, Location, Let Nova use this Mac | Folders: one macOS prompt per folder, in turn. Messages: Open Settings for Full Disk Access. Browser: the import. Location: on by default (city only). Use this Mac: one password prompt for Remote Login. |

Row states: **Connect** → **spinner** (sub-line says where to finish) → **Connected** (brief tint; rows that
were already on read **Ready**) → or **Skipped** (dimmed, Connect stays available). "Skip the rest" marks every
open row skipped; with nothing connected it declines first learning, as "Not now" did. The list foot says the
assistant reads these from the cloud (the disclosure). Rows that have nothing to offer are hidden. Ready plans
rise to the top. Which folders, and Add folder, stay in Settings › Connections.

Rules the frames hold to: one focus per state; one action and at most one line per row; no starter-grant
line, no composer Google chip, no stacked Mac prompts (they come only from their own row); no ready-made
agent text anywhere; no balance meters.

Not in these frames: language from the owner's stored preference (slice E) and the cloud side (slices B, C,
D) that makes learning start without Google and anchors the warm-up to the welcome. Antigravity keeps its own
sign-in: nothing today lets the Google connection sign Antigravity in, so folding the two into one trip needs
that link first.
