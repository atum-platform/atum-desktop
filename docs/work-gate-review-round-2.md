# Work gate: review round 2 fixes · 2026-11-21

Slice A of the self-work plan, security gate for cloud assistants using the owner's Mac. Branch `feat/work-app-wiring-1121-fix`
(public desktop repo, PR 96), on top of the round-1 fixes (`8929c205`, `f0733187`). Local only: nothing pushed, no CI run.
The independent review of round 1 (blocking findings 1–4 and 7, non-blocking 9 and 10; 10 is platform-only) is answered below.
The platform half is in the platform repo's `docs/session-logs/2026-11-21-work-route-review-fixes.md` (round 2 section).

| # | Finding | Fix | Test (file) | Fails on round 1 |
|---|---|---|---|---|
| 1 | A retry still running after `nothing_started` | The ledger keeps the process of the LAST unresolved send (`incarnation`, with `prior_incarnation` restored when the last send is answered). An absent read settles only when made by a process confirmed (same id before and after the read) and different from it. `stopped` only on a 200 result with no error; the T3 client reports "no result" as an error | `gate-round2.test.ts` §1, `t3-client.test.ts` | yes (4 of 4) |
| 2 | Remove and re-add strands a grant | `agent_closed` reports the last RETIRED generation (new generation − 1). Grants are carried only after the event outbox is empty | `gate-round2.test.ts` §2, `sync-outbox.test.ts` | yes (2 of 2) |
| 3 | No reopen after a key rotation | Cycle: pull, settle, ack, then (intent open, `platform_route` not `open`) enroll again and queue `route_opened`, flush, then grants. A route event answered with another state is not delivered: an open answered `closed` stays queued, a close answered `open` is reissued | `gate-round2.test.ts` §3 | yes (4 of 4) |
| 4 | Off/on loses the reopen or its grants | `GateLedger.nextEventAt()`: strictly increasing, persisted; all events through `enqueueMacEvent`; grants only with an empty event queue and a platform-confirmed open route | `gate-round2.test.ts` §4, `service.test.ts` | yes (service-level and offline-cycle ones; the two ledger-level ones use the new API) |
| 7 | Update path bypasses the driver | `UpdateDriver.preflight` (no side effects); `WorkSession.update` answers refusals before touching view, partition or server; `WorkSession.start` runs the driver for a shipped pin above the committed one, refuses a downgrade; durable stop-ledger check (`GateLedger.owedCountAt`) when no gate runs | `session.test.ts`, `main-work.test.ts` | yes (4 of 4) |
| 9 | Outbox strands reports | Per-row `retry_at` for reports the platform refuses singly; no global backoff for them. A closed gate that owes the platform delivers at sign-in without the server (`resumeDelivery`) | `gate-round2.test.ts` §9, `mount.test.ts` | yes (2 of 2) |
| 10 | Rollback gap | Platform: the 0524 rollback keeps the change log | platform repo | yes |

## Wire and contract

No wire shape changed. Meaning made explicit: `agent_closed.agentGeneration` is the last retired generation (the platform already
stored it as `closed_generation`; the Mac used to send the new one). `mac_event.at` stays millis but is now a persisted strictly
increasing value (hybrid clock). `WorkPlatform.macEvent` now resolves with the platform's `routeState` when it gives one.

## Decisions and open points

- A stop owed does not block an update when no server can be holding the work (the app was quit and replaced): otherwise an owed stop
  and a newer shipped pin would wait for each other forever. It does block while this process hosts the server or `server-runtime.json`
  names a live process.
- A trial that rolled back on the installed path leaves Work stopped (the previous binary is not shipped); each start retries.
- `work_update_<reason>` start errors surface to the mount as `start_failed`; there is no owner-facing message yet.
- An old ledger file gets the two new columns on open (`ALTER TABLE ... ADD COLUMN`); a queued `agent_closed` written by round 1
  would carry the new generation (round 1 was never released).

## Verification

