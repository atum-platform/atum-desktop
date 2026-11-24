# First-launch roster and Mac transport gate (2026-11-24)

State: implemented locally, not released. Owner request: after an update, keep
provisional assistant metadata behind the existing launch screen; a healthy cloud
assistant must not be described as missing local setup. Also stop the unused
legacy hub repair loop for S2-only accounts and make the cloud primary clickable.

## Existing paths and causes

- `electron/matrix/main.ts` (`setUpAssistant`) previously skipped roster discovery
  when no domain app scope existed. `isCloudOnlyAgent` could then read an empty
  cloud set as local. The authenticated roster's `runtime: hermes` is authoritative.
- `src/matrix/startup-screen.tsx` (`matrixStartupBlocking`) released an unknown
  roster after the 20-second assistant wait and released failed reads immediately.
- `src/matrix/app.tsx` (`openAssistant`) defaulted to the local enrollment's
  `snapshot.assistant.userId`. A rostered cloud primary without custody therefore
  returned before selecting its existing room. The existing roster grouping and
  Matrix membership/room-type checks already resolve that room; reuse them.

Paths above are relative to `apps/desktop/`. This change reuses the authenticated
roster recovery, launch, readiness retries and native Matrix conversation resolver.
No new screen, agent tool or transport is introduced.

## Behavior

Setup establishes/reads the domain grant first, then reads authenticated placement
before enrolling any executor. Placement is scoped to account and grant generation;
unknown never authorizes enrollment, even through alternate enrollment entry points.
A failed discovery remains pending, with no setup-failed banner. Named agents have
the same placement guard. The existing launch stays visible until the roster has
reconciled; failed reads use its existing platform-unavailable retry state. Retry
explicitly requests another roster read even if the unused physical root is idle.
Known assistants retain the existing bounded launch wait for optional local setup.
Header and setup notices wait for roster convergence. Selecting the primary uses
the roster identity and existing room, without manufacturing local credentials.

## Device-hub inventory and decision

These source references describe desktop paths under `apps/desktop/` and the
separate app repository's `packages/cloud-controller/` paths. The app repository
was read only for this inventory and is unchanged.

| Operation | Desktop consumer | App/controller producer | S2 decision |
| --- | --- | --- | --- |
| Touch ID command approval | `electron/matrix/device/service.ts:1577`, `:1609`; approval key and signer stay local | `src/device/device-hub.ts:1037` signs Execute under a turn grant | Retain legacy flow. No S2 executor binding sends these commands. Local approval and browser-import keys remain available. |
| GUI/computer use | `electron/matrix/device/service.ts:353`, `:720` admits computer_use and respects approval pause | `src/device/device-hub.ts:195`, `:1037` | Retain legacy GUI semantics; native SSH/Work route is independent. Do not claim SSH reproduces per-command hub approvals. |
| File grants and workspace handoff | `electron/matrix/device/service.ts:179`, `:1035` intersects local scopes and requires live file grant | `src/device/device-hub.ts:995`, `:1013` finalizes only bound turn workspaces | Retain for legacy agents. No functioning S2 hub binding exists to lose. |
| Keep awake | `electron/matrix/main.ts`, `scheduleContinuousListening`, cloud_device reason | Hub grant/heartbeat in `src/device/device-hub.ts:890`, `:944` | Keep existing owner Mac keep-awake behavior for native access; do not tie it to hub authentication. |
| Status/reconnect repair | `electron/matrix/device/connection.ts`, start/dial; `device/service.ts:1147` receipts; main snapshot deviceAccessRepair | `src/device/device-hub.ts:386` lookup, `:415` owner refresh, `:1032` execution | Only authenticated legacy accounts dial/show repair. Unknown waits. Mixed accounts retain it. |
| Native SSH and Work | `electron/matrix/device/native-ssh.ts:371` shell-only keys; main NativeMacSsh construction and Work integration | Native SSH is separate from controller hub | Keep Mac registration, Secure Enclave keys, native SSH, Work and local service startup. Gate only hub sockets/repair. |

The inspected app revision's `findDevice`/`refreshOwners` derives every owner from
legacy executor bindings. A device belonging only to S2 agents cannot authenticate
there. Desktop now consults the authenticated roster: active `runtime: hermes`
agents do not require the controller hub. Any active legacy agent retains it.
This conservative mixed-account rule preserves all legacy consumers above.

No currently functioning S2 operation was found that requires this controller
socket. This is not a claim of semantic parity for hub GUI/file approvals over
SSH. If those capabilities are reintroduced for S2, a separate app follow-up must
replace binding-keyed discovery with authenticated owner-keyed registry lookup,
retain freshness/revocation and signature checks, and explicitly provide turn
admission and file/GUI authority for S2; owner lookup alone does not create a
replacement command path. Never relax authentication to silence the repair loop.

## Verification and handoff

Focused Vitest covers actual main setup ordering with delayed/failed roster I/O,
launch timeout and retry behavior, setup/header suppression, cloud primary chat
selection without custody, S2 registration without hub dialing, legacy/mixed
accounts, and connection/assistant-room invariants. Run Electron TypeScript,
ESLint and public_guard on the committed head. The implementation worker does not
push, create PRs, run CI, deploy, use credentials or change installed app data.
The coordinator owns release/installed acceptance and any separate hub follow-up.

Local verification results: focused Electron suites 143/143 passed (exit 0);
startup-screen and roster-conversations UI suites 134/134 passed (exit 0);
actual app delayed-roster and cloud-primary tests 2/2 passed (exit 0).
Electron and renderer TypeScript checks passed (exit 0). Scoped ESLint passed
(exit 0; existing and formatting warnings remain, no errors). React checklist:
no new hooks, subscriptions, dependencies or state; loading uses the existing
launch and retry controls. Public guard is run against the committed head next.
