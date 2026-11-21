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
