# Desktop Work subscriptions assembly — 2026-11-23

Owner request: “Subs still don't work … no way for me to connect my subs”; “re-architect the connections setup … account level”; “make things work first”. State: assembly in progress, not live. Local-only lane; no push, PR, CI, deployment, credentials, or nested agents.

Base: origin/main 9259f675. Existing implementation is adopted through the requested branch merges, rather than adding another connection or relay layer.

## Assembly

1. Merged connections C4 b79a6889 (including C1 719d74b7 and C3 98d44105). No textual conflicts; preserves account-level connection setup and per-Mac switch.

Next: merge slice C, R2, and #90; align Q1/Q2 consent; pin and verify Work 0.1.12; run focused local checks.

2. Merged slice C 894e225a. Conflicts: `electron/matrix/main-work.ts` retains C4 WorkAccess and partitionFor plus connector shipment flag; `electron/work/sidecar/process.ts` retains managed-model/provider settings and removes connector secrets from gateway env, delivering connectorToken separately over supervisor stdin.

3. Merged R2 67b220a8. Conflict resolutions: main-work combines account registry/carry retirement with runtime readiness; ui-preload keeps readConnections plus per-plan IPC; gate/contract retains C4 model objects plus R2 relay schemas; gate/plan-fact and gate/service retain C4 multi-provider snapshot reporting and add R2 connectedPlans/account-consent projection; mount/gate-factory retains C4 native snapshot plumbing and adds R2 runtime/limit fences; sidecar/process retains managed providers and plan defaults plus runtime readiness; surface/ipc keeps account reads and per-plan consent; surface/projection combines account-plan and relay-provider types; surface/surface keeps account connect/carry path and R2 per-plan consent calls; shared/matrix-work combines account reads with per-plan contracts/parser. Renderer work/store and work-settings retain C4 removal of obsolete consent UI; plan-consent remains deleted; matrix/app uses R2 per-plan relay list with account connect fixes; model-picker retains account routes and R2 relay route groups.
Q1/Q2: account connect grants every eligible assistant and this Mac, including scheduled turns, for each of Codex, Claude and Antigravity. No separate schedule/assistant checkbox; the per-Mac switch remains the off switch. Runtime manifest staged at Work 0.1.12; final verification follows.

4. Merged #90 df5a8c13 (open at start). Conflicts: gate/plan-fact combines durable reporting off/refresh with C4 multi-provider monotonic snapshots and disconnects all plans; native-mac-reach.test retains C4 per-Mac switch UX and #90 route recovery coverage. Typecheck exposed and resolved duplicate connect helper and missing factory/surface option declarations.

## Final assembly corrections and verification

- Retained R2 protected filesystem roots and entitlement freshness in relay provisioning for every plan. Preserved C4 native capability/model objects and managed provider defaults, connector token stdin delivery, R2 runtime readiness gate and per-plan limits.
- #90 disconnect reporting works before Work starts, withdraws every acknowledged provider, stays disabled across reads, waits for an in-flight publication before withdrawal, and retries failures. Updated #90 notes to Q1/Q2; reconnect resumes publication while connecting a plan supplies assistant/schedule consent.
- Updated connection tests to assert explicit provider identity for all native plans; adjusted native Mac tests to C4 switch UX while preserving #90 failed-setup reset button.
- Work manifest: version 0.1.12; Node remains 26.13.1 (embedded binary strings confirm); fork commit 0da3a90a944ca206431940a9f0fa42a8f0cec8a1; archive atum-work-0.1.12-darwin-arm64.tar.gz; archive SHA-256 a563f469a425c735b20352f308a87f7c202950dd46684763326694a8b6cfb5e1; protectedConnector remains true from slice C.
- Existing stageWorkRuntime script passed archive SHA and arm64 verification (exit 0), generated pin version 0.1.12 and executable SHA-256 d8e1942fe737450729884f53534d9b7b7eadee4b5640f88664f4d1427c88ffdb. No extra executable hash field is required in runtime-tools.json. Staged executable --version returned t3 v0.1.12 (exit 0).
- Focused vitest command: `npx vitest run electron/work src/app/connections src/app/work src/matrix/model-picker src/matrix/settings src/matrix/native-mac-reach electron/matrix/main-work shared/matrix-work shared/account-connections electron/matrix/device/native-ssh`. Final result: 71 passed files, 3 skipped; 1041 passed tests, 10 skipped, exit 0. Includes connector and relay suites. Earlier runs found assembly failures, corrected before final run.
- `npm run typecheck --workspace apps/desktop` covers boundary plus four tsconfigs. Initial failed on merge seams; corrected run exit 0; repeated after final factory edits.
- Focused eslint of changed TypeScript passed (exit 0), five warnings (existing document globals and hook dependencies). Applied import/spacing autofixes across assembled changes. React checklist: atoms stay feature-owned; existing actions/transport retained; no added hooks or duplicate UI.
- `git diff --check`: exit 0.
- Public guard: initial raw-object scan stopped to remove a disallowed documentation path from local assembly history; final run recorded below. No guard policy relaxation.
- Dependency symlinks and staged 404 MiB runtime are removed before final commit. No install, push, PR, CI, deployment or real-account acceptance. Built locally, not live. Installed-app validation and coordinator review remain.

Final receipts: repeated four-tsconfig typecheck exit 0; focused Vitest exit 0 (1041 passed, 10 skipped); broader focused ESLint exit 0 (14 warnings, zero errors). `python3 scripts/public_guard.py --base origin/main --head HEAD` exit 0: 23 new commits passed raw paths/modes, ancestry, identifiers, secrets and metadata. Documentation was moved from the denied session-logs prefix to this allowed document, with local assembly commits reconstructed to remove that path from history; all four requested source heads remain ancestors. No public-boundary policy changes. Final runtime/dependency cleanup left a clean tracked tree, approximately 359 MiB, and `df -h .` showed 12 GiB available (94% used). Final doc-only receipt commit is checked again by public guard.
