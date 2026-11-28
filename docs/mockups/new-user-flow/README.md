# New user flow: storyboard

What a brand-new person sees and experiences, from first launch to the 48th hour. Open
[`index.html`](index.html) for the frames in order, with a light/dark toggle.

- Plan of record: `docs/plans/2026-11-28-unified-first-run-and-48h.md` (branch `docs/unified-first-run`).
- Owner decisions behind it (2026-11-28): the 48-hour clock starts at the agent's welcome (or first owner
  message), not at sign-up; first learning starts with whatever is connected and deepens when Google arrives;
  the starter-grant line leaves the first chat.
- Owner review of the first version (2026-11-28): "the first run flow - should it be a little more natural
  conversation like we used to have? And should everything be tried automatically first (user just clicks
  confirms) before asking user to manually start the connection process? The rest ok". Frames 08a–08i are
  the answer; everything else was approved as it was.
- Rebuild: `python3 docs/mockups/new-user-flow/src/build.py` (real Atum Kit CSS and Phosphor icons,
  headless Chrome). `--html-only` skips the screenshots; frame ids as arguments rebuild only those.

Every PNG carries its own timeline strip and one-line trigger caption. Agent lines are **examples of the
agent's own voice**; the product never ships them as fixed text. Dashed "tapped …" pills mark which button was
pressed; they are storyboard notes and nothing is sent to the chat. Names are generic: the assistant is "Nova",
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
| 08a | The welcome asks | T+6 s | Everything that needs no prompt is already connected; Nova's own welcome names it and asks for the rest; **starts the 48-hour clock** | ✓ | ✓ |
| 08b | Sure: folders | T+6 s | Sure runs the remaining steps in turn, each as the native macOS prompt only; first one prompt per folder | ✓ | ✓ |
| 08c | Sure: Messages | +2 min | Full Disk Access, which macOS grants only in its System Settings pane; first learning is already reporting | ✓ | |
| 08d | Sure: this Mac | +2 min | One password prompt turns on Remote Login; denied or skipped steps settle quietly | ✓ | |
| 08e | Google, last | +2 min | The only manual step, offered last as one tap | ✓ | ✓ |
| 08f | Google in the browser | +2 min | One browser trip covers mail, calendar and Drive | ✓ | |
| 08g | All set | +2 min | Everything answered: the ask shrinks to one summary line; learning keeps going | ✓ | ✓ |
| 08h | Not now | T+6 s | Settles quietly; the way back stays one tap away | ✓ | |
| 08i | Choose what to connect | T+6 s | One tap opens the full Connections list (kept, row by row) | ✓ | |
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

## The first minutes (what slice A builds)

1. **Automatic first.** Before anything is asked, Atum connects what needs no action from the person: the AI
   plans already signed in on this Mac (picked during the launch screen), and every source macOS lets it read
   without a prompt (location, chats in Atum, and any folder, Messages, Google or Remote Login permission this
   Mac already granted). The first such source starts first learning, as any Connect does.
2. **The agent asks, in its own words.** Nova's welcome names what it already has and asks to read the rest.
   The desktop renders only **one action row** under it: **Sure** (confirm all), a quiet **Not now**, and
   **Choose what to connect** one tap away. The line under it is the disclosure ("Nova reads these from the
   cloud"). The agent writes the question; the row is UI chrome.
3. **Sure runs the rest, one after another, each as the native macOS prompt only:** folders (one prompt per
   folder) → Messages (Full Disk Access in its System Settings pane; the step settles when the person comes
   back to Atum) → Remote Login (one password prompt). A denied or skipped step settles quietly and the next one
   runs; nothing blocks the chat. Progress is one compact line in the row's place: "Reading Documents and
   Desktop… · Messages next".
4. **Google last, as one tap.** Its browser sign-in is the only step that needs the person's own click, so the
   row ends on **Connect Google** with a quiet Not now.
5. **Done** leaves one summary line ("Connected Google, Documents, Desktop, Messages and this Mac") with Choose
   what to connect beside it. **Not now** leaves only Choose what to connect.

Kept out of Sure on purpose: the other AI plans (each is its own browser sign-in; they stay in the list) and the
browser import (it moves sign-ins off the Mac behind Touch ID, so it stays an explicit choice in the list).

## The Connections list (behind Choose what to connect)

One list, in the T3 Agents-row style, built from one data list. Three groups, a row per connection, one action
per row:

| Group | Rows | Connect does |
| --- | --- | --- |
| AI plans | ChatGPT, Claude, Antigravity, OpenCode | The provider's own sign-in in the browser (OpenCode: the key sheet). The default model re-picks. |
| Accounts | Google (mail, calendar and Drive) | One browser trip for every Google source |
| This Mac | Folders, Messages, Browser, Location, Let Nova use this Mac | Folders: one macOS prompt per folder, in turn. Messages: Open Settings for Full Disk Access. Browser: the import. Location: on by default (city only). Use this Mac: one password prompt for Remote Login. |

Row states: **Connect** → **spinner** (sub-line says where to finish) → **Connected** (brief tint; rows that
were already on read **Ready**) → or **Skipped** (dimmed, Connect stays available). "Skip the rest" marks every
open row skipped; with nothing connected it declines first learning, as "Not now" does. The list foot says the
assistant reads these from the cloud (the disclosure). Rows that have nothing to offer are hidden. Ready plans
rise to the top. Which folders, and Add folder, stay in Settings › Connections. Frame 07 (no welcome at all)
shows this list directly: with no agent question, a bare Sure would ask nothing.

Rules the frames hold to: one focus per state; one action row and at most one line per state; no starter-grant
line, no composer Google chip, no stacked Mac prompts (they come only from their own row); no ready-made
agent text anywhere; no balance meters.

Not in these frames: language from the owner's stored preference (slice E) and the cloud side (slices B, C,
D) that makes learning start without Google and anchors the warm-up to the welcome. Antigravity keeps its own
sign-in: nothing today lets the Google connection sign Antigravity in, so folding the two into one trip needs
that link first.
