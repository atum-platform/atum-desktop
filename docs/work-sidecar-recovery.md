# Work sidecar recovery

State: built locally, not released. Owner request (2026-11-24): Work must recover from a dead local server without restarting Atum. Release/installed validation remains with the coordinating task.

## Diagnosis and existing mechanisms

Baseline: desktop main eaaec3c94590d8fd717f4293802424315212e66c. The supervisor is owned here: `apps/desktop/scripts/stage-work-runtime.mjs:36` copies `electron/work/sidecar/supervisor.py` into the packaged runtime. No runtime-fork change is needed.

In the baseline supervisor, `processes():22` runs ps with a one-second timeout. `Children.scan():67` does not catch that timeout; the steady-state loop calls it at line 191 every 200 ms. An exception unwinds through `main():279-280` into `Children.stop()`, whose line 94 calls `Popen.terminate()` (SIGTERM) on the server and gateways. The exception handler discards the reason and exits 1. The tagged-process scan already catches subprocess failures; the primary process scan did not. There is no steady-state HTTP health probe or heartbeat watchdog in this wrapper. Gateway discovery probes are startup-only.

This is a verified failure mechanism consistent with the reported heavy-load incident; the supplied gateway SIGTERM log alone cannot prove which supervisor exit condition fired. Other existing termination conditions include stdin EOF, child death, process/RSS limits, trial startup failure and lock contention. Electron ends stdin on abort/stop (`process.ts`); account retirement and app shutdown deliberately use that stop. We preserve those paths. The old Electron exit callback only cleared credentials and process state, so every unexpected wrapper exit was permanent until another explicit start.

## Fix

Extend the existing scan and lifecycle rather than introducing another supervisor. Allow five seconds for ps, sample at two-second intervals and retain the last ownership/RSS snapshot on a failed observation. Successful scans still enforce the existing tree budgets. Forced shutdown scans and token-based detached-helper cleanup remain intact.

After an activated incarnation exits unexpectedly, WorkSidecar clears its credentials and retries with delays of 1, 2, 4, 8, 16, then 30 seconds (capped, continuing until recovery or intentional stop). A minute of healthy runtime resets the failure count. Crash recovery disables continuation of threads. A failed recovery launch also retries; explicit stop cancels pending retries. Account generation checks prevent restarting an outgoing account. An uncommitted trial is never automatically replayed; a committed trial recovers as a normal run.

The owner surface observes unexpected exits, discards the dead view, and reopens through WorkSession's existing start/pairing path with capped retry delay. A hidden surface waits until shown. Retry can immediately request that same deduplicated start even if the old surface still looked ready. Account detach, Work off and deliberate update suspension cancel surface recovery. No auth reset is added to ordinary crash recovery.

## Verification

Behavior tests execute the Python ownership scanner with repeated simulated ps timeouts and a real child, then verify ownership observations resume. A real fake-server subprocess exits with code 7 while the control pipe stays open, proving the wrapper returns on server death. Electron tests exercise unexpected exit, replacement incarnation, capped retries, failed startup during recovery, explicit stop with and without an account change, automatic view recovery, and Retry after death. They assert behavior, not source text.

Focused sidecar/surface Vitest, Electron TypeScript and changed-file ESLint pass (exit 0). The packaged-runtime integration test is skipped without explicitly supplied release resources. Public guard is run against the committed patch before handoff. No installed app, owner data, credentials, builds, CI, deployments or dependency installs are used. Temporary dependency symlinks are removed before commit; clone footprint is approximately 367 MB.
