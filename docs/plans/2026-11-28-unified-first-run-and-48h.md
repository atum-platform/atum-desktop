# One first run and one first 48 hours

**2026-11-28 · Read-only audit and proposal · nothing built.**

Owner question, 2026-11-28: "do we have one unified onboarding flow, and one unified 48-hour flow?"

**Answer: partly.**

- **The 48 hours are one flow.** On S2 they are native Hermes cron. One seeder installs every job, the jobs fire once, and they survive restarts and restores.
- **The first run is not one flow.** It is several independent pieces that share the first chat, with nothing sequencing them:
  - the plan auto-pick;
  - the greeting intent;
  - a plans block;
  - a separate sources card;
  - the Google chip;
  - the Mac setup prompts;
  - the starter notice.
- **The two flows are not connected to each other.** The warm-up clock starts when the account is activated, not when the person first opens the app. First learning cannot start until Google is connected.
- **Neither flow is proven end to end on S2.** Each has an offline proof only.

Commits read: atum-desktop `origin/main` 3424194e, the private app repository's `atum-main` 03cdf9cc, and the private platform repository's `main` fd831c390. Paths below are relative to each repository. Desktop paths drop the `apps/desktop/` prefix. "App" and "platform" mark the two private repositories.

## Owner rules this audit checks against

| # | Rule |
| --- | --- |
| R1 | The first 48 hours are "rock solid, perfect, showcase our best capabilities. Everything has to be smooth and reliable" (11-14). |
| R2 | The first run impresses. An inline connect card follows the greeting, connectors come from a data-driven list, first learning is unlimited and progressive, Drive is woven in, and language comes from memory rather than locale (10-27). |
| R3 | Warm-up: nudges at +5, +15, +35 and +60 minutes, sweeps twice as often on day 1, and a taper on day 2 (10-27). |
| R4 | Everything is automatic, with no decisions to make. Onboarding is a conversation. Never a wall of text. |
| R5 | Agents speak for themselves. No canned agent text. |
| R6 | Optional subscriptions only ever add. They never block. |
| R7 | All agents have full power by default. Agents live in the cloud, and Macs are devices they reach down to. Easier for users, more power for agents. |
| R8 | Triage always uses `jev-1.14`. Main work uses the agent's own model (11-28). |

## 1. Inventory

### Desktop (public)

