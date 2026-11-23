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
