# Work UI 0.1.13 plumbing — built, not live (2026-11-23)

Implements K1 and E8 from design spec `70dd4ea701f236992abba5b069dc41beddcfc890`. Owner requests: “the design of Work isn't in line with our consistent aesthetics - icon uses for example”; “get the mode split folded in”. The coordinator owns visible UI, assembly review, runtime version/pin and release. No push, PR, CI, cloud, credentials, archive or deployment work occurred.

K1 adds exactly the 37 spec names to the Kit manifest and rebuilds Light/Fill paths with the existing pinned Phosphor 2.1.1 Kit generator. F4 consumes this generated JSON in the fork. No dependency versions changed.

E8 extends the existing `MatrixWorkBridge` and Work request channel with `getSurfaceMode()`, `setSurfaceMode(projectId, mode)` and `onSurfaceModeChanged(listener)`. The snapshot is `{ projectId, mode: 'work' | 'code' } | null`. Use `window.atumMatrix.work` from the title-band switch. `registerMatrixWorkIpc` retains `requireUi`; WorkHost restricts operations to the live account/incarnation and invokes the fork's `window.atumSurfaceMode` adapter, which uses T3's settings command. The sidecar owner preload only reports mode changes; its sender must be the bound top-level Work origin. Malformed snapshots become null; teardown clears state. Mode writes reject unavailable/stale projects. No separate settings file or credential path was introduced.

The fork supplies the persisted project setting, hook, document attribute and command; the desktop band remains an Opus UI task. Existing Work bridge fixtures are updated to retain type coverage.

## Local verification

Dependencies were symlinked from the coordinator-approved shared dependency tree; no desktop install.

- Kit `node scripts/build.mjs --check`: exit 0.
- Kit `vitest run`: exit 0, 14 tests; Kit `tsc --noEmit`: exit 0.
- Desktop `vitest run electron/work/sidecar/host.test.ts electron/work/surface/surface.test.ts src/app/work/work-screen.test.tsx`: exit 0, 71 tests, including sender/account rejection for mode reports.
- Desktop `tsc -p tsconfig.electron.json --noEmit`: exit 0.
- Scoped desktop ESLint over changed TS/TSX files: exit 0 (five spacing warnings, no errors).
- Desktop renderer `tsc --noEmit`: exit 2 from missing shared dependency `@assistant-ui/react-streamdown` and derived prop-type errors. Mode bridge fixtures are fixed; no remaining mode errors.
- Broader focused run including `electron/matrix/main-work.test.ts`: exit 1, 91 pass / 1 failure in interrupted update recovery. Re-running that recovery test with main-work.ts restored to origin/main code reproduces the same failure; the implementation was restored afterwards. This is a baseline/environment limitation, not treated as passing evidence.
- Test temporary paths were placed under the assigned parent worktree for final verification.

The first public-guard pass rejected a machine-local path in this note; the path was removed before amending the local commit. Public guard is run on the final committed HEAD against origin/main; see the worker handoff for its observed exit code. Runtime version and pin remain unchanged.
