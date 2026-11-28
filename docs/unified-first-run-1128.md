# Unified first run, slice A (2026-11-28)

**Plan of record:** `docs/plans/2026-11-28-unified-first-run-and-48h.md` (branch `docs/unified-first-run`), slice A.
**Storyboard:** `docs/mockups/new-user-flow/` (branch `docs/new-user-flow-mockups`), frames 05–12.
**Owner decisions (2026-11-28):** the 48-hour clock starts at the welcome; first learning starts with whatever is
connected; the starter-grant line leaves the first chat.

## What changed

- **One sequencer.** `src/app/connections/first-run-controller.ts` decides what the first chat shows, in order:
  the assistant's own welcome, then the one Connections list, then other first-chat notices.
  - While the welcome is written: a typing bubble.
  - No welcome after 20 s (`FIRST_RUN_GREETING_RETRY_MS`): the hidden welcome request goes once more, with
    "Taking a little longer…" under the bubble.
  - Still nothing after another 20 s: one quiet line ("Atum isn't answering yet.") and Try again.
  - The list shows after the welcome or with the quiet line, so nobody is stuck behind a silent assistant.
  - `$firstRunListOpen` holds the Mac sources notice while the list has unanswered rows.
- **No canned greeting.** The ready-made greeting and intro are gone from `MatrixFirstRunCard` and from
  `shared/matrix-first-run-copy.ts` (all five languages). The launch panel shows the typing bubble beside the
  readiness line.
- **One data-driven Connections list** (`src/app/connections/first-run-connections.tsx`), three groups:
  - AI plans: ChatGPT, Claude, Antigravity, OpenCode, unchanged behaviour (provider's own sign-in, OpenCode key
    sheet, re-pick, Ready first).
  - Accounts: Google, one browser trip.
  - This Mac: the source descriptors (folders, Messages, browser, location, team spaces) plus a reach-down row
    ("Let <name> use this Mac", Remote Login under the hood, from `useMatrixNativeMac`).
  - One action per row: Connect → spinner → Connected (Ready if it was already on), or Skipped. "Skip the rest"
    marks open rows skipped. The foot carries the cloud disclosure (still counted as presented after a second
    on screen, `useNoticePresented`).
  - Rows with nothing to offer are hidden.
- **Per-row logic** moved from the old two-step card into `src/matrix/first-run-sources.ts`
  (`useFirstRunSources`). Every function stays:
  - folders: one macOS prompt per default-ticked folder;
  - Google: connect in the browser only when the account isn't connected yet;
  - Messages: Full Disk Access in System Settings, finishing by itself on the grant or asking for a restart;
  - browser: the import;
  - location: the city switch.
  - The first connected source admits first learning (`firstRun.start`, or `allow` on an older bridge), once.
  - "Skip the rest" with nothing connected declines it, as "Not now" did.
  - Picking which folders, and Add folder, stay in Settings › Connections.
- **macOS prompts come only from their own row.** The reach-down row asks for Remote Login (one password prompt)
  or opens System Settings. Nothing is stacked over the list.
- **Removed:**
  - the separate sources card (`first-run-connect-card.tsx`, its test and browser proof);
  - the composer Google chip and its in-memory dismissal (`MatrixGoogleConnectNudge`);
  - the starter-grant line (`starter-notice.tsx`, `starter-copy.ts`; main's `starterSeen` command is left as is
    and now unused by the renderer);
  - the unused welcome storyboard (`welcome-storyboard.tsx`);
  - the first-run folder checklist rows (`MatrixFirstRunFolderRows`).
- **Where the list lives:** in the welcome card while the first run is open, under the welcome message once the
  person writes, and at the start of the primary assistant's chat. It is the same list everywhere. Outside the
  card it admits learning only while the account's welcome is still open (`firstRunOpen`).

## Round 2: the conversational ask (owner review, 2026-11-28)

Owner, verbatim: "the first run flow - should it be a little more natural conversation like we used to have? And
should everything be tried automatically first (user just clicks confirms) before asking user to manually start the
connection process? The rest ok". Storyboard frames 08a–08i (branch `docs/new-user-flow-mockups`).

