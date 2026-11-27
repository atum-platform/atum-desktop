# First-run automatic plan pick, Connections and in-app links (2026-11-27)

Owner requests, 2026-11-27:

- "can we do auto-connection with available subs on that machine instead of having to make users manually click? … hide that behind the loading screen so when first agent chat screen shows up, we already auto-pick the suitable sub … First step on agent can still be connection - a list of the common ones like chatgpt, claude, antigravity and opencode; whatever is already connected shows Ready, what's not shows Connect … reuse natively".
- The owner's answers: "Always default to auto if we can" (ChatGPT included). Claude Sonnet first, then ChatGPT Sol. The Connections block stays in the chat. The provider mark on the chip is enough.
- "shouldn't we always default to the in-app browser for any and all links clicked inside the app?"

**State:** built on `feat/first-run-autoconnect`, not live. The coordinator owns assembly, cross-family review, PR, CI and release. Design of record: `~/.atum/operations/evidence/mockups-1127-r2/` (NOTES.md, COPY.md). Pick table: atum-app `docs/first-run-subs-plan`, `docs/plans/2026-11-27-first-run-subscriptions.md` › Default picks. The owner's answers replace that plan's consent steps.

## What happens

1. **At launch.** While the eclipse launch holds, `useFirstRunAutoPick` (`src/app/connections/use-first-run-auto-pick.ts`) runs one pass (`src/app/connections/first-run-store.ts`):
   - It reads this Mac's four connections from T3's native status (`work.readPlanLabels`, new and local-only). It also reads the plans each agent can use (`work.readAgentPlans`, existing) and the account's OpenCode Go key (`subscriptions.status`, existing).
   - It picks with `shared/first-run-pick.ts`: Claude paid → Sonnet, then ChatGPT paid → Sol, then Antigravity paid → Gemini Flash, then OpenCode Go → DeepSeek V4.1 Flash, otherwise Atum (GPT-6 Luna).
   - It writes through the existing paths, primary assistant first and then the cloud roster. A plan goes through `grantAccountPlanUse` and then `work.selectRelay` (`work_selection_set`). OpenCode Go goes through `modelDestinations.writeSubscription(…, 'opencode_go', …)`.
   - Every mounted picker's chip updates at once (`acknowledgeAgentPlanSelectionForAgent`).
   - It runs again when Work becomes ready, the roster changes, a Connect finishes, the Settings switch turns on, or the window regains focus (at most every 5 min).
2. **The first chat.** The primary assistant's welcome card (`src/matrix/first-run-card.tsx`) shows its greeting, then the Connections block (`src/app/connections/first-run-connections.tsx`). The block has four T3-Agents-style rows: ✓ Ready with the plan's name, or Connect.
   - Connect opens the provider's native sign-in (`continueAccountConnect`, existing). OpenCode opens the existing OpenCode Go key sheet.
   - When the sign-in finishes, the row tints, reads Connected and then Ready, and the default re-picks.
   - Once the person writes, the block stays in history right under the assistant's greeting.
3. **The greeting is the assistant's own.** Once the pick settles (or after 6 s), the window sends the hidden intent `io.atum.first-run.greeting/1 en|vi [display name]` once per room.
   - It goes through the composer's route for that room: `sendTurn` on this Mac, otherwise the ordinary Matrix send. The code is `src/matrix/first-run-greeting-sender.tsx` and `src/matrix/first-run-greeting.ts`.
   - The seed never shows: `withoutFirstRunGreetingSeed` drops it from the transcript and the chat-list preview.
   - The assistant's reply replaces the written welcome in the card. A quiet typing bubble shows while the reply is being written.
   - The backend contract is atum-app `feat/first-run-backend` `19f369b294`, `docs/session-logs/2026-11-27-first-run-backend.md`.
4. **Settings › Connections** (`src/app/connections/connections-section.tsx`):
   - The plan in use reads "{plan} · your assistants use it" and has a **Stop using** button, which revokes the plan's account consent.
   - The **Pick the best plan automatically** switch is the lasting off-switch.
5. **Links clicked in a chat** open in Atum's own browser, the workbench's consumer-browser tab (`src/matrix/in-app-links.ts`, registered by `app.tsx`).

## Never overriding a person

