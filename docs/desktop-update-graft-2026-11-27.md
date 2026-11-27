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
and recovers forward.

The old packaged controller, AppUpdater subclass, stock-only fallback,
restart helper window/script, rail presentation and Matrix install-on-Quit
callbacks were removed. Settings and the independent legacy renderer still
use the existing compatibility status/copy. The full Work data and shell
commit transaction, authenticated prepare/commit FDs, planned thread
continuation, remote provider/server registry and owner-specific admission and
workspace receipts remain outstanding. Remote desktop updates stay disabled.
Those areas require their own real pairing and workspace tests before shipping.

## Local checks

Use the repository Node version. Run the desktop typecheck and the Electron
and renderer Vitest suites for the vendor updater, adapter, Work trial,
staged swap, and Matrix update surfaces. The fixture at
`apps/desktop/updates-graft-fixture.html` shows all eight states. From
`apps/desktop`, run `node updates-graft-render.mjs <empty-build-dir> <evidence-dir>`
with Chrome installed. The renderer sends no update requests to a real feed.

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
