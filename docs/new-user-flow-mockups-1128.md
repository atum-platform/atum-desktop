# New user flow storyboard (2026-11-28)

**What:** a frame-by-frame storyboard of a brand-new person's first 48 hours, from the welcome story to
steady state, at `docs/mockups/new-user-flow/` (25 frames, 34 PNGs, key frames in light and dark, phone where
the plan touches it). Open `index.html` there; `README.md` lists the frames and the Connections list rules.

**Why:** the owner asked to see exactly what new users see before the unified first run deploys
(2026-11-28: "I want mockups to see exactly the flow for new users"). It follows the plan of record
`docs/plans/2026-11-28-unified-first-run-and-48h.md` and the three approved recommendations: the 48-hour clock
starts at the welcome, first learning starts with whatever is connected, and the starter-grant line goes.

**Design decisions taken here (UI/UX):**
- One Connections list in three groups (AI plans, Accounts, This Mac), one action per row, states Connect →
  spinner → Connected → or Skipped; "Skip the rest" closes it. Rows with nothing to offer are hidden.
- One browser trip per provider: Google (mail, calendar, Drive) and Antigravity stay separate rows, because
  nothing today lets the Google connection sign Antigravity in.
- Plan rows show a sub-line only when there is something to say (the plan name when Ready).
- "Let Nova use this Mac" is the plain-words row for Remote Login; Messages asks for Full Disk Access from its
  own row. macOS prompts come only from their row, one at a time.
- No canned greeting: a typing bubble, one retry after 20 s ("Taking a little longer…"), then one quiet line
  with Try again. The Connections list still appears so nobody is stuck.
- The list stays in the chat as a past item and later reads as one summary line with a Settings link.

**How it was made:** `python3 docs/mockups/new-user-flow/src/build.py` renders static HTML on
`packages/atum-kit/dist/atum-kit.css` and the pinned Phosphor paths and screenshots it with headless Chrome
(same approach as the agent-card mockups). Chrome on macOS can crash during teardown after writing the file,
so the script checks the PNG instead of the exit code.

**Not covered:** language from the owner's stored preference (slice E); the cloud slices B–D.
