# Hire an open listing from the new-assistant sheet (desktop)

Session log, 2026-11-22. Owner decision D9: hire assistants off the marketplace. Slice 1 is the
open **Researcher** listing, hired by a person for their personal account. Pricing is the
existing seat fee plus usage: the first two assistants are free, the third and later cost
60,000 Protons a month, confirmed before the hire. Prices are shown in Protons only.

State: **built, not live.** The platform route (`/agents?catalog=open`, `listingId` on
`POST /agents`) ships separately, and both changes must be deployed together before this UI does
anything for real users.

## Where it lives

No new screen. The existing **New assistant** sheet (`NewAssistantDialog`,
`apps/desktop/src/matrix/agent-roster.tsx`) gains a "Ready to hire" shelf above the form, with a
"Make your own" label over the existing fields. When the platform returns no listings, or the
native host is older, the shelf is hidden and the sheet is exactly what it was before.

Picking a listing gives the sheet one focus at a time (`apps/desktop/src/matrix/listing-hire.tsx`):

| State   | What shows                                         | Action        |
| ------- | -------------------------------------------------- | ------------- |
| list    | face (round), title, one line, Hire                | Hire          |
| confirm | the price once ("60,000 Protons/month"), only for a third+ assistant | Hire / Back |
| hiring  | "Hiring Researcher…"                               | (disabled)    |
| done    | "Researcher is in your chats."                     | Done          |
| short   | the existing short-wallet line                     | Top up Protons / Back |
| error   | "Couldn't hire Researcher. Try again."             | Retry / Back  |

A free seat hires in one press, with no confirm step. Hiring the third or later assistant shows
the price first. A `hire_required` refusal from the platform (for example, when the catalog's
quote was stale) also leads to the confirm step. No balance meter appears anywhere. The face is
a circle, following the Kit rule that assistants are round (STYLE.md §5). It reuses `StoreArt`
with a new `face` flag and draws the catalog glyph as Phosphor `magnifying-glass`, never as an
emoji. The hired assistant takes the listing's title in the person's language (for example
"Nhà nghiên cứu"). If the person already has an assistant with that name, a number is added
("Researcher 2"). They can rename it later in conversation. A handle is claimed after the hire,
as for a made assistant. Any failure there is left to the assistant's card.

## Native path

- `listMatrixOpenAgents` (`electron/matrix/agent-definition.ts`) reads
  `GET /agents?catalog=open` with the existing domain bearer. Rows the client cannot show are
  dropped, and the catalog's accent colour is ignored because the Kit allows no raw colour.
  `endpoint()` now accepts a fixed query string on the path.
- `createMatrixAgent` sends an optional `listingId`. On retry it keeps the same request UUID,
  name and listing.
- `MatrixAgentLifecycle.hire(name, listingId, hireConfirmed)`
  (`electron/matrix/agent-lifecycle.ts`):
  - resumes an unfinished hire of the same listing under its original request, so Retry or a
    relaunch never hires twice, and a confirmation given later carries over;
  - **skips the post-create persona write.** `define()` would replace the server's seeded
    definition;
  - treats every listing hire as cloud-owned, including `capacity`. The platform refuses a
    listing it cannot compose natively and never sells a Mac-run fallback, so no local room,
    executor or connect runs.
- IPC: `openAgents` and `hireAgent` (`ui-preload.ts`, `main.ts`). Main checks the name against
  the owner's assistants and validates the listing id (1–128 characters). No owner identifier
  crosses the bridge. Refusals map exactly as for `createAgent` (`{ hire }`, `short`, `name`,
  `limit`, `account`).

## Verification

- `npm run typecheck` (apps/desktop): passed.
- `npm run lint`: 0 errors. The warnings are already present across the repo.
- Vitest: `src/matrix/listing-hire.test.tsx` (new), `electron/matrix/agent-lifecycle.test.ts`
  and `electron/matrix/agent-definition.test.ts` (new cases), plus the neighbouring suites
  (`new-assistant`, `agent-profile`, `vietnamese-copy-guard`, `store-card`, `playground`,
  design contract, i18n, `app`, `quiet-launch`, `founder-app`, `roster-create`): 1,494 passed.
- Screenshots of every state, in light and dark (en) and in Vietnamese (light), were saved to
  `docs/evidence/2026-11-22-hire-researcher-ui/` in the build worktree. That folder is
  gitignored (`**/evidence/`), so they are not in this commit. They were captured from the playground's new
  views (`matrix-playground.html?view=hire-list|hire-confirm|hire-hiring|hire-done|hire-short|hire-error`).
  The capture script presses Hire where a state needs it.
- Copy: six new keys in `roster-create-copy.ts`, in all five locales. None of them is in
  `phone-export-keys.json`, so the phone export is unchanged.

## Open and next

- Gates: platform deploy of the catalog and listing route, then installed-app acceptance of a
  real hire (identity, cloud placement, roster row, first reply). The first live hire needs the
  owner's go.
- Not built in this slice: company hires, protected listings, and a listing price separate from
  the seat fee.