Desktop: `vitest run electron/work electron/matrix/main-work.test.ts` (with `ATUM_WORK_T3_BIN` set to the pinned `t3`) 547 passed; `npm run typecheck` clean; ESLint clean on the touched files; `scripts/public_guard.py --base origin/main --head HEAD` rc=0 (exit code read directly, never piped). The three suites that need `.venv/bin/python` (`mac-job-runner`, `mac-job-startup`, `conversation/jobs`) fail on this Mac with or without these changes. Not run: `process.integration.test.ts` (needs the bundled Python runtime).

# Round 3 · 2026-11-21

A re-check of round 2 closed findings 1–4, 7, 9 and 10 and raised two new blocking issues. Both are fixed; local only (nothing pushed, no CI run).

| # | Issue | Fix | Test | Fails on `ec5a7b62` |
|---|---|---|---|---|
| A | An installed-update rollback started the failed new pin again. On an installed upgrade `currentPin()` is the newly shipped binary while durable state names the older committed version, so the driver used the NEW pin as both current and target; after the restore it started that binary with no trial context | `UpdateDriver` keeps the committed version (`fromVersion`, from durable state) apart from the previous binary (`previous`, set only when the running pin IS the committed version). A rollback with no previous binary restores, resets and returns stopped (`rolled_back`, host = the stopped trial host, no incarnation): nothing is started. The recovery marker and snapshot are cleared only after the restore and reset finish, as before | `session.test.ts` "an installed upgrade whose trial fails ends stopped…" | yes |
| B | A cached platform-open state could block recovery forever (rotation with no agent announced, platform rollback and re-apply) | Two signals, both from answers the platform already gives. (1) A grant carry refused with 403/404/409 (`route_closed`, not enrolled, `stale_enrollment`) drops the cached confirmation (`platform_route` → `unknown`); the next cycle enrolls again, queues `route_opened`, flushes, then carries. Repeats are on a growing delay (30 s, doubling, 15 min cap) so a refusal that enrolling cannot cure does not enroll every cycle; a successful carry resets it. (2) While consent and the switch say open, a confirmation `route_opened` is queued every 5 minutes (and on the first cycle after a start); its reply names the state the platform holds, and `closed` sends the next cycle through the enrollment. Needed because a caught-up Mac with live grants has nothing to carry | `gate-round2.test.ts` §3b (4 tests) | scenarios: yes (3 of 4; the fourth, the growing delay, is a guard that also passes before) |

No platform change and no wire change: `route_opened` is the existing idempotent event; the carry statuses are the ones `work-route.test.ts` pins on the platform.

## Decisions and open points (round 3)

