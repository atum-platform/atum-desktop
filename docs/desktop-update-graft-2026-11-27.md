# Atum desktop updater graft, 27 November 2026

The owner chose automatic download. The graft checks 15 seconds after
initialization and every four hours. The main adapter starts the service's
serialized download action when a release is offered. The stock Mac download
returns only after Atum has prepared and verified the ZIP. The ordinary Quit
handler has no install action. The user authorizes the expected version through
Restart or Update Everything. The latter waits five seconds and can be postponed.

The packaged Matrix path uses the vendored T3 update service, reducer, notes
parser, polling intervals, and status glyphs. The desktop uses Atum's own
confirmation and sidebar primitives and binds the eight wire states to the
trusted Matrix renderer. Update Everything currently counts the bundled Mac
app once. It has no remote machine or provider targets until the paired Work
transport is qualified.

The adapter retains the generic latest/beta feed, maps beta to the internal
nightly slot, and disallows an older shell install. It reads the current
channel from signed app metadata when present. A promoted bundle without a
channel uses the saved preference as its current channel. The npm build
verifies both Electron updater patch hunks against the pinned blob hashes
before bundling. The stage still owns bundle verification, signed replacement,
journal and recovery. The retired stock harness remains a historical gate and
loads its controller from the pre-graft Git object.

Restart checks the target's staged seal, active account, local busy state,
and any in-flight browser download. A missing or changed stage is rebuilt
through the normal download action and requires a fresh Restart.
A refused document checkpoint leaves the current app open. The swap requires
the Matrix drain, SDK, Work, device, lease and browser shutdown to settle. A
failed shutdown keeps the installed app and relaunches it with its usual owner
startup. The handoff restores window bounds once and uses the existing
account-scoped navigation behavior. Stage health confirmation now follows
Matrix startup. Work selection is persisted before protocol-4 acknowledgement.
When acknowledgement fails after durable selection, Work preserves the new pin
and recovers forward. The installed Work 0.1.19 binary emitted `serverReady` over
an inherited control descriptor in desktop mode. That mode omits the startup
pairing message required by the current Atum supervisor. The packaged sidecar
integration fixture reads the actual Work pin from the bundle before running the
trial so a historical fixture version cannot reject the current binary.

The old packaged controller, AppUpdater subclass, stock-only fallback,
restart helper window/script, rail presentation and Matrix install-on-Quit
callbacks were removed. Settings and the independent legacy renderer still
use the existing compatibility status/copy. The Python supervisor adapts the pinned Work desktop bootstrap instead of
changing its binary or the vendored T3 files. Electron derives the native
rotating pairing credential and exposes it once through the existing owner
view flow, after matching the server-ready frame and loopback PID. The inherited
control sockets carry maintain-scoped prepare and commit requests. Tokens expire
after five minutes and bind the running Work incarnation, the selected channel,
and the exact staged Atum release. The Work view exposes neither a desktop
bridge nor the shell update capability. Its scoped embed style suppresses the
pinned Work Update Everything control, including provider-only runs, and keeps
the dedicated provider pill. Authorized native handoffs call the same signed
Atum updater as the rail. They never download a standalone Work runtime.

Restart records the previously live Work account and its target pin in the shell
journal. A changed pin uses the journal ID for T3's native trial and writes the
pin under the shell recovery lock before acknowledging activation. The same
record resolves both rollback paths. If a crash precedes selection, the previous
signed bundle restores the existing Work snapshot. After selection, recovery
relaunches the new shell and never rewinds Work data. A first launch with no
previously live Work skips prewarm. Native T3 continuation honors stored project
and account preferences. Historical false values are preserved because the
previous host's forced value cannot be distinguished from an owner opt-out.

The existing Matrix room and composer stores restore the selected room and draft.
The update checkpoint also saves safe browser GET destinations, order, selection
and visibility for the same account, device and room. Fresh tabs get new isolated
partitions. Active downloads, unsafe URLs, modified or unverifiable browser
forms, an open Matrix terminal, and a controlling terminal under the Work
server defer the restart. Matrix and Hermes retain
their existing execution and delivery receipts. The Mac job lifecycle stops its
local claims before draining, and the existing outbox owns reconciliation. Work
UI actions target the Atum release only. No cloud update or replay is issued.

A dormant Work home keeps the previous signed reader if its committed pin
differs from the running bundle. The stage refuses to evict that reader to make
room for a subsequent update. The remaining release evidence is a second signed
Work pin, crash testing across the actual bundle swap, native Work PTY admission,
and cloud-to-Mac delivery replay coverage. The bundled Work capability is hidden from discovery to keep its settings
and rail controls out of the embed. A paired maintain client can still use the
native two-call handoff.

## Local checks

Use the repository Node version. Run the desktop typecheck and the Electron
and renderer Vitest suites for the vendor updater, adapter, Work trial,
staged swap, and Matrix update surfaces. The fixture at
`apps/desktop/updates-graft-fixture.html` shows all eight states. From
`apps/desktop`, run `node updates-graft-render.mjs <empty-build-dir> <evidence-dir>`
with Chrome installed. The renderer sends no update requests to a real feed.
The two rail images use the real footer, account button and shell frame. The
fixture checks that every update action fits within the rail above the avatar
with the sidebar expanded and collapsed. The stopped-Work test exercises shell
admission with no bound account.

For a real Electron transfer using unsigned fixture bytes, run
`node apps/desktop/scripts/updates-local-feed.mjs <Electron-executable>`.
It uses a disposable loopback feed and verifies both channel filenames, the
stage input, repeated renderer IPC reads and ordinary Quit. Its stage callback validates the
fixture bytes without invoking codesign, replacement, or installer processes.

## Signed qualification

On an isolated Apple Silicon Mac with three signed, notarized release bundles
and disposable account state, run the input harness:

```sh
node apps/desktop/scripts/updates-qualify.mjs LEGACY.app BRIDGE.app NEXT.app
```

The harness checks bundle identity, architecture, version ordering, signature,
matching Apple signing teams, and Gatekeeper assessment. It does not modify or launch the apps. Run the
following scenarios against disposable latest and beta feeds with matching
signed ZIPs and checksums. Do not publish the test feed to production.

1. Start Legacy and install Bridge through Legacy's updater. Repeat Bridge to
   Next in each track. Observe a startup check, automatic staging, ordinary
   Quit with no swap in Bridge, and the versioned explicit Restart. Postpone
   Update Everything and let a second confirmed countdown complete.
2. Corrupt the ZIP and substitute a wrong-team candidate in separate runs.
   Confirm both errors leave the old app and its stores intact. Disconnect
   the network after the stage is ready and confirm Restart still works.
3. Kill the isolated old process at each physical stage journal boundary.
   Repeat during Work trial prepare, durable selection and activation.
   Verify the installed shell and Work pin agree after startup. Before
   durable selection require snapshot recovery, and after selection require
   forward recovery with no duplicate effects or rewound messages.
4. Exercise inactive Work, dormant homes, busy Work threads, an active local
   Matrix turn, an undelivered job receipt, a Mac-delegated cloud action, an
   unsaved form and a non-detachable PTY. Record the owner outcome and confirm
   the cloud-only turn continues.
5. Record separate background preparation and restart-to-interactive timings.
   Compare p50 and p95 against the r1 baseline on the same Mac. Confirm only a
   single verified rollback generation remains during unresolved recovery.
