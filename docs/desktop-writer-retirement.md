# Desktop writer retirement

The desktop no longer owns agent-home relocation, checkpoint/archive transfer,
ChatGPT relay publication, or execution-policy editing. The retained home
transport supplies Mac-job authority reads and fenced outcome publication.
Account subscription management and the Store continue to use their existing
account-scoped interfaces.

A monthly Store entitlement can change from `active` to `lapsed` in a snapshot.
That change must not re-enable the retired home or execution-policy bridges.
The chat keeps its draft and can submit through the current turn interface;
subscription authorization remains the service's responsibility. The app
regression test exercises the snapshot transition and spies on the former
writer methods rather than inspecting implementation source.

The title bar preserves the removal of the duplicate attention indicator and
of the retired placement controls. This preparation does not activate a release;
retirement must ship only after the service move.

## Verification

The lapse regression uses a synthetic public Store fixture identifier and runs with both values of the former cloud-only rollout
flag. It preserves a composed draft through renewal failure, submits the same
text through `sendTurn`, and asserts no home read, preparation, move, model
change, cancellation, or execution-policy read/save occurs.

Use the desktop's `test:ui:parallel` script with `--maxWorkers=2`, then
`test:ui:device-approval` (the repository's serial device-approval lane), for
complete UI project coverage on a memory-constrained host. `npm run typecheck`
checks the import boundary and all four TypeScript projects; `npm run lint`
checks the desktop sources. Both checks pass. The touched Python suites,
`tests/gateway/test_matrix_durable_intake.py` and
`tests/hermes_cli/test_atum_store_runtime.py`, pass through
`scripts/run_tests.sh` (58 tests). Five existing UI tests that encountered
long wall-clock stalls pass when rerun serially without changing assertions.

The complete non-device UI run covers 866 suites: 11,337 cases pass and one
case is skipped after serial recovery of six test timeouts and seven
worker-start timeouts. The two new lapse cases pass with the final public
fixture identifier. Device approval's real-time SAS comparison cases can
flake under host stalls: separate serial runs failed at different 45-second
and 75-second boundaries. The approval test, approval implementation, crypto
wiring, and dependency lockfile are unchanged from the base branch. Keep this
limitation visible when interpreting an aggregate UI result.
