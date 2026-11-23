# Desktop Work subscriptions assembly — 2026-11-23

Owner request: “Subs still don't work … no way for me to connect my subs”; “re-architect the connections setup … account level”; “make things work first”. State: assembly in progress, not live. Local-only lane; no push, PR, CI, deployment, credentials, or nested agents.

Base: origin/main 9259f675. Existing implementation is adopted through the requested branch merges, rather than adding another connection or relay layer.

## Assembly

1. Merged connections C4 b79a6889 (including C1 719d74b7 and C3 98d44105). No textual conflicts; preserves account-level connection setup and per-Mac switch.

Next: merge slice C, R2, and #90; align Q1/Q2 consent; pin and verify Work 0.1.12; run focused local checks.

2. Merged slice C 894e225a. Conflicts: `electron/matrix/main-work.ts` retains C4 WorkAccess and partitionFor plus connector shipment flag; `electron/work/sidecar/process.ts` retains managed-model/provider settings and removes connector secrets from gateway env, delivering connectorToken separately over supervisor stdin.