| Touchpoint | Where | Trigger and what the person sees | State |
| --- | --- | --- | --- |
| Welcome story | `src/matrix/welcome-story.tsx:34-48`, `src/matrix/app.tsx:6522` | Plays once per install before sign-in, ending "Speak, and it becomes." | `localStorage io.atum.welcome.played` |
| Unused storyboard | `src/app/atum/welcome-storyboard.tsx:45` | Nothing imports it outside tests. | Dead |
| Sign-in | `src/matrix/sign-in.tsx`, `electron/matrix/sign-in-entry.ts:108` | "Continue with Google" or "Continue with email" in the browser. | MAS session |
| Plan auto-pick (#148, e926a756) | `src/app/connections/use-first-run-auto-pick.ts:29`, `first-run-store.ts`, `shared/first-run-pick.ts:16,98-124` | Runs behind the 2.6 s launch hold (`startup-screen.tsx:56`). The order is Claude paid → Sonnet, ChatGPT paid → Sol, Antigravity paid → Gemini Flash, OpenCode Go → DeepSeek Flash, otherwise Atum. Nothing appears on screen except the model chip. Re-runs on Connect, roster change, focus (every 5 min at most) and the Settings switch. | `localStorage atum.first-run-auto.v1:<user>`, per Mac. Writes `grantAccountPlanUse`, `work_selection_set` and `writeSubscription`. |
| Plan detection needs Work | `electron/matrix/main-work.ts:757-766` | `readPlanLabels` returns `{}` unless Work is running. The first pass can then fall back to Atum and switch later. | — |
| Greeting intent | `src/matrix/first-run-greeting-sender.tsx:8`, `app.tsx:5921-5928`, `shared/matrix-first-run-greeting.ts` | After the pick, or after 6 s, sends the hidden `io.atum.first-run.greeting/1 <locale> <name>` once per room. The seed is hidden and a typing bubble shows. | `localStorage atum.first-run-greeting.v1:<room>` |
| Canned greeting fallback | `src/matrix/first-run-card.tsx:103-107`, `shared/matrix-first-run-copy.ts:41` | When no generated greeting arrives, renderer copy appears: "To be useful from the start, I'd like to get to know your work." | Breaks R5 |
| Plans block | `src/app/connections/first-run-connections.tsx:18,70` | Four hard-coded rows under the greeting, each showing Ready or Connect. Connect opens the provider's own sign-in in the system browser. | — |
| Sources card | `src/matrix/first-run-connect-card.tsx:53,94-149`, `electron/matrix/mac-sources/consent.ts:40-50` | A second block below the plans block, "Let me get to know your world". Rows are data-driven: Google, messages, browser, location, folders, team spaces. "Continue" posts `first_learning`, "Not now" declines. | `POST /agents/{id}/routines {operation:'first_learning'}` (`electron/matrix/account.ts:4225-4250`) |
| Google chip | `src/matrix/google-connection-settings.tsx:252`, `app.tsx:6072`, `first-run-card.tsx:111-117` | Replaces the sources card after a skip, and also shows above the composer. Dismissal lives only in memory, so the chip returns on every launch. | Conflict |
| Starter notice | `src/matrix/starter-notice.tsx:6-40`, `app.tsx:6100` | A line in the default chat that turns the starter grant into a count of chats (about 2,500 Protons per chat). | Breaks the no-balance rule |
| Mac sources notice | `app.tsx:6087` | Shown once above the composer for cloud assistants, and held back while the first-run card is open. | — |
| Mac reach-down | `electron/matrix/main.ts:1474,17956-18005`, `src/matrix/native-mac-reach.ts:66-87`, `electron/matrix/device/native-ssh.ts:181,260` | Automatic native SSH once the Mac is enrolled. The status line is silent unless Remote Login or the Full Disk Access hint is needed. | Not coordinated with the cards |
| Folder access | `electron/matrix/folder-access.ts:15-45`, `first-run-card.tsx:126-155` | One macOS prompt per ticked folder, only after Continue. Recovery shows after a refusal. | — |
| First-run eligibility | `electron/matrix/first-run-welcome.ts:35-70`, `electron/matrix/first-run.ts:19-26,145-153` | Account record `io.atum.onboarding.first_run.v2` is `open` or `done`. Compatibility shims for 0.20.19 renderers are still in place. | — |
| Work | `electron/work/sidecar/host.ts:187-191`, `main-work.ts:683-687` | On by default and links T3 Connect automatically. No first-run step. | — |
| Naming | `electron/matrix/first-run-naming.ts:15-63` | The person renames the assistant in chat. There is no form. | — |

Dated docs: `docs/first-run-autoconnect-1127.md`, `docs/first-learning-cron.md`, `docs/first-launch-roster-gate.md`, `docs/mac-setup-cloud-runtime.md`, `docs/cloud-mac-reach.md`.

### Cloud agent runtime (app, private)

| Touchpoint | Where | Behaviour |
| --- | --- | --- |
| Enrollment seed | `packages/cloud-computer/seed.py:1022-1028,1132`, `packages/cloud-sandbox/host/agent_account_setup.py:86-111` | Runs once before the first gateway start. It does nothing if `config.yaml` exists. Inputs are `isNew`, `activatedAt`, `ownerTimeZone`, `ownerLanguage` (default `en`), `firstLearningAdmitted` and `googleConnected`. |
| Job table | `seed.py:738-803` | Native Hermes cron. The main agent gets `morning-brief` (08:00), `weekly-roundup` (Monday 08:30, from day 3) and `quiet-suggestion` (11:30). Every agent gets `followup-sweep` (every 2 h, 09:00–20:00, from hour 48). |
| Warm-up nudges | `seed.py:766-771` | `warmup-nudge-1..4` at +5, +15, +35 and +60 min **from `activatedAt`**. Each is moved into 08:00–21:00 with spacing preserved, and none fires after 48 h. Skill `behaviour-skills/atum-warmup` v1.1.1 runs four phases, each one useful offer or `[SILENT]`. |
| Day 1 and day 2 | `seed.py:772-778` | `warmup-hour-H`: hourly for hours 2–30, then every two hours for 32–48, daytime only. Night slots are skipped, never caught up. |
| First learning | `seed.py:757-758`, `seed.py:914-922`, `packages/cloud-sandbox/host/host_ports.py:~290-300` | One run (`every 1m`, `repeat=1`). It stays paused until **admitted, the gateway has started, and Google is connected** are all true. Skill `atum-first-learning` v1.1.2 has no lifetime cap, reads past and future calendar, mail, chats, Drive and the Mac where available, and writes user memory only. |
| Once-only | `seed.py:816-912`, `hermes_cli/s3_home_restore.py:183-216,671,768-784` | Stable job IDs, a receipt and tombstones. A missing job is never re-created. Restore runs with `is_new=False` and refuses delivered or out-of-window warm-ups. |
| Greeting intent (#1089, 62f4437) | `packages/cloud-controller/hermes-plugin/work_provider.py:34,141-148,901-907` | The agent writes its own welcome from the facts it is given: name, model and Mac plan. **If the session already has messages, the intent is settled silently.** |
| Delivery into the owner session | `seed.py` (`attach_to_session=True`), `cron/scheduler_delivery.py:90-106` | Seeded job output is mirrored into the owner room's session. |
| Attention gate | `packages/cloud-computer/ATTENTION-GATE.md`, `migrate_attention.py:17,138,185` | Gates only `followup-sweep` and `warmup-hour-*`, and only on OpenRouter homes. Triage uses `typesafe/jev-1.14`, and warm-up mode skips only at confidence ≥ 0.99. If the gate fails, the full sweep runs anyway. The nudges are never gated. |
| Offline proof | `packages/cloud-computer/tests/e2e_happy_path/{README.md,test_first_48h.py,warp.py}`, CI job "S2 happy path and first 48 hours (offline)" | Moves a simulated clock over the real cron store: four nudges, one first learning, the day-1 and day-2 slots, restart and restore without replays. A live adapter is "still required". |
| Retired for S2 | `packages/cloud-controller/src/agent/sweeps.ts:280-313,663-686` | The controller still claims `warmup_nudge` occurrences, but only for legacy controller agents. |

### Platform (private)

| Touchpoint | Where | Behaviour |
| --- | --- | --- |
| Sign-up and provisioning | `apps/shell/src/lib/matrix-authority.ts:1592-1640,2395-2406`, `hermes-signup.ts`, migrations 0479, 0486, 0494, 0496 | `POST /assistant` creates the agent, then the starter grant, then S2 placement. Timezone and location are reported first. `GET /agents` retries, at most once every 20 s. |
| CAPTCHA | fd831c390 (#953) | Turnstile on MAS email sign-up. Built, not active. |
| Handles | `spec/public-handles/v1.2`, 0424 | Every principal gets one alias. A fallback default exists. There is no handle step in the first run. |
| Starter grant | 0144, 0151 | Founding allowance, once per person. |
| First-learning admission | 0478 `atum.matrix_first_learning`, `docs/operations/s2-first-48h/ADMISSION.md` | For Hermes agents it records `admitted` or `cancelled`. Its note says "built, not live". This audit did not check production. |
| Warm-up contract `agent-sweep/v1.1` | 0328, 0434, `spec/agent-sweep/v1.1` | The S1 occurrence model. 0455 (`:180-206`) fences it for Hermes agents (`runtime_fenced`), and 0489 exports delivered nudge indices so a move does not replay them. **S2 does not use it.** It remains for controller and local-Mac agents. |
| Private chief-of-staff greeting | `packages/protocol/src/company-private-cos.ts:161-186` | Company-only. Personal agents have no server greeting state. |

### Phone

The phone app has no account first-run flow. It has sign-in, a push permission prompt and Google in Settings, and app-bot onboarding sheets (`ios/App/AppBots/AppOnboardingViews.swift`). An owner who starts on the phone gets the agent from `GET /agents` and the warm-up clock starts, but no greeting is ever sent.

## 2. What a new user experiences today on S2

This assumes the person signs up on the Mac, using the 0.20.55 test build (desktop #148) on R61 agents. The public release does not have #148.

| When | Step | Owner | What the person sees | Status |
| --- | --- | --- | --- | --- |
| −2 min | Welcome story, sign-in in the browser | Desktop | Story, then the browser | Works |
| −1 min | `POST /assistant`: agent, starter grant, S2 placement, room; `activatedAt` is set | Platform | Launch screen | Works (#855 and later) |
| −1 → 0 | Container seeded and gateway started. Nudge clock starts **now** | App seed | — | Not verified live on S2 |
| 0 | Launch hold, plan auto-pick | Desktop | Chip already on Sonnet or Sol, or on Luna | Built, not live (test build only). Detects nothing if Work is not ready yet. |
| 0:06 | Greeting intent → the agent's own welcome | Desktop → app | Typing bubble, then the welcome | Built, not live. Falls back to **canned copy** if no reply arrives. |
| 0:06 | Plans block **and** sources card **and** the starter notice | Desktop | Three stacked items, two of them sign-in lists | Conflicting |
| 0–5 | Mac reach-down setup: Remote Login request, then the Full Disk Access hint | Desktop | System prompts that can overlap the cards | Conflicting |
| 0–5 | Connect a plan (system browser) and Continue on sources with Google (system browser again) | Desktop | Two separate browser trips | Duplicated |
| on Continue | `first_learning` admission → account projection → `resume_learning` | Desktop → platform → host | Learning progress tiles and up to three progress lines | Built. **Never starts without Google.** |
| +5 min | `warmup-nudge-1` | App cron | One offer, or nothing | Built, not proven live. If it is delivered **before** the greeting intent arrives (late install, a phone-first start, a slow container), the greeting is settled silently (`work_provider.py:902`) and the canned fallback shows. |
| +15, +35, +60 | Nudges 2–4 | App cron | Deeper offers | Built, not proven live. They can land before first learning has produced anything. |
| +2 h → +30 h | Hourly warm-up sweeps (daytime), triage first | App cron + gate | Mostly silent, occasional offers | Built. The collector is off, so the gate fails open and runs a full sweep every slot (cost). Subscription agents get no triage. |
| 08:00 | Morning brief | App cron | Brief | Built |
| 11:30 | Quiet suggestion | App cron | At most one | Built |
| +32 h → +48 h | Warm-up sweeps every two hours | App cron | Taper | Built |
| +48 h | Ordinary `followup-sweep` | App cron | Steady state | Built |
| Day 3+ | Weekly roundup (Mondays) | App cron | Roundup | Built |

## 3. Gaps against the owner rules

1. **Nobody sequences the first chat (R1, R4).** Several items can be on screen at once: the plans block, the sources card, the Google chip, the starter notice, the Remote Login and Full Disk Access prompts, folder prompts and native notifications. Each owns its own timing. Two sign-in lists cause two browser trips. `first-run-card.tsx:110-118` stacks the two blocks.
2. **The warm-up clock and the greeting race (R1, R5).** Nudges are timed from account activation, and their output is mirrored into the owner session. A nudge delivered before the desktop sends the greeting intent makes the backend skip the greeting, and the card then shows renderer copy. A phone-first owner gets nudges with no greeting at all. This needs a test-agent proof, but every step in the chain is in the code.
3. **First learning depends on Google (R2, R7).** `seed.py:757-758` and `host_ports.py` keep it paused until Google is connected. A person who connects only Mac folders, Messages or chats never gets first learning, and the warm-ups then have little to go on.
4. **Canned agent text remains (R5).** The fallback greeting and intro (`first-run-card.tsx:103-107`), and the starter notice's chat count, which also breaks the no-balance rule.
5. **The connector list is split and partly hard-coded (R2).**
   - The sources rows are data-driven.
   - The plans rows are a fixed list of four.
   - Mac reach-down has no row of its own.
   - The auto-pick switch is per Mac, not per account.
   - The first pass depends on Work being ready.
6. **Language comes from the UI locale (R2).** The greeting seed uses the desktop locale (`app.tsx:5924`), and the seed uses enrollment `ownerLanguage` with a default of `en`. Nothing reads the owner's language from memory.
7. **Triage does not follow R8.** The gate covers only OpenRouter homes. The owner's 11-28 decision to triage subscription agents with `jev-1.14` is not built. On S2 the collector is not enabled, so every warm-up slot runs a full sweep.
8. **There is no live proof (R1).** The happy-path harness is offline. The live adapter, the first-learning admission and the "fires exactly once, in order" sequence have not run on a real S2 agent. Two owner rows stay open for this: SWEEPS-WARMUP-CHECK and HAPPY-PATH-OUT-OF-BOX.

## 4. Proposal

### Principle

Each flow gets one sequencer, and both reuse native parts.

- **The first run** is sequenced on the desktop by one controller: the existing first-run store, extended.
- **The 48 hours** are sequenced by native Hermes cron on the agent: the existing seeder, re-anchored.
- **The handoff** between the two is one fact the agent already receives: the greeting intent.

Nothing new runs on a timer. No new core tool, contract or server greeting state is added.

### Unified first run (the conversation)

| Step | What happens | Reuses |
| --- | --- | --- |
| 0. Launch hold | Read plans, sources and Mac state, then pick the model. Wait for Work's first provider read up to the existing hold. Otherwise pick later, between turns. | `useFirstRunAutoPick`, `readPlanLabels` |
| 1. Greeting | The agent writes its own welcome. The desktop shows a pending bubble and **retries the intent once** instead of falling back to canned copy. The seed carries the language from the owner's stored preference (account `ownerLanguage`, later from memory), not the UI locale. | #1089 intent and parser |
| 2. One Connections block | **One** list in T3's Agents-row style, one row per connection. Each row is Ready, Connect, or a Mac step. The groups are:<br>• AI plans: ChatGPT, Claude, Antigravity, OpenCode<br>• Your accounts: Google (mail, calendar, Drive)<br>• This Mac: folders, Messages, browser, location, and reach-down (Remote Login and Full Disk Access as rows, not separate prompts)<br>The rows come from one data list. Plans become the `plans` kind next to the existing source kinds. Defaults stay on: Google, location and team spaces on, sensitive folders unticked (opt-out). Connecting one Google account covers both the sources card and Antigravity where eligible, so there is one browser trip per provider. | `first-run-connections.tsx` rows, `projectMatrixKnowledgeSourceRows`, `consent.ts` kinds, `native-mac-reach.ts` states |
| 3. Learning starts | The first Connect or Continue admits first learning. Learning runs on **whatever is connected**: chats and Mac first, Google and Drive when they arrive. A late Google connection lets the same single run go deeper, so no second run is armed. | `first_learning` operation, 0478, `resume_learning`, skill v1.1.2 |
| 4. Quiet after that | Remove the starter notice from the first chat. Persist the Google chip's dismissal on the account, or remove the chip, because the Connections row covers it. Hold Mac notices until the first-run block has closed. | — |

The block stays in the transcript as a past item, which matches the owner's 11-27 answer.

### Unified first 48 hours (native cron)

| Change | Why | Where |
| --- | --- | --- |
| **Re-anchor warm-ups to the greeting.** Seed the nudges and warm-up hours as before but paused. The first-run turn (greeting delivered) resumes them with `activated = greeting time`, using the same pattern `resume_learning` uses. Agents that never greet, such as phone-first, are anchored at their first owner message. | Fixes gap 2. +5 minutes means five minutes after the person met the agent. | `seed.py`, `host_ports.py`, `work_provider.py` |
| Nudge 1 waits for first learning's first saved fact, at most 10 minutes. After that it uses what is there. | The first offer must show the agent knows something. | `atum-warmup` skill prompt plus the existing native `context_from` |
| Remove the Google gate from first learning. Keep admitted and gateway-started. | Fixes gap 3. | `seed.py:757-758`, `host_ports.py` |
| Triage with `jev-1.14` on **every** home, subscription agents included. Nudges stay ungated. If the gate fails, the full sweep still runs, on the agent's own model. | R8. Gap 7. | `migrate_attention.py`, `ATTENTION-GATE.md` |
| Enable the attention collector on S2, owner account first. | Ends the fail-open full sweeps. | host kit |
| Keep the job table: +5, +15, +35, +60 min, hourly on day 1, two-hourly taper on day 2, then steady state, 08:00 brief, 11:30 quiet suggestion. | Already matches R3. | — |

### Delete

| Remove | Where | When |
| --- | --- | --- |
| Canned greeting and intro fallback | `first-run-card.tsx:103-107`, `shared/matrix-first-run-copy.ts` `greeting`/`intro` | Slice A |
| The separate sources card as its own block, folded into the one list | `first-run-connect-card.tsx` (keep its row logic) | Slice A |
| Composer Google chip and its in-memory dismissal | `google-connection-settings.tsx:252`, `app.tsx:6072` | Slice A |
| Starter notice | `starter-notice.tsx`, `app.tsx:6100` | Slice A |
| Unused storyboard | `src/app/atum/welcome-storyboard.tsx` | Slice A |
| 0.20.19 renderer compatibility shims | `electron/matrix/first-run.ts:145-153` | After the last 0.20.19 install is gone |
| Local-Mac first learning and the local warm-up sweep | `electron/matrix/first-run.ts` local turn, `shared/matrix-first-learning.ts`, `electron/matrix/background-sweep*`, `main.ts:14040-14389` | When the last local or controller agent moves to S2 |
| Controller warm-up claims and `agent-sweep/v1.1` consumers | App `packages/cloud-controller/src/agent/sweeps.ts`, platform 0328 consumers. Keep the 0489 move projection until moves end. | Same |

## 5. Build slices

| Slice | Home | Scope | Depends on |
| --- | --- | --- | --- |
| A. One Connections block | atum-desktop | Merge the plans and sources rows into one data list. Add Mac reach-down rows. Replace the canned fallback with pending plus one retry. Remove the starter notice, the composer chip and the storyboard. Run one browser trip per provider. | — |
| B. Learning without Google | app (`cloud-computer`, `cloud-sandbox/host`) | Remove the Google gate. Let late sources deepen the same run. Update the offline guard. | — |
| C. Warm-ups anchored to the greeting | app | Seed warm-up jobs paused. Resume them on the first greeting or first owner message. Nudge 1 waits for the first fact, at most 10 min. Extend `warp.py` and `test_first_48h.py`. | B (same files, run in order) |
| D. Triage on every home | app | `jev-1.14` triage for subscription homes too. Enable the collector on the test agent, then the owner agents. | Current attention lane, round 2 |
| E. Language from the owner | desktop + platform | Seed language from the account's `ownerLanguage`. Platform makes sure it is set at sign-up from the owner's chosen language, not only the device locale. | — |
| F. Live acceptance | app (live adapter for `tests/e2e_happy_path`) | Supply the deployment adapter and run the plan in §6 on the test agent. | A–D deployed to the test agent |
| G. Retirement | desktop, app, platform | The deletions tied to the last local or controller agent. | Last legacy account moves |

A and B can run in parallel because they have no shared files. C follows B. D is already queued. F gates the release.

## 6. Acceptance: fires exactly once, in order, on S2

Run on a fresh `s2-e2e-<run>` account on the test agent, with fixture Google data, using the happy-path runner's live mode. Every check reads authoritative state: Matrix events, the native cron store and executions ledger, and platform rows. Screenshots alone are not evidence.

1. **Order of the first chat.**
   - The agent's welcome is the first event from the agent in the room.
   - It is not canned. It matches no renderer copy string.
   - Exactly one Connections block renders, and no other first-run item is visible.
2. **Greeting once.** Send the intent from two devices. Expect one welcome, and the second intent settled.
3. **Anchor.** Delay the first desktop open by 30 minutes after sign-up.
   - No nudge is delivered before the welcome.
   - Nudge 1 is delivered between 5 and 15 minutes after the welcome.
4. **Learning without Google.**
   - Connect only folders and chats. First learning runs once and saves at least one user-memory fact.
   - Connect Google later. No second first-learning execution is created.
5. **Nudges.** Exactly four `warmup-nudge-*` executions are delivered, in order 1→4. Gaps are at least 10, 20 and 25 minutes. All fall inside 08:00–21:00 owner-local. Repeat with a 20:50 sign-up, which should push nudges to 08:00 with spacing kept.
6. **Day 1 and day 2.** Use a moved clock on the container (libfaketime) or a 48-hour real soak.
   - Hourly slots run in daytime only through hour 30, then every two hours through hour 48.
   - Each slot runs triage on `jev-1.14` first.
   - No owner message comes from a skipped slot.
   - The first ordinary `followup-sweep` arrives at or after hour 48.
7. **Briefs.** Two morning briefs and at most one quiet suggestion per day in the 48 hours. No weekly roundup before day 3.
8. **Restart and restore.**
   - Restart the container after nudge 2.
   - Restore a checkpoint from before nudge 2.
   - No occurrence is delivered twice.
9. **Subscription agent.** Repeat steps 5–6 with a connected Claude plan.
   - Triage still uses `jev-1.14`.
   - Main sweeps use the plan's model.
   - With the Mac asleep, they fall back quietly to GPT-6 Luna.
10. **Cleanup.** The account, the key and the runtime are removed. Cleanup failing counts as a failed run.

## Open owner questions (recommended default first)

1. Start the 48-hour clock at the agent's welcome rather than at sign-up? **Recommended: yes.**
2. May first learning start with only Mac and chat sources, and go deeper when Google arrives? **Recommended: yes.**
3. Remove the starter-grant line from the first chat? It counts Protons as chats. **Recommended: yes, remove.**
