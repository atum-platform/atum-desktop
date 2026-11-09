# Execution-policy desktop consumer

This is S-B's provider-pinned consumer core for the merged H-F contract
`atum.execution-policy/1`. The frozen provider pack is vendored byte-for-byte
under `fixtures/` from `atum-platform` merge
`4f1a2b2e705a1997d80c168cfeb98b310428e377`; `VENDORED.json` records its framed
SHA-256.

The core validates the policy, status, error, selection and semantic-validation
messages the desktop is allowed to receive. It exposes only logical `cloud` and
`mac:<deviceServiceId>` destinations. It rejects unknown fields, runtime IDs,
lease material, credentials and incoherent policy/status combinations instead
of trying to repair them in the renderer.

The Electron main process now owns the fixed provider routes, account bearer,
strict cache and narrow read/write IPC; the renderer receives only validated
policy/status snapshots and complete revision-fenced updates. The title-bar
machine strip and editor consume those snapshots without synthesizing authority
from the older `answering: cloud` or local-readiness flags.

The provider implementation is merged in `atum-platform` at
`1e12234760bcd81c14181a1760afc839f4d8982e`, but migration 0224 and the routes
remain undeployed. This source can therefore merge without claiming a live
provider, installed controls or F1 acceptance.

From `apps/desktop`:

```bash
npx vitest run --project electron shared/execution-policy/conformance.test.ts
npx vitest run --project electron electron/matrix/execution-policy.test.ts electron/matrix/lease.test.ts electron/matrix/hermes-listener.test.ts
npx vitest run --project ui src/matrix/execution-machines.test.tsx src/matrix/execution-policy-editor.test.tsx src/matrix/execution-policy-control.test.tsx
```

These tests prove the vendored pin, every declared provider fixture, closed
cache/write semantics, exact lease yield/drain behavior, display order,
privacy-safe labels, working animation and reduced-motion behavior. They do not
claim a deployed provider, an active production scheduler, installed UI or live
F1 acceptance.