- After a trial that rolled back with no previous binary, Work is stopped and the next start tries the update again (unchanged from round 2; now also true of the driver itself, not only the caller's stop).
- The platform's `reason` text is not read: the Mac acts on the status only (the client throws status-only errors by design). A 403 or 409 that has another cause (not eligible, stale generation) costs at most one enroll + `route_opened` per backoff step.
- The 5-minute confirmation is the bound for the rollback and re-apply case with no carry to make; the carry refusal is the fast path (next cycle).
- No wall clock is involved in the confirmation but `now()`, which tests drive.

## Verification (round 3)

`vitest run electron/work electron/matrix/main-work.test.ts` with `ATUM_WORK_T3_BIN` set to the pinned t3: 459 passed, 1 skipped (`process.integration.test.ts`, needs the bundled Python runtime); `npm run typecheck` clean; ESLint clean on the four touched files; `scripts/public_guard.py --base origin/main --head HEAD` exit code read directly (see the commit). The test count differs from round 2's 547 because that run covered a wider path set; the same command on `ec5a7b62` gives 454 passed, 1 skipped.

# Round 4 · 2026-11-22 — slice B: the subscription relay (gate 4a/4b)

Not a review round: the next piece of work on the same gate. Branch `feat/work-subscriptions-gate-1122`, local only (nothing pushed, no CI run, no PR).
Design and the per-rule table: `docs/work-subscriptions.md`.

| What | Where | Tests |
|---|---|---|
| Contract 1.2: `contract:"1.2"` pull (with the 1.1 fallback on 400), the consent snapshot stored in the page's transaction, `consentRevision` in the ack | `gate/contract.ts`, `sync.ts`, `ledger.ts` | `sync-plan.test.ts` |
| The plan fact (G9), from T3's own provider status, on change, hourly and at sign-out | `gate/plan-fact.ts`, `t3-client.ts` (`planProvider`), `platform.ts` | `plan-fact.test.ts`, `t3-client-plan.test.ts`, real pin |
| 4b-1/4b-3: compiled provider list, the contract's four-step decision, the fence at the handoff, re-read before a send, plan-only revocation | `gate/gate.ts`, `ledger.ts` | `gate-plan.test.ts` (43), `http.test.ts` B-0 block, real pin |
| The local switch (default OFF), its row and IPC | `service.ts`, `mount.ts`, `surface/*`, `shared/matrix-work.ts`, `src/app/work/*` | `mount.test.ts`, `surface.test.ts`, `work-settings.test.tsx` |
| Containment of delegated threads | `acp_adapter/profiles/delegated.yaml` | `tests/acp_adapter/test_delegated_containment.py` (46, two strict xfail gaps) |
| The old SSH ChatGPT relay removed | see `docs/work-subscriptions.md` "Removed" | `native-ssh.test.ts`, `account-subscription-flow.test.ts`, `connection.test.ts` |

## Decisions and open points (round 4)

- **"Scheduled"** = the launch is not backed by a fresh, verified, unclaimed message of the owner (the slice-A claim's own test). Defined in
  `docs/work-subscriptions.md`. `alsoWhenScheduled` changes nothing in slice A (no standing permit); it matters when permits return.
- A plan thread being stopped blocks that assistant's Atum launches for the seconds the stop takes (existing agent-scope block).
- A tampered ledger row that names a provider outside the compiled list is refused at the handoff (`invalid_field`), never sent.
- **Open, owner's call (plan §10.3, B-0):** the file tools can read the plan's login store as the same macOS user, and a delegated thread runs on the Atum model.
  The terminal and the T3 tool surface are closed; this one is not. Either an isolated assistant environment for accounts with a plan connected, or 4b stays closed.
  Until then the sidecar keeps the Codex instance disabled.
- The "Use this Mac for ChatGPT" row in `src/matrix/subscriptions.tsx` is left for the Connect step; main answers it `unavailable`.

## Verification (round 4)

- `vitest run electron/work electron/matrix src/app/work src/matrix shared` with `ATUM_WORK_T3_BIN` set to the pinned t3 v0.1.11: 1,013 files and 17,883 tests
  passed, 39 skipped, **18 failed in 5 files, all because this Mac has no Python runtime for them** (`mac-job-runner` 10, `conversation/jobs` 4,
  `mac-job-startup` 2, `atum-messaging/shared-group-runner` 1, `shared/setup-methods` 1: `runtime_unavailable`, `No module named 'dotenv'`). The first
  three are the ones round 2 already named; none touches this change. `electron/work` alone has 593 passing tests with `main-work` and `src/app/work`.
- `npm run typecheck` clean (boundary, renderer, consumer browser, Electron, e2e). ESLint on the 45 touched and new TypeScript files: no errors (the
  warnings that remain are padding and `document` warnings that were in those files already).
- `scripts/run_tests.sh tests/acp_adapter/test_delegated_containment.py tests/acp_adapter/test_managed_profile.py`: 50 passed (46 + 4), including two
  strict `xfail` rows for the gaps; `--runxfail` shows the file-tool row fails because the marker token is returned.
- `python3 scripts/public_guard.py --base origin/main --head HEAD`: rc=0, read directly.
- Not run: `process.integration.test.ts` (needs the bundled Python runtime), a real Codex login (none on this Mac), CI, any push.