- **Automatic first.** As soon as the list mounts (hidden while the welcome is written, so the welcome can name it),
  `useFirstRunSources().autoConnect()` connects every row that needs no action from the person
  (`firstRunAutoConnectable`): location and Atum's own chats always; folders, Messages and Google once this Mac
  already granted them; another source when it already works. Never the browser import (it moves sign-ins off the
  Mac behind Touch ID). It runs once per window (`claimFirstRunAutoPass`) and only while the first run is open.
  The AI plans were already auto-picked on the launch screen.
- **Learning waits for the answer.** The automatic pass does not admit first learning: `firstRun.start` closes the
  welcome, which would happen before the welcome arrives. Sure, Not now, or any Connect admits it on what is
  connected. Not now (and Skip the rest) with something connected starts learning on it; with nothing connected it
  declines, as before.
- **One action row under the agent's own ask** (`FirstRunConnections presentation="ask"`): Sure, a quiet Not now,
  and Choose what to connect, which opens the same list as before (kept, row by row). The line under it is the cloud
  disclosure. The agent writes the question; the row is UI chrome.
- **Sure runs the rest in order** (`runFirstRunSure` in `first-run-controller.ts`): folders (one macOS prompt per
  folder) → Messages (the Full Disk Access pane; the step settles on the grant or when the person comes back to
  Atum) → this Mac (one Remote Login password prompt, or the promptless setup). Each step settles before the next
  starts; a denied or left step settles quietly. Progress is one line in the row's place ("Reading Documents and
  Desktop… · Messages next"). Google's browser sign-in comes last as one tap (Connect Google, with a quiet Not
  now). Done leaves one summary line ("Connected Google, Documents and Messages").
- **Why the state lives in the controller:** the first connected source admits learning, which closes the welcome
  card, so the list moves from the card to under the welcome message mid-run. The ask state is a nanostore
  (`$firstRunAsk`) and the runner talks to whichever list is mounted (`registerFirstRunAskRunner`), waiting up to 5 s
  for it to come back.
- **Under an old welcome** (a later session, welcome already closed) the plain list shows, never a second Sure
  (`firstRunEffectivePresentation`). With no welcome at all (the quiet state) the card shows the list directly: a
  bare Sure would answer nothing.
- `useMatrixNativeMac().run` now returns a promise that settles when main answers, and an owner action queues behind
  a focus refresh instead of being dropped (the window regains focus right after each macOS prompt).

Kept out of Sure on purpose: the other AI plans (each is its own browser sign-in) and the browser import.

## Decisions taken without the owner (UI/UX authority)

- Antigravity stays its own plan row. Nothing today lets the Google connection sign Antigravity in, so "one trip
  per provider" means one for Google's sources and one for Antigravity. Folding them needs that link first.
- The retry waits 20 s each step: long enough for a cold container, short enough not to feel stuck.
- A skipped row keeps a quiet Connect, so nothing needs Settings to undo a skip.

## Overlap with open work

- `src/matrix/app.tsx` is also touched by #162 (rail tips/updater/settings) and the `fix/work-layer-parity`
  lane. The edits here are small and local: the first-run card props, the list props, removing the starter
  notice and Google chip mounts, and the notice hold. Expect a trivial merge.
- `src/matrix/app.test.tsx`: #162 touches it too; this change edits only the first-run tests.
- No overlap with #161 (electron Work model default).

## Verification

See the check table in the hand-off message: typecheck (all three tsconfigs and the client boundary), eslint on
every touched file, the focused vitest set, the whole `app.test.tsx`, and the broader UI suites.

## Pending (other slices)

- atum-app (cloud controller, `packages/cloud-controller/hermes-plugin/work_provider.py`): the welcome guidance still
  says "Point to the Connections list below". For the conversational ask it must (1) give the agent the account's
  connected sources and the ones it may still ask for, as data in `_greeting_prompt`'s facts, and (2) ask it to name
  what it already has and end with one question asking to connect the rest. Until then the welcome reads slightly
  off against the Sure / Not now row, but nothing breaks.

- B, C (app): learning without the Google gate; warm-ups anchored to the welcome or first owner message. Until
  C ships, the cloud still times nudges from activation.
- E (desktop + platform): the welcome seed's language from the owner's stored preference instead of the UI locale.
- F: live acceptance on a test S2 agent.
