# Desktop Electron 45 (2026-11-16)

## Version and upstream path

Upgrade Electron **44.10.1 → 45.3.2** as a routine train bump. No advisory
against 44.10.1 motivated this change. On verification, `npm view electron
dist-tags --json` reported both `latest` and `45-x-y` as 45.3.2;
`npm view electron versions --json` contained no stable 45.3.3. The newest
published stable 45.x was selected instead of the intake's expected 45.3.3.

Sources reviewed:

- [Electron breaking changes, 45.0 section](https://github.com/electron/electron/blob/main/docs/breaking-changes.md#breaking-api-changes-450)
  (the heading no longer says “Planned”).
- [45.0.0 release notes](https://github.com/electron/electron/releases/tag/v45.0.0),
  including sandboxed preload changes and native EventEmitter compatibility.
- [45.3.0](https://github.com/electron/electron/releases/tag/v45.3.0): macOS quit,
  permission callback, redirect-loop and upload-stream fixes; Chromium .96.
- [45.3.1](https://github.com/electron/electron/releases/tag/v45.3.1): notification
  observer leak and revoked eMudhra intermediate distrust.
- [45.3.2](https://github.com/electron/electron/releases/tag/v45.3.2): DevTools
  interception crash, canvas font parsing and cookie persistence fixes; Chromium .100.
- [45.3.2 DEPS](https://github.com/electron/electron/blob/v45.3.2/DEPS).

45.0.0 shipped Chromium 156.0.8078.48, Node 24.22.0 and V8 15.6.
The selected 45.3.2 binary reports **Chromium 156.0.8078.100, Node 24.22.2,
V8 15.6.75.57-electron.0, Node module ABI 150, N-API 10**. The former
44.10.1 pin used Chromium 152.0.7977.169 and Node 24.22.1. Native modules
must use Electron's headers; host Node's ABI is not a substitute.

## Breaking-change checklist

Audited `apps/desktop/electron`, `apps/desktop/src`, `apps/desktop/scripts`,
and `packages` for the upstream APIs and their call sites.

| Upstream change | Applicability and action |
| --- | --- |
| Removed sandbox preload `events`, `timers`, `url`, `Buffer`, `setImmediate`, `clearImmediate` | Not used in preload execution. `electron/preload.ts:1` and Matrix preload entry points use Electron IPC and Web APIs. `saveImageBuffer` is an IPC method name, not the removed global. Main-process Buffer remains supported. No polyfill added. |
| Native EventEmitter for sandbox `ipcRenderer`, `webFrame`, `process` | Affects us: `electron/preload.ts:1` and Matrix preloads use instance listener methods. Those remain supported; no static events helpers, constructor identity tests or inheritance assumptions found. No fix required. |
| Node workers in subframes require frame Node integration | Not used: neither Node worker integration option is enabled. Also already backported to 44.3.0. |
| Extension subframes no longer receive ordinary window preloads | Not used: `electron/atum-pdf-view.ts:126` recognizes Chromium's PDF extension but does not inject a preload there. No application-installed DevTools extension preload dependency. Also backported to 44.3.0. |
| `chromeMediaSource: desktop` rejects WebContents IDs | Not used: no legacy media source constraints or `getMediaSourceId` callers. Also backported to 44.3.0. |
| Removed `contentTracing.enableHeapProfiling` | Not used. |
| `contentTracing` output changes to Perfetto protobuf | Not used. |
| Screen capture permission changes from `media` to `display-capture`; cross-origin iframe policy | Affects permission policy: `electron/main.ts:5676` and `electron/matrix/main.ts:11078` deliberately grant microphone-only capture. Isolated browser, PDF, app-panel and pet sessions deny all permissions. Screen capture is not an enabled feature, so no additional grant is appropriate. |
| `document.requestStorageAccessFor` disabled | Not used; no restoration flag added. |
| ASAR descriptors restricted to Node fs; writes/metadata mutations rejected; stat follows symlinks | No affected use: open descriptors concern writable user data, workspace files, recovery files and extracted binaries. Child stdio uses pipes/ignore, not descriptors for archive entries. Packaged native payloads are already unpacked. No reliance on ASAR symlink stat behavior found. |
| `window.open` sandbox mismatch isolates children and removes opener | No affected use: application windows are sandboxed, and native popup handlers deny or route explicitly. `electron/window-open-policy.ts:1` is deny-only; onboarding's fallback uses `noopener,noreferrer`. |
| Synchronous safeStorage methods deprecated, removed in 46 | **Affects us; unresolved migration risk.** `electron/encrypted-store.ts:13,95,134,159`, `electron/hardening.ts:26`, `electron/atum-messaging/credential-vault.ts:90,95,100,105`, `electron/atum-utilities/index.ts:412`, and direct calls in `electron/main.ts:6703,11863-11866` use synchronous storage. These remain supported in 45; the runtime emits a new availability deprecation warning. Converting the synchronous credential/storage contracts requires a separate async migration before 46. No shim, insecure fallback or warning suppression added. |
| Internal Electron bundles removed from builtinModules/getBuiltinModule | Not used. |

## Changes

- Update desktop and both Matrix builder pins, root install allowlist, updater
  acceptance/gate harnesses and both third-party catalogs. Update Chromium and
  FFmpeg provenance to the selected release's actual DEPS. Squirrel.Mac, Mantle
  and ReactiveObjC revisions and license texts are unchanged.
- Regenerate `package-lock.json` with npm, then use `npm update node-abi
  --package-lock-only --ignore-scripts --no-audit --no-fund`. Only Electron and
  node-abi package records changed; Matrix dependency versions are untouched.
- Refresh transitive **node-abi 4.31.0 → 4.40.0**: the former failed with
  “Could not detect abi for version 45.3.2 and runtime electron”. The new registry
  recognizes ABI 150. Existing @electron/rebuild 4.0.6, electron-builder 26.15.3
  and node-gyp 12.4.0 need no bump.
- `scripts/rebuild-native.mjs` supplies Electron Rebuild's `projectRootPath` so
  discovery reaches the npm workspace root across the manifest-free `apps/`
  directory. Previously a direct invocation silently rebuilt nothing. Native
  staging uses the existing scripts and official Electron headers.

- Refresh the `.npmrc` `min-release-age-exclude[]=electron` rationale: 45.3.2 is
  younger than the repository's 14-day minimum release age, and the newest 45.x old
  enough (45.2.1, 2026-10-31) predates the 44.10.1 security backports it would
  replace. The exclusion is dated for removal on 2026-11-27.

## Follow-up

- Migrate the synchronous `safeStorage` call sites listed above to the async API
  before adopting Electron 46, which removes the synchronous methods.
- Normal-keychain local startup timed out on the build host; the likely cause is the
  macOS Keychain access prompt for a newly built, differently signed binary. Confirm
  on a signed candidate before the next desktop release.

## Verification

Verification uses host Node 24.21.0 / npm 11.19.0 on macOS arm64. All commands
below run at repository root unless explicitly stated. No packaging, release,
CI, remote build or publication was performed. Disk was 6 GiB free immediately
before `npm ci`; the full Python `uv sync --locked --python 3.14 --group dev
--group test --extra all` environment was not installed because space fell below
3 GiB. A second clean baseline checkout was likewise omitted for disk capacity;
failures below are not classified as pre-existing or as regressions.

| Command | Result |
| --- | --- |
| `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | Pass; only selected dependency records changed. |
| `npm ci --no-audit --no-fund` | Pass; 1,405 packages. Electron's package downloads its binary on first use. |
| `npm update node-abi --package-lock-only --ignore-scripts --no-audit --no-fund` then `npm install --ignore-scripts --no-audit --no-fund` | Pass; one installed package changed after the ABI registry failure. |
| `node apps/desktop/scripts/check-client-boundary.mjs --typecheck-without-controller` | Pass; both TypeScript configs compile with zero private sources. |
| `npm run typecheck --workspace apps/desktop` | Pass; all four TypeScript targets. |
| `npm run lint --workspace apps/desktop` | Pass; 0 errors, 4,406 warnings. No broad lint cleanup included. |
| `npm run verify:cloud-data-v1 --workspace apps/desktop` | Pass; Node 11/11 fixtures, Python 11/11 fixtures, identical pinned digest. |
| `npm run check:test:upstream-watch --workspace apps/desktop` | Pass; 9 passed, 0 failed. |
| `npm exec --workspace apps/desktop -- vitest run --maxWorkers 4` | 24,552 passed, 18 failed, 48 skipped; files: 1,622 passed, 5 failed, 14 skipped (1,641 total). |
| `npm exec --workspace apps/desktop -- vitest run --project electron scripts/third-party-notices.test.mjs scripts/runtime-license-attribution.test.mjs scripts/rust-crate-notices.test.mjs scripts/stage-native-deps.test.mjs --maxWorkers 2` | Pass; 62/62 tests in 4/4 files. These also ran in the full suite. |
| `node apps/desktop/scripts/rebuild-native.mjs` | Pass after registry/root fixes; debug output confirms rebuilding node-pty and staging `darwin-arm64-150`. |
| `node apps/desktop/scripts/stage-native-deps.mjs` | Pass; node-pty, vibrancy and macOS helpers staged. |
| `npm run build --workspace apps/desktop` | Pass, including official-header native compilation and final asset assertions. |
| `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -p 'JSON.stringify(process.versions)'` | Pass; runtime versions above. |
| `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e "const pty=require('./apps/desktop/dist/node_modules/node-pty'); const p=pty.spawn('/bin/echo',['electron-45-native-ok'],{cols:80,rows:24});p.onData(s=>process.stdout.write(s));p.onExit(e=>process.exit(e.exitCode));"` | Pass; actual native PTY process exits 0 and prints `electron-45-native-ok`. |
| `npm run build:e2e --workspace apps/desktop` | Pass. |
| From `apps/desktop`: `npx playwright test --workers=1 --reporter=list` | Completed: 0 passed, 37 failed, 13 skipped, 12 did not run. The inherited `ELECTRON_RUN_AS_NODE=1` caused browser launch rejection of `--remote-debugging-port=0`; Python gateway cases also lack their environment. |
| From `apps/desktop`: `env -u ELECTRON_RUN_AS_NODE npx playwright test --workers=1 --reporter=list` | Supplementary run interrupted after repeated setup/launch timeouts: 0 passed, 6 failed, 1 interrupted, 55 did not run; exit 130. This does not establish an E2E pass. |
| `git diff --check` | Pass. |

### Vitest failures

- `electron/atum-messaging/shared-group-runner.test.ts`: 1/23 failed,
  `runtime_unavailable` while launching the Python runtime.
- `electron/matrix/mac-job-runner.test.ts`: 10/16 failed; missing project Python
  executable, followed by expected-delivery/settlement assertion failures.
- `electron/matrix/conversation/jobs.test.ts`: 4/4 failed; missing project Python,
  followed by live-lock/job-unavailable failures.
- `electron/matrix/mac-job-startup.test.ts`: 2/3 failed; project Python absent.
- `shared/setup-methods.test.ts`: 1/1 failed; system Python lacks `dotenv`.

The locked Python environment was not provisioned before this run. Some E2E
helpers subsequently created a minimal environment themselves, but dependencies
were still absent. The installed uv also reports that it cannot parse the
`exclude-newer-package = { certifi = false }` setting. None of these failures is
classified as pre-existing without a baseline run.

### E2E failure inventory

The completed run failed these cases (line numbers disambiguate tests in a file):

- `e2e/action-panel-context.spec.ts:50:1`
- `e2e/app-view-partition-isolation.spec.ts:104:1`
- `e2e/atum-shell-layout.spec.ts:18:1`
- `e2e/auth-recovery.spec.ts:8:3`
- `e2e/auth-recovery.spec.ts:8:3`
- `e2e/boot-failure.spec.ts:35:3`
- `e2e/boot.spec.ts:30:3`
- `e2e/chat.spec.ts:30:3`
- `e2e/composer-anchored.spec.ts:15:1`
- `e2e/correction-session-switch.spec.ts:135:3`
- `e2e/correction-session-switch.spec.ts:178:3`
- `e2e/hidden-history-messages.spec.ts:77:1`
- `e2e/hidden-history-messages.spec.ts:101:1`
- `e2e/interim-messages.spec.ts:145:3`
- `e2e/interim-messages.spec.ts:190:3`
- `e2e/large-session-resume.spec.ts:188:3`
- `e2e/large-session-resume.spec.ts:212:5`
- `e2e/large-session-resume.spec.ts:212:5`
- `e2e/mock-backend-setup.spec.ts:40:3`
- `e2e/onboarding.spec.ts:36:3`
- `e2e/panel-corners.spec.ts:5:1`
- `e2e/pdf-viewer.spec.ts:104:1`
- `e2e/queue-turn-boundary.spec.ts:80:3`
- `e2e/queue-turn-boundary.spec.ts:104:3`
- `e2e/session-compression-and-queue-stop.spec.ts:54:3`
- `e2e/session-compression-and-queue-stop.spec.ts:121:3`
- `e2e/settings-background.spec.ts:15:1`
- `e2e/shared-group-picker.spec.ts:4:1`
- `e2e/sidebar-states.spec.ts:100:3`
- `e2e/sidebar-states.spec.ts:164:3`
- `e2e/sidebar-states.spec.ts:238:3`
- `e2e/skills-launcher-recency.spec.ts:51:1`
- `e2e/submit-drift.spec.ts:28:1`
- `e2e/tile-unread-bug.spec.ts:128:3`
- `e2e/utility-first-use.spec.ts:10:1`
- `e2e/warm-resume-jitter.spec.ts:266:1`
- `e2e/worktree-branch-status.spec.ts:70:1`

The supplementary clean-environment run failed both action-panel-context cases,
app-view-partition-isolation, atum-shell-layout and both auth-recovery locales;
boot-failure was interrupted. It encountered repeated 90-second launch/setup
timeouts and missing Python dependencies. No passing baseline evidence is claimed.

### Main-process and renderer smoke

A temporary Playwright script launched the built app with an isolated home and
user-data directory, no inherited credentials, and protocol registration disabled.
It queried runtime versions, waited for DOM content, checked window visibility,
captured the rendered window, then closed the app and removed its temporary data.

- Ordinary keychain launch: timed out at both 60 and 120 seconds after inspector
  connection; emitted the new `safeStorage.isEncryptionAvailable` deprecation.
- Diagnostic launch with Chromium's **test-only** `--use-mock-keychain`: main
  process starts, window becomes visible, and the signed-out shell/error state
  renders. The backend exits because Python lacks `ruamel.yaml`; successful
  backend startup is not verified. No crash or renderer pageerror observed in
  this diagnostic run. The application quits cleanly. No product launch flag
  or keychain behavior was changed.

## Remaining acceptance work

- Provision the locked Python environment on a machine with adequate working
  space and compatible uv, then repeat the five failed Vitest suites and client
  E2E with `ELECTRON_RUN_AS_NODE` unset.
- Verify normal system-keychain startup and compare any remaining failures with
  44.10.1. Test-only mock-keychain rendering is not evidence for production
  credential behavior.
- Plan the async safeStorage migration before Electron 46; the 45 deprecation
  remains visible and intentionally unsuppressed.
- This change is built and committed locally, not released or approved to ship.
