# Legacy desktop dependency closure — 2026-11-25

Fresh public desktop origin/main: dependency inventory, not a filename-glob retirement. The default public build still bundles electron/main.ts; Matrix release/build scripts named in package.json and matrix-playground.html are absent in this projection. Retain that supported default path until build ownership is resolved. No HTTP server routes were removed; installed-client usage evidence remains a separate prerequisite.

## Method

Existing TypeScript compiler API (no knip configuration found and no dependency added). scripts/legacy-dependency-closure.mjs parses import/export, literal dynamic import/require, resolves aliases with tsconfig, preserves concrete CJS runtime files alongside declaration resolution, walks all desktop scripts, HTML renderer entries (including playground/pages/pet), Matrix main and preload entries, legacy default main/preload, and the full Vitest/E2E test closure. This conservatively keeps test-only modules. Nonliteral loading and unresolved local specifiers are reported for manual inspection. Text search over the whole checkout confirmed no source import or dynamic filename references for either deleted module. The CI classifier merely names backend-discovery as a path category; it does not load it.

Graph at base: 1909 roots; 2696 product nodes; 4665 required nodes; 384 unresolved local specifiers repository-wide. These include fixtures/other surfaces: this is not a claim that all public source paths build.

## Deleted

| Module | LOC | Reason |
|---|---:|---|
| electron/backend-discovery.ts | 78 | No import, script, runtime filename consumer or test |
| electron/mac-plist.ts | 46 | No import, script, runtime filename consumer or test |

No tests were deleted: neither dead module has a test subject. All other apparent test-only leaves were retained conservatively.

## Kept because

Matrix main directly imports atum-consumer-files and atum-reporting-sinks, plus atum-staged-swap/{cleanup,recovery,state,store,updater}. The transitively reachable PDF, Google and document utilities stay. All Matrix local homes/placement/recovery code stays. The dedicated matrix-playground.html renderer and its browser proof scripts stay. work/gate/handoff-helper.cjs stays: relay.ts imports its runtime even though TypeScript resolves its declaration. gate-revoke.test.ts stays: its transitive harness guards shipped revocation.

electron/main.ts and legacy messaging stay because package.json build/dev scripts and bundle-electron-main.mjs explicitly build them. Deleting them would knowingly break the required public build. This keeps the legacy HTTP callers too; removing those routes needs independent installed-client evidence.

## Old /api/desktop/v1 callers

- `apps/desktop/electron/atum-messaging/account-auth.ts` (1561 LOC); retained by default legacy build closure.
- `apps/desktop/electron/atum-messaging/app-surfaces.ts` (1293 LOC); retained by default legacy build closure.
- `apps/desktop/electron/atum-messaging/http-client.ts` (1971 LOC); retained by default legacy build closure.
- `apps/desktop/electron/atum-messaging/shared-group-device.ts` (638 LOC); retained by default legacy build closure.
- `apps/desktop/electron/atum-messaging/shared-group-runner.ts` (1115 LOC); retained by default legacy build closure.
- `apps/desktop/electron/atum-store.ts` (703 LOC); retained by default legacy build closure.

Generic legacy HTTP-client direct importers:

- `apps/desktop/electron/atum-messaging/app-surfaces-ipc.ts`
- `apps/desktop/electron/atum-messaging/app-surfaces.ts`
- `apps/desktop/electron/atum-messaging/index.ts`
- `apps/desktop/electron/atum-messaging/runtime.ts`
- `apps/desktop/electron/atum-messaging/shared-group-device.ts`
- `apps/desktop/electron/atum-messaging/sync-coordinator.ts`
- `apps/desktop/electron/atum-protons.ts`
- `apps/desktop/electron/atum-store.ts`

## Outside Matrix source closure, retained by required default build/scripts/tests

This is the measured inventory the proposed glob would overreach. Absence here is not deletion permission. Matrix source roots include preloads and renderer entries; the broader required graph above decides deletion.

| Module | LOC |
|---|---:|
| `apps/desktop/electron/atum-account-boot.ts` | 11 |
| `apps/desktop/electron/atum-advisory-ipc.ts` | 120 |
| `apps/desktop/electron/atum-agent-portability-ipc.ts` | 153 |
| `apps/desktop/electron/atum-agent-portability.ts` | 562 |
| `apps/desktop/electron/atum-agent-sync.ts` | 909 |
| `apps/desktop/electron/atum-default-pet.ts` | 203 |
| `apps/desktop/electron/atum-document-theme.ts` | 453 |
| `apps/desktop/electron/atum-filesystem-ipc.ts` | 430 |
| `apps/desktop/electron/atum-managed-model-ipc.ts` | 56 |
| `apps/desktop/electron/atum-managed-model-proxy.ts` | 1446 |
| `apps/desktop/electron/atum-managed-request-journal.ts` | 205 |
| `apps/desktop/electron/atum-managed-request-retry.ts` | 65 |
| `apps/desktop/electron/atum-messaging/advisory-history-source.ts` | 139 |
| `apps/desktop/electron/atum-messaging/shared-group-control.ts` | 459 |
| `apps/desktop/electron/atum-messaging/shared-group-device.ts` | 638 |
| `apps/desktop/electron/atum-messaging/shared-group-runner.ts` | 1115 |
| `apps/desktop/electron/atum-messaging/window-events.ts` | 40 |
| `apps/desktop/electron/atum-office-export.ts` | 409 |
| `apps/desktop/electron/atum-office-import.ts` | 115 |
| `apps/desktop/electron/atum-office-pdf.ts` | 337 |
| `apps/desktop/electron/atum-pet-sync.ts` | 202 |
| `apps/desktop/electron/atum-protons-ipc.ts` | 43 |
| `apps/desktop/electron/atum-protons.ts` | 123 |
| `apps/desktop/electron/atum-runtime-home.ts` | 28 |
| `apps/desktop/electron/atum-staged-swap/test-fixtures.ts` | 100 |
| `apps/desktop/electron/atum-store-ipc.ts` | 111 |
| `apps/desktop/electron/atum-store.ts` | 703 |
| `apps/desktop/electron/atum-utilities/ipc.ts` | 32 |
| `apps/desktop/electron/atum-vibrancy.ts` | 321 |

Total listed: 9528 LOC in 29 modules.

## Verification

Base revision: d83d6f40eaab5ad1ffeab67019c38fc1625c11f8. Shared existing Node dependencies reused; no installation.

- Baseline full desktop typecheck: exit 0.
- Full desktop lint: exit 0 (4,067 existing warnings, zero errors).
- Default Electron bundle: exit 0, repeated after deletion with exit 0.
- Matrix Electron main bundle (esbuild, packages external): exit 0.
- Matrix preloads bundle (esbuild, packages external): exit 0.
- Desktop updater/recovery unit tests: exit 0, 47 tests in 2 files.
- Staged swap updater/recovery suite: exit 0, 104 tests in 5 files.
- Graph after deletion: exit 0, zero further non-Matrix Electron candidates.
- Post-deletion full desktop typecheck and full Vitest suite: running at this checkpoint; final outcomes follow. Full Vitest already reports pre-deletion failures, including missing Python dotenv.

The release config requires signing. Used the supported default Electron bundle and an additional Matrix-main/preload bundle rather than invoking a signed packaging/release path. These checks do not certify signed install/upgrade or hardware acceptance. No push, PR, CI or deploy.
