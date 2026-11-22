# Work: main-process integration (`apps/desktop/electron/work/mount/`)

How main holds Work: the session (`work/session`), the sidecar host (`work/sidecar`) and the assistants' gate
(`work/gate`) start, retire and tear down together through one object, `WorkMount`. It takes every main-owned
dependency as a port, so any composition (this public main, the Matrix composition) mounts it the same way.

## Order

The session server is **not started at sign-in** (plan D7). `WorkMount.reconcile()` builds the gate (it only opens the
ledger) and starts the server only on first use or while there is an active delegation:

- first use: the owner opens Work (`WorkSurface` → `parts.wantServer()` → `WorkMount.wantServer()`), or accepts the
  Work screen / flips the assistants' switch (both call `wantServer()` first);
- an active delegation: the ledger shows the Work grant accepted, the route open and the switch on, or a stop still owed;
- a reset or restore a crash left pending (`WorkSession.held()` reads the marker from disk), so it is healed at sign-in.

Retiring, Work off and quit clear the "used" flag. `reason: 'not_needed'` is the state of a signed-in account that has
done neither.

| Event | Order |
|---|---|
| Start (`reconcile()`) | surface `on` + signed-in account + a gate the composition can build -> `WorkSession.start()` (recovery and the auth-reset marker first) -> enroll -> `gate.start()` only while `held()` is false -> bind the socket only when the owner accepted the Work screen (D9) and the switch is on |
| Sign-out / account switch (`retire(account)`) | gate cutoff, socket removed, owed stops settled **while the server runs** -> `WorkSession.retire` (views closed, process group stopped, partition cleared, auth reset) -> gate closed. A failed step never skips the next; unsettled stops stay owed in the gate's ledger |
| Work off (`workOff()`) | gate cutoff -> host disabled. Turning Work on does not reopen the route: the owner turns the switch on |
| Quit (`quit()`) | gate closed (no cutoff: quitting is not a revocation), then the process group stops |

Hiding the Work entry only keeps the gate from starting; it stops nothing that runs. A start still in flight when the
account retires finishes into nothing (epoch fence).

## Pieces

- `owner-event.ts`: `OwnerEventVerifier` for the gate. Reads the owner's event through the app's own Matrix SDK
  (`readInvocation`, `findAssistantRoom`): the room comes from the account's agent record, the sender must be the
  owner on a device the owner's crypto trusts (or the homeserver-authenticated sender of a plain room), and the event
  must be the owner's own plain text (not an edit, thread, forward or Google-protected content). A homeserver outage,
  a client that is not ready, a roster that did not load or an account that changed mid-read is `unreachable`
  (`unavailable` to the helper, retry the same id). Only stable, specific answers become a refusal. The age bound and the
  one-message-one-launch claim stay in the gate and its ledger.
- `secret-store.ts`: the gate's `SecretStore` over `EncryptedStore` (Electron safeStorage, Keychain-held key), one file
  per account. No plaintext fallback: with no keychain a session is not issued.
- `gate-factory.ts`: `createWorkGateService` fills every port main owns (T3 client, sessions, secrets, socket path of at
  most 100 bytes in a per-account directory). The composition supplies the device-service id, the platform client and the
  owner-event source.
- `mount.ts`: the lifecycle above.

## The Matrix composition (`electron/matrix/main-work.ts`, `work-lifecycle.ts`)

The installed app is the Matrix composition. It builds the app-wide Work objects once (`WorkHost`, `WorkSession`,
`WorkMount`, `WorkSurface`, the window's IPC) and binds them to the signed-in account through `MatrixWorkLifecycle`.

| Event | What runs |
|---|---|
| Window `ready` (`publish`) | `work.activate()`: the account is the Matrix account's scope + the owner principal + this Mac's device-service id (none of them yet: no Work entry). `prepare` checks the build has `work-runtime/t3` and `matrix-work-preload.js`, and the model proxy is up; otherwise nothing is drawn. Then `surface.attach(parts)` and `mount.setSurface('on')` (the local gate: the platform declares no `work` surface id yet) |
| A different account or generation | the old one is retired first (page detached, then `mount.retire`), then the new one bound |
| Sign-out, session ended | `retireWork()` before `account.signOut` / `stopSdk`: page detached, gate cutoff and stops settled while the server runs, server stopped, partition cleared, auth reset. Bounded at 60 s; never throws |
| Quit | `work.quit()`: gate closed without a cutoff, server stopped |
| Settings › This Mac | one row: **Work on this Mac** (`setWork` → `mount.workOff()` / `workOn()`); the per-Mac **Assistants can start work here** row beside it when the Mac has the route |

Model path. Work's Hermes gateways present a key minted by `WorkModelKeys` (`main-work.ts`) to the Matrix managed-model
loopback (`managed-model.ts`; role `work`, listed through `work.modelKeys()` in its `keys()`), which adds the person's
domain bearer; the gateway holds and settles Protons. The retired desktop proxy and broker are not in the Matrix bundle
(its build refuses `electron/atum-messaging/`). "Add Protons" inside the view, and the title-bar button, open
`${resource}/payments/protons`.

- **Account isolation.** The key is bound to the account key and generation it was minted for; `keys()` answers nothing
  once the signed-in scope differs, and `forget()` (synchronous, at the start of every retire and quit) drops it and
  calls `MatrixManagedModel.abortAgent('work')` to cancel forwards already on their way. The proxy re-checks that the
  key is still current before it fetches the bearer and again before it sends, so a switch between authenticating a
  request and forwarding it cannot borrow the next account's bearer.
- **Balance.** `readWorkAccess(model, wallet)` first reads the owner's wallet (`account.wallet`, the ledger read the
  Matrix wallet uses; at least `WORK_MIN_AVAILABLE_MICRO_PROTONS` = 1 Proton is "allowed", less is "empty", an
  unreadable or malformed wallet is "unavailable"), then the proxy's free `GET /v1/models` probe, which only proves the
  catalog and the sign-in. The gateway's per-call completion hold stays the final spending check. The 1-Proton floor is
  provisional.
