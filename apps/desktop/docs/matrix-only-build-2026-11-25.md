# Matrix canonical build and legacy closure — 2026-11-25

State: built locally, not live. No push, PR, CI invocation, signing, deployment,
paid service or dependency installation. Shared workspace dependencies reused.

## Decision and existing implementation

The existing Matrix candidate builder, native helper stagers, Vite/esbuild and
Matrix builder configs are the implementation. No new build framework or agent
layer. Restored the missing public build entry from the existing candidate
builder and included the app-panel and Work preloads the current product uses.

Default build/dev/start/pack/package/dist now use Matrix. The package no longer
contains a legacy electron-builder target. `matrix:build` and `matrix:pack`
remain compatible aliases. Local packaging and signed release packaging use the
same `dist-matrix` app, with separate signing policy. The private coordinator
continues to own afterSign, notarization, release attestation and publication.
Public CI builds Matrix bundles on the hosted Linux client job; the retired
legacy desktop E2E job and its app-specific harnesses were removed together.

## Closure and removal

Inventory uses the existing TypeScript resolver for import/export, literal
dynamic imports and require, including concrete CJS beside declaration files.
Roots are Matrix HTML (including playground), native entries and retained
scripts. A separate conservative pass protects surviving renderer/type imports.
Matrix/work test fixtures are preserved. Test files do not keep retired product
modules alive; tests whose subjects were retired go with those subjects.

Removed 117 unreachable legacy Electron modules in two passes: 94 after removing
the legacy build roots, then 23 after changing two capability imports from the
messaging barrel to its existing account-roots module. That barrel exported the
old auth, HTTP, IPC and synchronization stack even though the callers needed only
account-path helpers. Deleted the retired main/preload, bootstrap/remote helpers,
legacy default builder/installer/performance harnesses and tests of those paths.
The old Shell HTTP endpoints are untouched: source closure does not establish
installed-client usage. Final resolver inventory: zero further non-Matrix/non-Work
Electron candidates. Two unresolved resources are generated `matrix-sdk.js` and
Vite's inline pet spritesheet, both checked by the real bundle build.

Kept because:

- Matrix imports consumer files, document recovery, PDF view, reporting sinks,
  observability, OAuth completion UI, window-mode constants and utilities.
- Staged swap cleanup/recovery/stage/state/store/updater/waiter and the stock
  updater/recovery tests protect existing installations and next-update recovery.
- Filesystem/interaction capability types still refer to account-roots and
  workspace-home; those helpers and their tests remain without the auth barrel.
- Matrix local homes, placement, migration, recovery, native jobs and offline
  code remain. Cloud placement policy is not deletion evidence for installed homes.
- The independent document-editor browser proofs under e2e/document-experience
  were restored after inspecting their imports: they do not launch the legacy app.
- The playground, its gallery and browser proof scripts remain. Presentation
  reuse and its type closure are not retired by this build-target change.
- Work's native sidecar, `work/gate/handoff-helper.cjs`, its declarations and
  `gate-revoke.test.ts` remain. Runtime CJS cannot be discarded merely because
  TypeScript resolves a declaration.

## Driver compatibility

Read the private `desktop-release-driver.mjs`, `signed-desktop.mjs` and native
helper list. All required public paths are listed in
`apps/desktop/docs/canonical-build.md`. The four native helper modules and
`matrix-after-pack` import successfully from the public clone. Release builder
still requires signing and DMG + ZIP, and its version matches the workspace
package-lock entry. The public build entry is restored. Both builder configs
claim `atum://`. No missing private afterSign filename remains in public config;
the private signed adapter injects that hook explicitly.

This proves public input availability, not the entire release preflight: a new
public commit must land on protected main and the private client-source lock must
be refreshed. Private overlay/digest attestations, release notes, exact-SHA CI,
disk floors and signing inputs remain the coordinator's release gates. No private
lock was edited and no signed release or hardware acceptance was attempted.

## Verification

Supported host Node 24.21.0. No dependencies installed.

- Canonical Matrix renderer/SDK/native/preload build: exit 0 before deletion;
  exit 0 after the final cut, including native macOS helper compilation.
- Full final typecheck: exit 0. Full final lint: exit 0, 4,006 warnings, zero errors.
- Updater/recovery and staged-swap tests: exit 0, 151 tests in seven files.
- Branding: exit 0, four tests against the Matrix configs and artwork.
- Adjusted Electron pin and presentation contract tests: exit 0 (736 tests in
  three files before the obsolete messaging-ownership suite was retired).
- Public release-driver required paths/imports and version/config contract: exit 0.
- Full final Vitest and exact-head public outbound guard pending at checkpoint.

The first full Vitest attempt was superseded during the second closure pass.
It exposed two obsolete legacy-entry assertions, which were removed with their
target or replaced by existing Matrix config checks. Final full suite is a fresh
run on the completed source tree. Python/runtime failures in setup-methods,
mac-job-startup, mac-job-runner and conversation/jobs match the earlier closure
audit; these four test files are unchanged from origin/main. Record the actual
final result below; do not describe the full suite as green without evidence.


## Final result

Combined diff against origin/main deletes 101,251 lines, including 49,016
Electron product lines and 47,031 test/harness lines. Restored independent
document-editor proofs are excluded from that deletion count. Net reduction is
about 100,700 lines after the restored builder and documentation.

Final full Vitest (`vitest run --maxWorkers=4`): exit 1 after 625.38 seconds.
Files: 1,582 passed, five failed, 14 skipped (1,601 total). Tests: 24,107
passed, 19 failed, 51 skipped (24,177 total).

Pre-existing environment failures: 17 tests across unchanged setup-methods,
mac-job-startup, mac-job-runner and conversation/jobs. The setup traceback names
missing Python dotenv; native job/cron fixtures cannot load their runtime. These
are the same test paths and failure class recorded by the prior closure audit.
No Python dependencies were installed to alter this machine's environment.

Additional full-run failures: two unmodified staged-swap recovery tests exceeded
their 15-second timeout while full typecheck/lint and other work were active.
The final focused updater/recovery rerun after those checks passed all 151 tests
in seven files, exit 0 (5.69 seconds). No timeout was increased and no recovery
code was changed. The full suite remains red; these focused passes do not erase
its result. No confirmed implementation regression remains from the run.

Public input compatibility/import check: exit 0. Matrix build: exit 0, including
renderer, SDK, seven native entries/preloads and macOS helpers. Branding: exit 0.
Dependency inventory and git diff whitespace checks: exit 0. The outbound guard
ran unpiped as `python3 scripts/public_guard.py --base origin/main --head HEAD`
and exited 0 on the implementation checkpoint; it is rerun on the final commit.

Generated local bundle/type output was removed after verification. Shared
dependencies were reused, never installed or modified. No push, PR, hosted CI,
deployment, release, signing operation or external spend occurred. The next
coordinator step is review/assembly, private source-lock refresh and exact-head
CI before any release decision; this work is built locally, not live.
