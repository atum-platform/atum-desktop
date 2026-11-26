# 2026-11-26 Work gate retirement

Implemented the desktop deletion on `chore/delete-legacy-gate` from
`603d7062`. The [retirement follow-up](work-gate-retirement-1126.md)
records the removals, provider settings migration and the compatibility
exchange for subscription facts. The desktop uses the native Connect route
for remote Work and owner-scoped platform reads for consent and selection.

The host still reads legacy-backed subscription flags for scheduled Mode B.
The desktop no longer publishes the agent announcements backing these flags.
Verify native scheduled consent on a fresh device, a key rotation, and a newly
added assistant before rollout. Cloud and platform source were inspected
locally. This task made no cloud or platform changes.

Local verification covered the public dependency helper, desktop typecheck,
focused Electron and renderer Vitest with real supervisor startup in a
temporary home, canonical Python tests for the ACP profile and supervisor
merge, focused ESLint, and the public-boundary guard on the local commit.

## Main integration

Merged `99c084b0c3` (Work ACP startup). The owner provider still passes
`--wait-for-gateway` to the managed ACP entry point, giving the supervisor's
gateway up to 25 seconds to become ready. The conflicting sidecar test now
asserts the launch arguments for the owner provider. The startup settings test
covers removal of the retired provider entries from saved settings, and the
ACP regression exercises session creation as the managed gateway becomes ready.