- **Billing (unchanged, recorded here).** The gateway meters every call per owner. Work presents the model name
  `binh-minh`; the proxy maps every Atum model name to the model the call should use, which for Work resolves to the
  `nguyet-thuc` line-up entry. The coordinator is confirming this mapping with the owner; no code changes with the answer
  except that name.

`restartWhenIdle` restarts the session server only when the owner's own threads are all at rest
(`WorkGate.ownerRunsIdle`, read through main's owner session); the page's view closes for the restart
(`WorkSurface.suspend`) and returns after it.

## Server settings and the pinned T3

`WORK_REQUIRED_SERVER_SETTINGS` (`sidecar/process.ts`) is merged into T3's settings by `supervisor.py` before the server
opens the home, on every start. It holds `linkedEnvironmentsEnabled: true`: against the pinned 0.1.11 server a peer-link
OAuth registration (the agents' sessions) answers 400 without it and 201 with it, so a fresh install had no agent
session. `T3Sessions` turns any registration refusal into `t3_oauth_register_failed`. The gate's thread list always
passes `allProjects: true` (T3 answers `target_required` to a client outside a thread otherwise), and `ownerRunsIdle()`
accepts only one complete native page: no cursor, `total` equal to what came back, known and quiet statuses, no thread
blocked on a wait or holding background tasks.

Real-pin tests: `ATUM_WORK_T3_BIN=<resources>/work-runtime/t3 npx vitest run electron/work/gate/real-t3-gate.integration.test.ts electron/work/session/real-t3.integration.test.ts`.

## The cleanup and the platform's reports

- A stop is `stopped` only after a native `t3_thread_interrupt` T3 accepted and a read after it that shows nothing in
  flight; a failed stop, a failed read or a still-busy thread leaves the row owed. Every sync tick retries what is owed.
- A rejection T3 gives to a *retry* is parked (`reason` on the admitted row) while an earlier send's outcome is unknown;
  the claim on the owner's event and the stop obligation stay until a read made by a *confirmed* T3 process other than the
  one the LAST unresolved send went to shows the thread absent, and then the rejection and the claim release are one
  transaction. The ledger keeps that process (`incarnation`) and the unresolved send before it (`prior_incarnation`, restored
  when the last send is answered for good). A retry sent to a newer process is still running there: an absent read from that
  process proves nothing. A read is credited to a process only when its id is the same before and after the read.
- "Explicit success" of a native Stop is a 200 with a result and no error; a reply with no result (a proxy page, a JSON-RPC
  error, an empty body) is an error everywhere in the T3 client, so `stopped` is never claimed on one.
- The agent's session id stays in memory and the store until T3 confirms it revoked (or no longer lists it), and a
  revocation is acknowledged only once that succeeded.
- The cutoff and its `mac_event` are queued in one ledger transaction. A route/agent event the platform definitively
  refuses (400, 409, 410, 412, 422) is superseded when a newer event of its family is queued; the newest of a family is
  kept; events behind a refused one are not held back. Other failures (offline, 401, 429, 5xx) keep the order.
- **Event order and the reopen.** Every `mac_event` gets a time from `GateLedger.nextEventAt()`: the wall clock, but never at or
  below the last one given (kept in the ledger, so a restart or a clock set back cannot reorder or tie a close and an open).
  An agent close (`agent_closed`) reports the last RETIRED generation, never the new one: the agent's next grants are minted at
  the new generation and must stay carriable (the platform keeps `closed_generation` at the retired one). A route event the
  platform answers with a state other than the one asked for is not delivered: a reopen answered `closed` (held until this Mac
  has applied the cutoff, acknowledged and enrolled again) stays queued and is sent again; a close answered `open` was older than
  an event the platform holds and is reissued with a newer time. The sync cycle is: pull and apply, settle, acknowledge, then
  (consent and switch still say open, the platform's route not known open) enroll again and queue `route_opened`, then flush
  the events, then carry grants. Grants are carried only on a route the platform has confirmed open and with no event of this Mac
  still queued, so a queued close can never delete a grant that was just carried. After a restart, or a platform-made removal,
  the platform's route state is unknown (`platform_route` in the ledger), which is what triggers the enroll-and-reopen.
- Reports the platform refuses one at a time (a 400 for that report) go on their own schedule (`outbox.retry_at`: 30 s,
  doubling, six hours at most), so a full batch of such reports never stands in front of ones it would accept. A closed gate that
  still owes the platform events or reports delivers them at sign-in without the server (`WorkMount` keeps a delivery-only
  service until nothing is pending).
- Retire delivers the cutoff, the settled stop reports and the acknowledgement in one bounded flush (10 s,
  `retireFlushMs`) before the owner's credential goes. A settlement batch is cleared only when `accepted + ignored`
  equals the number of reports sent.
- The immediate answer after a cutoff is "Access to this Mac was revoked."; whether the work stopped is told by the
  cleanup and its report.

## Update driver and process ownership

- `WorkSession` is built with the update driver (`readShippedPin`: `work-runtime/pin.json`, written by
  `stage-work-runtime.mjs` with the version and the `t3` digest), so `start()` runs its crash recovery before any server
  opens the home, and `work.update(target)` is main's one door for moving the pin. An update is refused while a stop is
  owed. The first `update` records the running pin as the baseline for the downgrade refusal.
- The installed path goes through the driver too: every `WorkSession.start()` compares the pin this build ships with the one the
  home last committed. No record: the shipped pin is the baseline. Shipped below committed: nothing starts
  (`work_pin_downgrade`). Shipped above committed: the update driver runs (reset, snapshot, trial, commit or restore) BEFORE the home
  opens; a refusal (`work_update_<reason>`) or a trial that rolled back (`work_update_rolled_back`, the previous binary is not part of
  the build) leaves the server stopped and is retried at the next start.
- Every refusal that can be known up front (`UpdateDriver.preflight`: in progress, downgrade, not newer, a stop owed, an
  unverified pin, too little disk) is answered BEFORE a view is closed, the partition cleared or the server restarted. "A stop is
  owed" reads the running gate, or (no gate this run) the durable stop ledger file (`GateLedger.owedCountAt`); it blocks only while
  a server could still be holding the work (this process's host, or a live pid in `server-runtime.json`): an app that was quit
  and replaced has no server, and the owed stop settles when the gate starts on the updated pin.
- `supervisor.py` gives every child an `ATUM_WORK_OWNER=<token>` environment entry and finds descendants by that token
  as well as by parentage, so a shipped helper that detaches and is reparented to launchd is still stopped (rescanned on
  every stop). Apple platform binaries hide their environment from `ps`; none of the shipped helpers is one.

## T3's own database (documented risk)

T3's `statev2.sqlite` keeps pairing-link rows in plaintext, including the credential, and `update.ts` copies the
database into a snapshot. The update flow therefore resets BEFORE the snapshot (the snapshot holds revoked rows), the
snapshot is deleted after the commit, after a completed restore and when a crash left nothing to restore, and every
sign-out, switch and failed pairing runs the full auth reset (sessions and pairing links revoked while the server is
stopped). Nothing here encrypts T3's database; that is T3's.

## Open

- Stop reports (`StopReport`) are delivered with `work.mac.settlements` (contract 1.1); `state().gate.undeliveredReports` counts
  what is still queued.
- The release build must bundle `electron/work/sidecar/preload.ts` as `matrix-work-preload.js` (private
  `build-matrix-candidate.mjs`) and pass `ATUM_WORK_ARCHIVE` to `matrix-after-pack.mjs`; without either, Work is not drawn.
- The Work billing join (`work/billing.sqlite`) belonged to the retired proxy; Matrix meters each call at the gateway.

## Subscriptions (slice B): contract 1.2, the plan switch and what replaced the SSH relay

Full note: `docs/work-subscriptions.md`. In short, for the integration:

- The gate pulls as `atum.work-route/1.2`, applies the consent snapshot in the page's own transaction and acks its `consentRevision`; the plan fact
  (`PlanFact`, G9) rides the sync cycle and the last bounded flush of `retire`. A platform that answers 400 to 1.2 is pulled as 1.1.
- A launch may name `plan: "codex"`. The Mac decides stale → consent → local switch → not scheduled, sets the provider from the compiled list, debits
  nothing, and re-checks at the handoff. Revocation cuts off plan threads only.
- `createWorkGateService` configures the T3 client with the compiled plan instance; the gate state carries `planSwitchOn`, `planConnected` and
  `planConsent`. The surface projects `plan: 'off' | 'on'` (absent while no plan is connected and the switch is off), `setPlan` is one more request on the
  Work IPC, and Settings › This Mac draws "Agents may use my ChatGPT plan here" (default OFF).
- The sidecar still ships Codex disabled; the Connect step enables it. The SSH ChatGPT relay is removed from main, the device runtime and the build.
