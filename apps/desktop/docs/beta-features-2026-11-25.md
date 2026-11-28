# Beta features: Team Space, hires and skills (2026-11-25)

**Owner, 2026-11-25:** "gray out team space for public users as coming soon", "maybe we need to gray
out skill and hires too until we figure it out clean", "I still want to be able to work on it and
test it myself - so maybe some kind of beta class user?"

## What changed

Beta accounts keep Team Space, hires and skill purchases unchanged. Everyone else sees them greyed
out as "Coming soon". Nothing is hidden, and no error state appears.

| Place | Without beta features |
|---|---|
| Rail, Team space | Drawn greyed (`data-surface-state="coming_soon"`, `aria-disabled`). A press shows the rail's "Coming soon / This place is not ready yet." popover and goes nowhere. |
| Team Space screens | A link, notification or selected company room lands on one calm "Coming soon" page (`data-team-space-coming-soon`). No company call, no transcript, no composer. Settings trips to an assistant's pages still open. |
| Store, hires and skills | The card's button reads "Coming soon" and is greyed. The sheet still opens with its description and facts, and its action is a disabled "Coming soon". There is no picker, renewal box or balance. |
| Store, pets and apps | Unchanged and purchasable. |
| Already owned items | Never greyed out. "Owned" and "Try now" still work. |
| New assistant, "Ready to hire" | Listings show, and each button reads "Coming soon" (disabled). "Make your own" is unchanged. |
| Composer paperclip, "Add a skill" | Greyed, disabled, with "Coming soon" at the end of the row (`data-composer-plus-coming-soon`). Photos, files and routines are unchanged. (2026-11-26) |
| Assistant card, Skills popover | The skills the assistant has stay listed. "Find more skills" is greyed and disabled, with "Coming soon" in place of the arrow (`data-assistant-card-skills-coming-soon`). (2026-11-26) |

All labels reuse `t.surfaces.comingSoon` and `t.surfaces.comingSoonHelp`. No new copy strings were added,
so the mobile copy export inventory is unchanged. The phone gets both from the mobile design snapshot as
`desktop.surfaces.{comingSoon,comingSoonHelp}` (wave 4g, `docs/ports/mobile-export-wave4-copy.md`).

Checked and left alone on 2026-11-26: Settings has no hire or skill entry of its own (an assistant's
page reuses the card above). Team Space's Marketplace page sits behind the Team Space gate. The Store
sidebar's Skills and Assistants shelves stay browsable, because every hire and skill card in them
already reads "Coming soon". The legacy "Browse skills" button in the app capability dialog is not
wired in the Matrix build (`native-apps.tsx` passes no `onBrowse`). Renewing a paused hire you
already own is unchanged, since things you already own are never greyed out.

## How beta is read

- `shared/beta-features.ts`: `readBetaFeatures(me)`, the one reader. Only `betaFeatures: true` on the
  platform's `/me` answer counts. Anything else is "not beta".
- `electron/matrix/domain.ts`: `readDomainIdentity` carries `betaFeatures: true` through from `/me`.
- `electron/matrix/main.ts`: the UI request `betaFeaturesRead` calls `account.readDomain(false)`,
  which never prompts sign-in. It returns `true` or `false`, or `null` when `/me` cannot be read now.
- `src/store/beta-features.ts`: a per-profile atom with a localStorage cache. `null` or a failed read
  keeps the last answer, so a beta account is not greyed out by one missed read. A late answer for
  another profile is ignored.
- `src/matrix/surface-sources.ts`: reads the answer when the profile is ready and projects Team
  Space as `on` (beta) or `coming_soon`.
- The playground bridge answers beta. `?beta=0` shows the public state.

## Platform dependency (not in this repo)

The Shell's Matrix `/me` (`GET /api/matrix/v1/me`, `matrix-authority.ts` `resource === "me"`)
does not yet return `betaFeatures`. Until it does, **every account, including the owner's, sees the
"Coming soon" state.** The Shell route must land before or with the release that ships this change.

Contract: `/me` adds `"betaFeatures": true` for a beta principal and omits the field (or sends
`false`) otherwise. The existing fields `issuer`, `subject` and `principal` stay as they are.

Caveat for the platform: `atum.has_beta_access()` (0051) is scoped to `auth.users` and returns true
for **every** caller while `beta_access_settings.enforced = false`. It also returns true for any
account that ever minted or redeemed an invite. Matrix principals are not `auth.users` rows (0271
notes this). The per-principal operator fact that already exists for Matrix principals is the 0271
roster audience assignment (`atum_private.roster_audience(principal) = 'internal'`). The platform
decides which one it uses.

This is presentation only: the platform does not enforce the gate on the Team Space, store or hire
routes. A direct API call still works.

## Verification

- `npm run typecheck` (all three projects) passes.
- `npm run lint`: 0 errors.
- The full `vitest --project ui` run was 897 of 898 files passing; the one failure was
  `app.test.tsx`, fixed below. After the fix, `app.test.tsx` passes (462 tests), and so do the
  focused store, hire, workspace, surface, domain and preload suites. New tests cover both states.
