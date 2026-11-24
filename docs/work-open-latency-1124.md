# Work open latency — implementation checkpoint (not released)

Owner request 2026-11-24: “Work often takes 10-20s to open even when Atum is already fully open - is that because it's a separate runtime from the atum app?” Target desktop 0.20.56.

Existing equivalents: WorkSession owns reset/pairing, WorkSidecar owns supervised recovery, WorkSurface already retains a hidden owner view. Use these paths rather than a second warm server or view. The 0.1.15 runtime's managedProvider already forks first checks after server readiness and streams each provider independently; its deferred-check regression tests prove first snapshots do not wait on probes. FirstRunGate is already disabled in Atum builds. No provider bypass or reduced capability was added.

Implementation: attach schedules one warm view after 2s, yielding while host load exceeds logical CPU capacity or while a restart holds the surface. Foreground show shares its pending open. Retirement/quit/Work off cancel pending work. A warmed sidecar recovers while hidden using existing backoff, through WorkSession. Remove independent immediate session.start in main-work and wait neither for gate enrollment nor balance before publishing owner-view readiness. Work-band subscriptions already run independently and need no change.

Chromium throttles background initialization across the pairing navigation. Disable background throttling only during initialization, restore on the authenticated threads-painted report, with a 15s fallback for older clients; dispose the timer on teardown. Initialize the detached view with desktop bounds to avoid zero-width/mobile hydration. Native background throttling remains enabled after warm-up.

Logs preserve `[atum-work] startup phase=… ms=…` and add absolute `at` timestamps for correlation. Server phases remain server-relative, page phases view-creation-relative, authenticated runtime phases owner-bind-relative. Click is ms=0. No URLs, grants, provider names, thread contents or credentials enter startup logs. Runtime `providers-ready` means the first usable provider snapshot, which can include pending probes; it does not claim all authentication probes finished. `threads-painted` requires a live shell projection and two animation frames after sidebar commit; detached views may report it on their first visible frame.

Verification and measured evidence will be appended before handoff. No push, PR, CI, release build or deployment is authorized in this lane. Runtime pin/manifest files belong to the coordinator.


## Measured evidence (single local samples; not release benchmarks)

Production WorkSurface + createWorkViewFactory, real Work 0.1.14 standalone server, a client-only build from 0.1.15 with the runtime phase hooks in this lane. Electron 44, 1200×800 owner region, temporary HOME/CODEX_HOME/CLAUDE_CONFIG_DIR and app userData. Provider executables were wrapped by sandbox-exec denying real credential directories and securityd. No real credential directories or Keychain were read. Controlled slow fixtures sleep 8s during probes. No inference requests were sent. Homes and processes are disposed after each sample.

Cumulative milliseconds from the foreground click:

| Phase | Before background-throttle correction (cold) | After correction (cold) | After pre-warm (opened at 12s) |
|---|---:|---:|---:|
| Click | 0 | 0 | 0 |
| Server ready | 4163 | 2195 | already ready 8277ms before click |
| View created | 4169 | 2200 | already created 8274ms before click |
| Page load (pairing) | 4482 | 2543 | already loaded 8148ms before click |
| Page load (authenticated) | 8108 | 4092 | already loaded 7129ms before click |
| WS/session connected | 8508 | 4597 | already connected 6800ms before click |
| Usable provider snapshot | 8508 | 4597 | already received 6800ms before click |
| Hydrated thread-list paint | 8562 | 4651 | 79 |
| show() returned | 7960 | 3932 | 8 |

The table's “before” uses the patched client solely for phase reporting and original Chromium throttling, rather than a stock-client A/B. Server launch varied with local load, so the delta is not all attributable to this patch: the post-server view portion was 4399ms before and 2456ms after. The useful result is that the existing view is reused on a warm click, without restarting the server or loading the page. A click before warm-up finishes still follows the shared cold open.

Additional stock 0.1.14 BrowserWindow probes (different host, so not an A/B with WebContentsView): no CLI PATH server3294/view3497/page3769/WS4178/sidebar shell4647; credential-sandboxed real CLI probes server2716/view2894/page3116/WS3528/sidebar shell4091; 8s slow probe fixtures server1835/view1911/page2028/WS2498/sidebar shell2920. These support the native async-provider invariant; they do not reproduce the owner's populated account/thread history or establish a percentile. The sidebar-shell detector in these stock runs is earlier than the hydrated-thread hook used in the table.

At the end of the final warmed sample the Work renderer working set was 284320 KiB (~278MiB); its sampled CPU and the host/GPU sampled CPU were 0%. This is one idle sample, not a sustained CPU profile. Exactly one native server and one owner view were used.


## Final local validation

Desktop full `npm run typecheck`: exit 0. Focused Electron vitest (`electron/work`, `electron/matrix/main-work.test.ts`, `electron/matrix/work-lifecycle.test.ts`): exit 0, 716 passed, 10 optional integration tests skipped (56 files passed, 3 skipped). These include hidden warm reuse, busy-host yield, hidden sidecar crash recovery, retirement/Work-off cancellation, no gate/balance blocking and authenticated/deduplicated phase reporting with background throttling restored. Existing supervisor recovery tests passed.

Focused ESLint: exit 0. `git diff --check`: exit 0. Public guard initially refused the shallow clone (exit 1); after fetching full history, `python3 scripts/public_guard.py --base origin/main --head HEAD` passed (exit 0). Desktop branch rebased onto b3cbeb7ada; runtime pin/manifest files are untouched by this commit.

Runtime companion: local commit 309b38727ae04d5e5553e622236e2e403d2137e2 on `fix/work-open-latency-1124`, base 55c226eb66, in the sibling atum-work clone. Client build and touched-file lint exit 0; 21 native provider lifecycle tests exit 0. Runtime web typecheck exits 2 solely for the pre-existing TS2345 in providerSettingsVisibility.test.ts:12; broad precommit knip cannot run with the intentionally filtered install (Expo/mobile/relay/desktop missing), documented in the companion commit. Coordinator owns assembly checks and release.

Intermediates, throwaway homes and runtime dependency/toolchain directories removed before handoff. Work is built-not-live and committed locally only; no push or PR was performed.
