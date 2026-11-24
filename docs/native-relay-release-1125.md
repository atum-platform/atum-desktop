# Native relay release assembly — 2026-11-25

Local-only integration for the coordinator. Base: origin/main. Native bridge
origin/feat/native-t3-bridge-desktop-1124 was fetched at 59ec3a4463 (includes
the requested a7a097bb23 plus its main merge); merged without conflicts.
Kit foundation and Work runtime 0.1.16 follow in this branch. Existing native
connector, runtime manifest, and local build scripts remain the integration
seams; no parallel relay implementation is added. No push, CI, release or deploy.

Kit 783600a72f merge: combined native assertion and Kit attention IPC handler
expectations in host.test.ts, and retained Kit railBadges in app.tsx.

Resolved an additional semantic merge collision: both branches declared the
same railDestination expression. Retained one declaration with Kit's
MatrixNavScreen type so navigation/history/badges share the same value.

Runtime manifest now pins Work 0.1.16, fork
`36afc222bf2d578198ca287e287276e7532c0ee2`, archive SHA256
`9676430dc8e500a52d5e93beb2cdb3aed468834c6da35f159c3ef993a3f4e58b`.
Local archive input: `release-build-inputs/work-0.1.16/atum-work-0.1.16-darwin-arm64.tar.gz`.
Real stageWorkRuntime verifies the archive digest/arm64 payload and derives
pin.json version 0.1.16, server SHA256
`65ce488ca493842ef23d871bf22bc12e31a0f2b81f95bed877541b43fd341698`.

| Local check | Exit | Evidence |
| --- | ---: | --- |
| Filtered npm ci | 0 | Node 24.21.0, shared default npm cache, no install scripts |
| Desktop full typecheck | 0 | renderer, browser consumer, Electron, e2e, client boundary |
| Focused Work/Connect/design unit tests | 0 | 1443 passed, 10 opt-in skipped |
| Kit integration + matrix/work tests | 0 | 1350 passed |
| Kit check + typecheck | 0 | generated output/sync, typecheck, 19 tests |
| Kit lint | 0 | package eslint config |
| Desktop touched-file lint | 0 | 110 warnings, zero errors |
| Broader focused desktop lint | 0 | 123 warnings, zero errors |
| Work theme check | 0 | Kit palette matches committed runtime theme |
| Runtime staging | 0 | real unpack, digest and arm64 checks, derived pin |
| Desktop npm run build | 0 | Vite renderer, Electron bundles, native modules, assert-dist-built |
| Public guard against origin/main | 0 | direct unpiped invocation; rerun after final commit |
| git diff --check | 0 | whitespace |

Initial Node 23 dependency install exited 1 (engine requirement); Node 24 passed.
Initial lint invocation from root exited 2 (wrong config cwd); including Kit
through desktop config exited 2 (outside base path); own package configs pass.
First typecheck exited 2 and lint exited 1 on duplicate railDestination; fixed.
Native compilation uses local node-gyp, without xcodebuild/DerivedData,
Developer ID, notarization, installed app changes or production access. This
build produces runnable app files, not a signed/notarized distribution bundle.
All task-owned dependencies, temporary staging/toolchain and build outputs are
removed after validation. The Work archive/checksum remain for the coordinator.
Full-monorepo commit hooks are bypassed for local assembly commits; the explicit
focused checks above ran directly. State remains built-not-live. Coordinator
owns cross-family review, pushing, CI, release and installed acceptance.

The first final-head public guard rejected the local username in the archive
path in this note (exit 1). Removed the host-specific prefix from durable docs
and amended only local, unpublished assembly checkpoints; final guard rerun.
