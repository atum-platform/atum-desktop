# Add contacts (2026-11-25)

Owner request: "add a friend" → **Add contacts**. One input finds people already on Atum by @handle or email, and
invites an email with no account to sign up. Accepting the invitation connects the two as contacts.

## What changed

- **Rename.** The Chat panel's foot entry, the start menu's footer, and the dialog are now "Add contacts", in five
  locales (`roster-create-copy.ts`, `i18n/*.ts` `addFriends`). The field is "@name or email".
- **Email is its own query** (`people.ts` `parsePersonQuery` → `{kind:'email'}`). Once typing settles (400 ms) or on
  Find, `lookupPersonByEmail` asks the existing exact-email people search, falling back to the alias directory's
  `search`. A person found this way gets the same row and **Message** as before.
- **Invite to Atum.** No one behind the address: a single row (`PersonInviteRow`) with one action. Its states are
  ready → inviting → invited ("We emailed them a link to join."), limited ("Invited recently. Try again later.",
  no button), or failed (alert, the button stays). It sends through the alias bridge as `{action:'invite', email,
  locale, requestId}` (`contact-invites.ts`, `electron/matrix/aliases.ts`). Only the Add contacts dialog passes
  `invite`, so the other `PersonSearch` users keep "not found".
- **Accepting.** The invitation mail links to `/j#<token>`, and the page opens `atum://join/<token>`, the same
  hand-off as a Team Space invite. `useContactInviteAccept` (app.tsx) first offers an opened link to
  `{action:'accept', token}`. If it is accepted, the app opens the chat with the inviter (the existing one, or a new
  direct chat) and ends the request. Any other answer passes the link on to Team Space unchanged, and Team Space
  waits for that answer.
- **Race fix in `PersonSearch`.** A snapshot update re-ran the name search, which bumped the shared generation and
  dropped an in-flight Find answer (the dialog stayed on "Searching…"). The name search now has its own counter.

## Platform (atum-platform `feat/add-contacts-invite-1125`)

Migration 0550, the `/aliases/invite` and `/aliases/accept` routes, the `/j` `contact` landing and the contact
outbox, all on the Team Space invitation keys and SES sender. Details: `docs/operations/team-space-invite-mail.md`
("Personal contact invitations") there.

## Rollout dependencies

- An older Shell answers 404 to invite. The row then shows the failed alert, and nothing else breaks.
- Mail sends only once the Team Space invite mail is activated (SES env, unpaused cron). Until then invitations
  queue, exactly like team invites.
- The signup mode must admit newcomers. Production is `public`, so no MAS registration token is needed.

## Verification

`npm run typecheck` exit 0, plus vitest on the touched suites (roster-create, contact-invites, aliases,
people, person-search, security-panel, app, team-space). Evidence comes from `scripts/add-contacts-evidence.mjs`,
which shoots the real window on playground fixtures.