- A hand pick in the picker is recorded (`noteManualModelPick`, `model-picker.tsx` `chooseRoute`), and the automatic step never touches that assistant again.
- A plan or OpenCode Go selection this Mac did not write counts as a person's choice.
- A revoked plan consent keeps `grantedAt`. The automatic step treats that as Stop using and never re-grants it.
- The record lives in this Mac's `localStorage` (`atum.first-run-auto.v1:<account>`). If it's lost, the step only becomes more careful: its own earlier writes then look like a person's.

## Free and unknown plans

`firstRunTier` reads T3's plan name (`auth.label`, for example "ChatGPT Pro 200 Subscription").

- "Free" means free.
- A paid tier word means paid.
- A signed-in Claude plan login counts as paid, because Claude Code requires a paid Claude plan.
- Anything else is unknown.

Free and unknown plans never win chats, as the plan says. They still show Ready, and a free plan's sub-line says it is used for small tasks.

## Provider sign-in and embedded browsers

Provider sign-ins stay in the system browser (`isProviderSignInUrl`):

- **Google** (Antigravity, Google accounts) blocks OAuth in embedded webviews with `403 disallowed_useragent`, and changing the user agent doesn't help ([Google, 2021](https://developers.googleblog.com/2021/06/upcoming-security-changes-to-googles-oauth-2.0-authorization-endpoint.html)).
- **OpenAI** (`codex login`): the ChatGPT browser sign-in returns to a loopback callback on `localhost:1455` ([OpenAI Codex auth](https://developers.openai.com/codex/auth)).
- **Anthropic** (`claude` login): the browser sign-in returns to a localhost callback on a random port, with a pasted-code fallback ([Claude Code authentication](https://code.claude.com/docs/en/authentication)).
- Atum's in-app browser deliberately refuses local and private addresses (`shared/browser/policy.ts`), so neither loopback callback can complete in it.
- The CLIs open the system browser themselves, and T3's Work view denies `window.open` without any external open (`electron/work/session/view-policy.ts`). Connect therefore already lands in the system browser and returns to the same row. Atum's own sign-in links follow the same rule.

These also stay in the system browser:

- `mailto:` and other non-web schemes;
- an app's URL buttons (its sign-in or checkout, `bot-api-text.tsx` keyboard);
- Settings › Legal and download links (Settings covers the workbench);
- the browser tab's own "Open in browser" button;
- pages before sign-in, when there is no window to host the in-app browser.

## Decisions and deviations

- **Consent.** The backend lane reports that platform migration 0547 already enables scheduled use for eligible connected plans, so no consent write is required. The step still calls the existing `grantAccountPlanUse`, as every Connect does. It is harmless, and its `grantedAt` is what makes Stop using durable.
- **OpenCode row.** The row reads Ready from the account's OpenCode Go key, or from T3's native `opencode` instance. Connect opens the OpenCode Go key sheet, because that is the route cloud assistants can use.
- **Welcome card centring.** The welcome card now uses `align-self: safe center`. The taller card, with Connections and the Google card, otherwise put its greeting above the scroll origin, where it couldn't be reached.
- **Naming.** The hidden seed is never the person's answer to the welcome (`first-run-naming.ts` callers, `invocation.ts`). The generated greeting no longer invites naming (COPY.md), so the naming note no longer applies after it.
- **Mobile exports.** `packages/mobile-design-exports/dist` is a reviewed snapshot that can't be regenerated here, so these strings are not exported.

## Known gaps (for the app/platform lane)

- **Account-wide switch.** "Pick the best plan automatically" is stored per Mac in `localStorage`. An account-wide setting would need a platform field.
- **Stop using with no fallback.** When Stop using leaves no other paid plan, assistants keep the stopped plan's selection. Their turns then answer on GPT-6 Luna through the existing consent-off fallback until a new pick. Clearing the selection server-side on revoke would remove that line.
- **Transaction ID.** The greeting seed has no room-scoped transaction ID: the existing `send` and `sendTurn` commands take none. Duplicates are prevented by the local once-per-room marker and the backend's FIFO and transcript check.

## Verification

See the session's final report for the checks table. Playground screenshots are in `~/.atum/operations/evidence/first-run-build-1127/`, captured with `node apps/desktop/scripts/first-run-connections-shots.mjs <vite-url> <out> [chromium]` on scenario `first-run-chat` with `?work=ready&firstRun=one|several|none|free&signing=codex`.
