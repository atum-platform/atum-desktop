# Desktop 0.20.55 CI fixes — 2026-11-24

Base: `ab5fa7058b4c6f5c5301fd1b635bb462ae7791b9`, branch `release/0.20.55`.
Implementation worker scope: local changes, checks and commit only; no push,
PR changes, CI dispatch, cloud, deployments or dependency installations.

## Diagnosis and behavior

- Main test: outdated expectation after roster-primary targeting. The actual command
  creates a new chat inviting `@main:test`, never selects the former default's room.
  Assert exactly that command and no local connection when no room ID was returned.
- Cloud attachment: product regression. `snapshotForRoom` skipped the primary even
  when no local enrollment supplied its identity. Project the roster cloud primary
  into its own room using the existing room-view path. The composer still checks
  membership and assistant-room identity, but a cloud route does not require this
  Mac's executor to be ready. Local routes retain that check. The existing real app
  attachment test remains unchanged; add a projection contract test.
- Quiet launch: outdated fixture omitted resolved placement. The intentional roster
  gate suppresses setup notices before placement is known. Mark the six known-local
  assistants' roster ready; retain the full blocked notice, reconnect and clear
  behavior assertions unchanged.
- Ruff: previous-head unused `child` assignment was already consumed by gateway
  discovery on `ab5fa705`. `ruff 0.15.10 check .` passes with repository configuration;
  no Python code change is needed.

- Full-suite discovery: the hub requirement contract now returns `undefined` for
  absent/stale roster scope (unknown placement), rather than confirmed `false`.
  Update its two stale assertions; preserve Hermes-only false and mixed-roster true.

## Local verification

- Before changes, focused app + quiet-launch: exit 1, 474 passed, 3 failed.
- After changes, full app + quiet-launch + room-agent: exit 0, 485 passed
  (455 app, 22 quiet-launch, 8 room-agent).
- `npm run typecheck`: exit 0 (client boundary, renderer, consumer-browser,
  Electron and E2E TypeScript).
- `npm run lint`: exit 0, 0 errors and 4031 warnings.
- `ruff check .`: exit 0 with CI-pinned Ruff 0.15.10.
- Full desktop Vitest and committed-head public guard: results recorded below.

Dependencies reused temporary root/desktop node_modules symlinks to the supplied
shared-deps checkout. An initial full run without `.venv` was stopped after native
Python failures; the final full run reuses the existing Hermes Python 3.14.7 venv
with CI's Python-seam environment flags. That existing venv lacks `ruamel.yaml`;
no installation is authorized. Local Node is 23.10.0 (CI uses Node 24); shared
Vitest is 4.1.12. These checks do not replace the coordinator's exact-head CI gate. Temporary symlinks are removed before commit.


## Full-suite result and handoff

`vitest run --maxWorkers 4` completed, exit 1: 25,701 passed, 28 failed,
48 skipped (25,777 tests); 1,697 files passed, 12 failed, 13 skipped (1,722).
No renderer test failed. One failed Electron assertion was the unknown-roster
contract described above; its corrected suite was rechecked: 3 passed, exit 0.
The full run loaded that file before the assertion correction.

The other 27 failures are native Python paths across 11 files: mac-job-startup,
mac-job-runner, conversation/jobs, shared-group-runner, setup-methods,
atum-pet-sync, agent-content.integration, hermes-codex-signin.integration,
atum-agent-sync.integration, atum-store.integration and gui-host-integration.
Tracebacks directly show missing `ruamel.yaml` and `yaml`; subprocess-based cases
also report early backend/ticker exit, invalid child result or unavailable jobs.
These native paths are not verified green with this reused environment. Re-run
with CI's locked Python dependencies before shipping; no dependency workaround
or product weakening was added to hide these failures.

Final scoped ESLint after the roster assertion correction: exit 0, 0 errors,
6 warnings. `git diff --check`: exit 0. Public guard is checked directly against
the committed HEAD after this log and all source changes are committed.
No push or external release action was performed by this worker.

Committed-head public guard: exit 0, PASS for 8 new commits; raw paths/modes,
ancestry, identifiers, secrets and metadata. Rechecked after recording this result.
