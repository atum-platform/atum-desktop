# Stock updater real-Mac acceptance

`accept.mjs` proves the bridge from the old updater into the stock adapter. It
never uses Atum's production bundle id, app name, user data, updater cache, or
`/Applications`. Each run creates a unique bundle id of the form
`com.atum.updater-test.<runid>`. The harness deliberately seeds only that
disposable identity with the legacy states below; it never reads or changes a
production ShipIt domain.

The harness creates a detached temporary worktree at `25ac50a91a6^` (the last custom-updater revision), links
the shared dependencies without installing anything, and builds N from that
revision's old updater. It removes that worktree in `finally`. N+1, N+2, and
N+3 are built from the current worktree's stock adapter under the same test
identity. N(old) explicitly restarts through `QuitTeardownCoordinator` and
`AtumUpdateRestart`; N+1→N+2 exercises the stock user Restart path through
`createMatrixQuitHandler`, `afterTeardown`, `quitAndInstall(false, true)`, and
the install watchdog. N+2→N+3 exercises ordinary Quit through the same real
quit handler plus stock `autoInstallOnAppQuit`. Since ordinary Quit does not
request relaunch, the harness waits for the N+2 process to exit and the bundle
plist to become N+3, then opens it and requires the N+3 launch receipt. The
local generic feed is served by `python3 -m http.server` on `127.0.0.1` and
moves only after the preceding version has met its acceptance gate.

Before N+1 starts its stock check, the harness seeds the old updater's root
`updates.json` fields (`channel: beta`, `lastVersion`, and `failureDays`), both
legacy downloaded/install marker files, and the exact observed post-abort
ShipIt residue: a full app under `update.cBjc8P9/`, a sparse 42 MiB
`ShipIt_stderr.log` ending in the abort/relaunch/quitting messages, an empty
stdout log, and no `ShipItState.plist`. Migration must preserve beta, retire the
markers and post-abort cache, clear the disposable attempt key, and N+2 must
install and launch. The local server log must show one exact
`GET /beta-mac.yml` for the hop; a duplicated manifest alone is not evidence.

Before N+2 starts its stock check, the harness resets settings to the legacy
shape, seeds `SQRLShipItInstallationAttempts=3` in the disposable per-host
defaults domain, and writes a stale valid ShipIt request plus staged app.
Migration must acquire the identity lock, prove the exact ShipIt job/process is
quiet, atomically quarantine the cache, prove the request did not change, clear
and read back the attempt key, and only then retire the stale cache. N+3 must
install and launch after another exact beta-manifest request. JSONL evidence
records every seed, the canonical settings (including marker/failureDays
retirement), the migration result before checking begins, and the following
launch. Every seeded case is required to have all three records.

The identity lock is also the stock check/download lease and remains held until
electron-updater's `downloadPromise` settles. Thus another user-data profile
with the same bundle id cannot stage a new request while migration owns the
native state.

After N+3 launches, both latest and beta manifests advertise a higher version
with a deliberately wrong SHA-512. N+3 must report `hash_mismatch`, remain
installed, and never reach downloaded/install state. JSONL assertions require
exactly one check, one download, one native-readiness event, and one raw install
handoff for each valid hop. These counts come from electron-updater's unfiltered
logger lines, native readiness events, and raw state transitions—not the action guard. The
wrong-hash case requires one raw check/download attempt, zero native readiness,
zero downloaded/restarting transitions, and one verified refusal. The harness
invokes no notary, publication, release, or other paid API.

## Why N remains a synthetic old-code bridge

The archived real v0.20.33 Matrix app cannot be safely rebadged for this proof.
Its bundled main process hard-codes `com.atum.matrix-candidate` as the ShipIt
job/cache owner independently of Info.plist and `app-update.yml`. Rewriting only
the bundle metadata would make the test app inspect or clean the production
ShipIt identity, which this harness must never do. Rewriting that constant
inside `app.asar` would invalidate the shipped asar-integrity/signature boundary
and the resulting N would no longer be the shipped code bytes. Therefore there
is intentionally no S3 download parameter: N is assembled from the exact old
updater modules at `25ac50a91a6^` under the unique test identity.

## Run

From `apps/desktop` in a clean, dependency-linked worktree:

```bash
export ATUM_UPDATER_TEST_SIGN_IDENTITY='Example Company (TEAMID)'
node scripts/updater-stock/accept.mjs
```

Pass the bare identity name shown after `Developer ID Application:`. For
convenience, the harness strips that prefix if it is included; electron-builder
receives only the bare name.

Optional controls:

```bash
export ATUM_UPDATER_TEST_FROM_VERSION=90.0.0
export ATUM_UPDATER_TEST_TO_VERSION=90.0.1
export ATUM_UPDATER_TEST_FINAL_VERSION=90.0.2
export ATUM_UPDATER_TEST_QUIT_VERSION=90.0.3
export ATUM_UPDATER_TEST_PORT=18765
export ATUM_UPDATER_TEST_KEEP=1
```

The coordinator supplies the real Developer ID identity and performs any
required notarization checks separately. The script deliberately does not
contact Apple's notary service. It parses the `df -k` header's `Available`
column, requires 10 GiB before starting, at least 7 GiB before each build, and
at least 6 GiB immediately before launching the old updater's disk preflight.

Success prints `UPDATER_STOCK_ACCEPTED N (old) -> N+1 -> N+2 -> N+3 (ordinary
quit); wrong hash refused`, followed by the exact disposable bundle id. On failure, the harness
terminates and, if necessary, kills only test-app processes whose command points
inside its work directory; the directory and JSONL evidence are retained. With
`ATUM_UPDATER_TEST_KEEP=1`, successful artifacts and evidence are retained too.

## Test-identity residue

Squirrel may leave `~/Library/Caches/<bundle-id>.ShipIt`, electron-updater may
leave the unique test product's `*-updater` cache, and macOS may retain a
matching launchd job/plist plus the per-host `SQRLShipItInstallationAttempts`
CFPreferences value.
The harness does not mutate those private stores after the proof. To retire one
printed **test identity only**, use:

```bash
BUNDLE_ID='com.atum.updater-test.<runid>'
RUN_ID='<runid>'
case "$BUNDLE_ID" in com.atum.updater-test.*) ;; *) echo 'refusing non-test identity' >&2; exit 1;; esac
case "$RUN_ID" in ''|*[!a-z0-9]*) echo 'refusing invalid run id' >&2; exit 1;; esac
[ "$BUNDLE_ID" = "com.atum.updater-test.${RUN_ID}" ] || { echo 'identity mismatch' >&2; exit 1; }
launchctl bootout "gui/$(id -u)/${BUNDLE_ID}.ShipIt" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/${BUNDLE_ID}.ShipIt.plist"
rm -rf "$HOME/Library/Caches/${BUNDLE_ID}.ShipIt"
rm -rf "$HOME/Library/Caches/atum-updater-test-${RUN_ID}-updater"
defaults -currentHost delete "${BUNDLE_ID}.ShipIt" SQRLShipItInstallationAttempts 2>/dev/null || true
```

Never substitute a production Atum bundle id into those commands.

The stock Restart hop now creates a real BrowserWindow with the product's hide-on-close
behaviour and two live detached children running the signed app executable. One ignores
SIGTERM/EOF. The same owned-child exit barrier and bounded Matrix quit handler must
retire both, then call stock `quitAndInstall(false, true)`. Evidence requires exactly
one Restart, both children alive at the click, a native ready event, a process exit,
and the next version's launch without `open` or a manual reopen. The harness rejects
any child PID still alive after the new version launches. The coordinator runs this
packaged proof; implementation workers must not run it.
