# Work: the subscription relay (self-work slice B) · 2026-11-22

Slice B of the self-work plan (`docs/plans/2026-11-21-self-work.md` §10.2, §10.3, §12; B-0 in §16), the desktop half. Branch
`feat/work-subscriptions-gate-1122`, from `origin/main` 38c4bc8f (PR #96, the Work gate). Local commits only: nothing pushed, no CI run, no PR.
Authorization: owner, 2026-11-22, "let's do it" (build the subscription relay). The platform half is atum-platform
`feat/work-subscriptions-1122` (contract `atum.work-route/1.2`, migrations 0529/0530, not applied anywhere).

The relay is **"a Work session started on your plan"**: an assistant hands a task to the Mac exactly as in slice A, and the only difference is the
provider the gate sets. It replaces the SSH ChatGPT relay, which is removed.

## What is built

| Piece | Where |
|---|---|
| Contract 1.2 on the Mac | `electron/work/gate/contract.ts` (consent snapshot, `plan` argument, the four plan refusals, `workPlanLaunchDecision`), `sync.ts`, `platform.ts` |
| The plan fact (G9) | `gate/plan-fact.ts`, read from T3's own provider status (`T3Port.planProvider`) |
| Gate 4b-1 … 4b-3 | `gate/gate.ts`, `gate/ledger.ts` (plan column, consent store, plan cutoff, local switch) |
| The local switch | `gate/service.ts` `setPlanSwitch`, `mount.setPlanSwitch`, IPC `setPlan`, Settings › This Mac row |
| Delegated-thread containment | `acp_adapter/profiles/delegated.yaml`, `tests/acp_adapter/test_delegated_containment.py` |
| Old SSH relay removed | see "Removed" below |
| B-0 direct calls | `gate/gate-plan.test.ts`, `gate/http.test.ts` (B-0 block), `gate/real-t3-gate.integration.test.ts`, the Python containment test |

## The contract, as the Mac speaks it

- **Pull.** `work_sync_pull` carries `contract: "1.2"`. A platform that answers 400 to it (it does not know 1.2) is pulled as 1.1 for an hour, then asked
  again: revocation keeps working, there is simply no consent snapshot, so every plan launch is refused `plan_consent_stale`. **The refusal is immediate.**
  Entering the fallback (and every 1.1 pull of the hour after it) calls `gate.invalidateConsent()`: the snapshot already held stops authorising plan
  launches at once instead of for the rest of its 300 s. Only a snapshot applied from a valid 1.2 page restores it (`gate-plan`/`sync-plan.test.ts`
  "a downgrade to 1.1 after fresh consent refuses plan launches at once…"). Review finding 1, fixed.
- **Snapshot.** The page's `consent` is stored in the ledger in the **same transaction** as the page, and the plan threads of every assistant it no longer
  names are cut off in that same transaction. Its age is counted from the commit on the Mac's **monotonic** clock. After a restart the snapshot is on
  disk but its age is unknown, so it is stale until the next pull. A page that is not applied (gap, regression) applies no snapshot.
- **Ack.** `work_sync_ack` carries `consentRevision` = the stored snapshot's revision, omitted until one was applied and while the platform is pulled as 1.1.
- **Fact (G9).** `work_subscription_report` `{deviceServiceId, accountId, routeEpoch, provider:"codex", state, observedAt}` and nothing else.
  Reported when T3's status for the plan changes (a connect, a disconnect, so also a switch of the login, which T3 shows as a disconnect then a connect),
  at least hourly while the gate runs, by `PlanFact.refresh()` when main knows the connect screen changed something, and as `disconnected` in the last
  bounded flush of a sign-out, an account switch and Work off. `unknown` (T3 could not be asked) is never reported. The token is never read: it stays in
  Codex's own store.
- **Launch.** `launch` accepts one new optional argument, `plan: "codex"`. Anything else (`claude`, `antigravity`, `CODEX`, a provider, a model selection,
  an instance id) is an invalid or unknown field, refused and not trimmed, before T3 or Matrix is touched.

## The four 4b rules, how each is enforced, where it is tested

| Rule | Enforcement | Tests |
|---|---|---|
| 4b-1 Codex only; Claude and Antigravity unreachable | The one plan instance is compiled in (`WORK_PLAN_INSTANCE_IDS`, `['codex']`). The gate **sets** `modelSelection` on every launch (Atum instance, or that one); the caller never names a provider. `selectionAllowed` re-checks the stored call at the handoff, so a tampered ledger row naming another provider is never sent. The six gate tools share no name with any tool T3 advertises; every T3 tool name is refused 403 | `gate-plan.test.ts` (selection, tampered rows), `http.test.ts` B-0 (plan values, extra fields, all 60 pinned T3 tool names), real pin (the tool list is a subset of the pinned list) |
| 4b-2/4b-3 the decision | `workPlanLaunchDecision`, in the platform's order: **stale** (snapshot older than 300 s monotonic, or the page head regressed, or no snapshot) → **consent off or this assistant not named** → **local switch off** → **not scheduled**. The first failure is a refused receipt (no thread; the owner-event claim is never taken). Checks 1–3 run before anything is read from T3 or Matrix; a passing plan launch skips the balance check and debits nothing | `gate-plan.test.ts` (12 vectors, order, "no T3/Matrix call before the decision"), `http.test.ts` |
| The fence | The decision is evaluated again at the admission's synchronous section and again in `handoff`, in the same step as the forwarded mark. Consent withdrawn or the snapshot gone stale between admission and send: nothing is sent; an unsent row is refused for good (claim released) | `gate-plan.test.ts` ("the fence at the handoff") |
| Re-read the provider before each send | Every path that could send to a launch's thread reads it first (`dispatch`, `reconcile`, `recover`). A thread that exists is never sent to again; a provider that is not the row's own selection is logged (`thread_provider_changed`). The gate has no tool that sends to another thread or moves one to another provider | `gate-plan.test.ts` ("re-reading the thread before a send"), `http.test.ts` (tool list is the six) |
| Revocation | The snapshot (consent off, or no longer naming the assistant) and the local switch cut off **only plan rows** (`GateLedger.planCutoff`): marked stop owed, interrupted through main's owner session, settled with the usual `stop_report`. No generation moves, no T3 session is revoked, no route event is sent: an assistant that lost the plan keeps Atum | `gate-plan.test.ts` (revocation), `sync-plan.test.ts` |
| Local switch | "Agents may use my ChatGPT plan here", per Mac, **default OFF** (OpenAI asks for express consent for background use). Drawn in Settings only while a plan is connected here or the switch is on, so it can always be turned off. Off interrupts every plan thread at once; on resumes nothing | `gate-plan.test.ts`, `mount.test.ts`, `surface.test.ts`, `work-settings.test.tsx` |

An assistant whose plan thread is being stopped is `revocation_pending` for Atum launches too, until the stop settles (a few seconds): the stop uses the
existing agent-scope block, and no second scope was invented for it.

## "Scheduled", defined once

A launch is **scheduled** when it is **not backed by a fresh, verified, unclaimed message of the owner**: the owner event is missing, is not the owner's,
is past its 900 s age bound, or is already claimed by another launch. This is exactly the test the slice-A owner-event claim applies
(`workOwnerEventAge`, `OwnerEventVerifier`, `GateLedger.eventClaimed`). For a plan launch, a scheduled launch with `alsoWhenScheduled` false is refused
`plan_not_scheduled` (in place of the owner-event reason, because the plan check comes first in the contract's order). An unreachable homeserver is not
a refusal: it stays `unavailable / owner_event_unverifiable`, retryable. With `alsoWhenScheduled` true the launch still meets the owner-event checks:
slice A has no standing permit (plan §11.3, D18), so every launch carries and consumes one owner message; `alsoWhenScheduled` begins to matter when
standing permits return.

## Delegated-thread containment (§10.3, K36)

The pieces existed: a second Atum provider instance (`atum-managed-delegated`, its own `HERMES_HOME`) whose profile is `self-work.yaml` overlaid with
`delegated.yaml`. This change measured them with direct calls and tightened the floor.

| Path from inside a delegated thread | Status |
|---|---|
| T3's `t3-code` MCP server (found by discovery) | **Holds.** `editor_mcp_tools` lets only `t3_thread_read`, `t3_thread_list`, `t3_thread_wait` through; any other server or tool is excluded before the editor transport opens (`tests/acp_adapter/test_managed_profile.py`) |
| Terminal: `t3 thread …`, `t3 acp-mcp-*` | **Holds** (rules existed) |
| Terminal: the rest of the `t3` CLI | **Was open, now closed.** `t3 auth pairing create` and `t3 auth session …` were NOT blocked: a pairing credential is a way to anything, a plan thread included. `t3`, `t3 *`, `*/t3 *` and the separator forms now deny; so do `pair`, `environment`, `project`, `serve`, `service`, `up`, `update`, `doctor` |
| Terminal: `codex`, `claude`, `antigravity` | **Holds**, and now also bare, as a path, after a separator, and Codex's login store (`*.codex*`) |
| Under any approvals mode (manual, smart, off) | **Holds**: the deny floor fires before every mode (tested for all three) |
| Ordinary commands | Not caught (`git`, `ls`, `pytest`, a word ending in `3`) |

**Gaps (what a floor is not).** These are the owner decision B-0 asks for. They are named, tested as strict `xfail`, and not closed here:

1. **The same macOS user.** Hermes's file tools read any path that user can read, and nothing in Hermes blocks `~/.codex/auth.json` (or, under the sidecar's
   `HOME`, `<account>/work/environment/.codex/auth.json`) or T3's own home and database. A delegated thread runs on the **Atum** model, so a read of the
   plan's login would put the token in a cloud model's context. The terminal rule above does not cover the file tools.
2. **A command assembled at run time** (`python -c "os.system(chr(116)+…)"`) is not a string a glob can match.
3. **T3's write authority is not measured** (U43): what the `t3-code` server's own fence allows on a write by a peer session was not tested here; the
   profile's read-only filter is what holds.

Per plan §10.3 the choice for 1 goes to the owner: an isolated assistant environment for accounts with a plan connected (D14's alternative), or **4b stays
closed**. Until then the plan provider is also left **disabled in the sidecar** (below), so nothing here opens it by accident.

**This gap blocks the Work handoff as well, not only plan launches (owner call 2026-11-22; review finding, not fixed here).** A delegated thread that can
read the same user's credential stores can read the plan's token and T3's own home, so the OS-sandbox decision above (an isolated assistant environment, or 4b
stays closed) gates the Work handoff too. Until the owner chooses, the containment floor alone does not open either.

## What is not switched on

- The sidecar still ships the Codex instance disabled (`providerInstances.codex.enabled: false`, `/usr/bin/false`, `work/sidecar/process.ts`). Enabling it
  is the Connect step (gate 4a, T3's own provider flow, hidden until un-carry custody is retired for the account), not this change. Until then T3 reports the
  plan disconnected, the fact says so, and a plan launch answers `unavailable / provider_not_ready`. The pinned T3 was run with exactly that
  configuration (`real-t3-gate.integration.test.ts`).
- The consent and the cloud helper's `plan:"codex"` request are the platform's and the cloud lane's.

## Removed

The old SSH ChatGPT relay (plan §12): `electron/matrix/device/chatgpt-relay.ts`, `-socket.ts`, `-process.ts` and their tests, `electron/matrix/chatgpt-relay-client.ts`
and its test, `native/chatgpt-relay.swift` (the `atum-chatgpt-relay` helper) and its packaging step and `asarUnpack` entries,
`scripts/prove-chatgpt-relay-publication.mjs`; the wiring in `main.ts` (the relay object, its Hermes process, the device-runtime option, the model rows
and the enable/disable function, the snapshot merge, the sign-in and disconnect steps), `device/runtime.ts` (handler, socket, timer, saved enablement; the
saved `chatgpt-relay-v1` is reset), `device/service.ts` (a `ChatGptRelayRequest` frame is answered `refused 403 relay_disabled`, as a disabled relay was),
`device/bootstrap.ts`, `device/native-ssh*.ts` (a `relay` key is refused whole; `managedKeys` writes shell keys only and overwrites an old forced-command
block), `account-subscription-flow.ts` (the relay stage of the follow-up, the sign-in retire step, the snapshot merge).

**Kept on purpose:** `electron/matrix/chatgpt-carry.ts` (the carry tombstone the platform relies on; its `carried`/`restored` hooks now only recheck
agents), the device Hello's `chatGptRelayMaxBytes` field and the `ChatGptRelay*` frame names (the platform's wire contract), the model-choice and
availability types that read the platform's `relay.state` / `relayPresence` (a platform fact), and the shared fixtures under
`packages/device-protocol/fixtures/chatgpt-relay`. **Left for the Connect step:** the "Use this Mac for ChatGPT" row (`src/matrix/subscriptions.tsx`) and its
bridge method; main answers it `{status: 'unavailable'}`.

## The owner's screens (C4, 2026-11-23: one Connections pane, one connect sheet, one picker)

Owner 11-23: connections are account level and every feature finds them. Slice B's Connect step, ChatGPT plan row, plan switch and
multi-step consent sheet are **retired** (deleted, not flagged): `plan-connect.tsx`, `plan-consent.tsx`, the Settings
`SubscriptionsSettings` row, the device-code ChatGPT sign-in in `subscriptions.tsx`, `subscription-view.ts` and
`chatgpt-training-settings.tsx`.

| Screen | Where | What it does |
|---|---|---|
| **Settings › Connections** | `src/app/connections/connections-section.tsx`, drawn by `settings-revamp.tsx` | **Subscriptions**: ChatGPT, Claude, Antigravity (always, connected or not; connected first), each with its mark (squircle), where it runs ("On this Mac", "Last seen on Mac mini", "Not connected") and one action: **Connect** (the sheet) or **Manage** (the plan's own T3 screen in Work, only on the Mac that holds it). Then OpenCode Go (key; "In the cloud"). Then Work on this Mac, **Data and tools** (your chats, always; each home hub from the registry), Google, the browser import, apps, and Your Macs |
| **This Mac's one off switch** | Your Macs, this Mac's row (`this-mac-switch.tsx`) | "Assistants can use this Mac". Off: `nativeMac.ssh('disconnect')` (desktop #90's action) and `setPlan(false)` (interrupts every plan thread). On: both back. Other Macs are turned off on that Mac |
| **Connect sheet** | Every Connect: Settings, the picker's rail Connect and its greyed rows, the chooser, the launch notice, the assistant card (`connect-sheet.tsx`, mounted once in `app.tsx`) | **Ask**: the plan's mark, "Connect Claude", "Sign in with Anthropic. Atum never sees your login." and the one consent sentence (Q1) "Your assistants can use this plan through this Mac." **No checkbox.** Continue closes what covers Work and opens T3's own provider screen for the plan (`openPlanConnect(plan)` → `/settings/providers?instanceId=codex|claudeAgent|antigravity`; only Codex runs the un-carry preflight). **Finish / Done** show in the Work title band (DOM above the native view, never over T3's sign-in) until the account read says the plan is connected on this Mac, then "Claude is connected". A device without Work reads "Open Atum on your Mac to connect." |
| **Consent (Q1, Q2)** | `grantAccountPlanUse` in `src/app/connections/store.ts` | When ChatGPT lands, the app writes the existing record naming **every assistant Work knows** and this Mac, `alsoWhenScheduled: true`, then turns this Mac's switch on. Best effort; the switch is the off. C5 makes "all" a platform value; this is the bridge until then. Claude and Antigravity have no consent record yet (no relay) |
| **Model picker** | `model-picker.tsx` (chat composer and assistant card) | Every plan has a rail entry from the account set: Atum, connected plans, then hollow marks for the ones to connect. ChatGPT's rows follow the relay rule (§3.1) unchanged. A connected plan the relay does not carry yet (`WORK_RELAY_ENABLED_PLANS`) lists its models greyed with "Works in Work for now". Choosing a plan connected nowhere replaces the list with its mark, "Use your Claude plan" and **Connect**. No price, limit, relay or Mac text |

**The account read.** `readConnections()` on the Work bridge (`matrix:work:request` `{kind:'readConnections'}`) → main's
`readAccountConnections` (`electron/work/surface/account-connections.ts`) → `account_connections_read` on the existing
device-services endpoint, parsed against a mirror of `atum.account-connections/1` (`shared/account-connections.ts`, atum-platform
#927). If the route is not deployed, offline, or the reply does not parse, main answers from **this Mac's own** T3 plan facts
(C3's `projectPlanCapabilities`), marked `source: 'this_mac'`; nothing about other Macs or the cloud is invented.

**Deferred from C4** (recorded, not built): Work's own T3 picker reading the registry (Work UI lane, fork); headless maker
sign-in from the sheet (E4: today Continue shows T3's provider screen, where the owner clicks sign in); `binh-minh` removal in
Work (E1); main-side retirement of `account-subscriptions.ts`, `codex-accounts.ts`, `hermes-codex-migration.ts`,
`subscription-auth-lifecycle.ts` and the ChatGPT device-code IPC (still wired in main; no renderer calls them now); the per-agent
`providers.tsx` page; unused ChatGPT strings in `settings-copy.ts`; the phone's consent copy (`mobile-copy.ts`, another home);
folding `matrix_subscription_model_choices` into model choice v2. Until desktop #90 lands, window focus re-runs native `connect`,
so this Mac's switch can flip back on after a refocus.

### Desktop C1 and the Work picker (2026-11-23)

Work provisions T3's managed Codex mode, Claude Code and Antigravity in the account's existing Work home.
The startup supervisor replaces the two disabled executable stubs and preserves the native settings of the three plan
instances across restarts. Work uses the Matrix default Atum model, Nguyệt Thực, for the owner picker, text-generation
fallback and both Hermes profiles. The cloud gate still selects the dedicated delegated Atum instance by default.
The delegated instance remains enabled and sends `showInPicker: false` in the server settings.

The Connect offer is available while Work is enabled. The ChatGPT action calls the Shell's idempotent
`POST /api/connections/openai-codex/uncarry` route. That route checks the account's custody status and retires old cloud
custody if needed. After it returns `work`, the action opens T3's native Codex provider screen in the current owner view.
The existing cloud relay admission and per-Mac switch still apply. Account-wide consent and the expanded cloud plan
set belong to later slices.

The bundled T3 pin needs to decode `showInPicker` and omit hidden instances from the picker while keeping them available
to the orchestration API. It also needs a native Claude setup action in the embedded provider screen. The pin offers
Claude's install and login commands in onboarding, which the Work build hides. The browser sign-in handoff needs an
owner-bound main-process bridge for maker sign-in URLs, including native picker entry points. That bridge must apply
the same Codex custody preflight. The view currently denies popups and external navigation.
The managed ACP catalog runtime owns the account lineup and user-facing labels. It needs to use the canonical lineup
names without the provider prefix and handle unavailable and historical aliases.

Local tests use temporary account roots and a loopback fixture, including real supervisor settings writes and a restart.
The focused Work and Matrix Vitest suites passed (575 passed, 9 skipped), as did the Electron typecheck and focused ESLint.
Signed-app login, file-edit turns, zero-Proton billing, sign-out and token-custody acceptance remain release checks.

**Settings placement fix.** The Work rows (Work on this Mac, Assistants can start work here, the plan switch) sat in `DevicesPane`, which no Settings page
draws any more (`SETTINGS_PAGES.connections` holds only `connections`), so they never appeared. They now form their own **Work** section on Connections,
under Subscriptions.

**Removed: "Use this Mac for ChatGPT".** The window's automatic cloud-setup attempt (`useThisMacForChatGpt`, the `cloud_setting_up` / `cloud_failed` states,
Try again, the setup tip) and main's `subscriptionChatGptRelay` handler are gone. A ChatGPT sign-in this Mac holds now reads as connected, with nothing set up.

### Copy for the cloud lane: the `plan_switch_off` refusal

The cloud's current line, "Connect ChatGPT in Work on your Mac to use your plan", is wrong for a Mac that is connected but switched off. Adopt these
(`planSwitchOffLine()` in `src/app/work/copy.ts`). The quoted label must match this Mac's switch in Settings exactly (C4 renamed it):

- en: `Your ChatGPT plan is off on this Mac. Turn on “Assistants can use this Mac” in Settings.`
- vi: `Gói ChatGPT đang tắt trên máy Mac này. Bật “Trợ lý có thể dùng máy Mac này” trong Cài đặt.`

Keep "Connect ChatGPT in Work on your Mac…" for `provider_not_ready` (no plan connected), where it is correct.

## Verification

See the round note in `docs/work-gate-review-round-2.md` ("Round 4"). UI lane: `npx vitest run src/app/work electron/work/surface
electron/work/gate/platform.test.ts src/matrix/model-picker.test.tsx src/matrix/settings-revamp.test.tsx src/matrix/subscription-view.test.ts`;
playground states `?view=settings-work&work=ready&connect=…&plan=…&consent=…&sheet` and `?work=ready&connect=offer&page=chat`.
