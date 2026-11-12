# Matrix durable intake and recovery

The Matrix adapter journals each sync response and opaque cursor atomically in
`intake-<account-hash>.sqlite3` in its profile-aware Matrix store directory. Back
up this file together with Hermes `state.db` and the mautrix crypto store. Keep
the same Matrix account and access-token session on restore: Matrix send
transaction deduplication is session-scoped. A profile is storage/configuration;
a sender identity is not a process or a grant of execution trust. Existing
owner, room and mention authorization remains authoritative. Audience/sender
trust routing and cross-host lifecycle fencing are separate work.

## Acceptance and delivery

Every message/reaction must have a positive durable native or filtered/control
receipt before its raw batch is cleared. Failed callbacks retain that batch.
Busy inputs keep independent native request IDs; they are not merged. Native
SessionAuthority owns queued and unknown execution; this journal never proves
external tool effects completed.

Final non-streamed text replies use Hermes DeliveryLedger (`gateway.delivery_ledger`
in config.yaml, enabled by default). Before publication its obligation stores
the exact formatted chunks, reply/thread relations and deterministic Matrix
transaction IDs. Recovery reuses that plan without adding a recovered marker.
This covers retry after server acceptance but lost acknowledgment, including an
accepted chunk prefix. Keep the ledger enabled for this guarantee. Streaming
edits, attachments, commands and unledgered notifications retain their existing
delivery contracts; this does not certify all Matrix publication as exactly once.

Encrypted payloads are parked independently so later sync/to-device key traffic
and unrelated rooms continue. The existing mautrix OlmMachine and crypto store
decrypt them; its room-key request API requests missing keys. Retries stop after
100 sync attempts or 24 hours, retain the payload, emit an owner-action error,
and expose room/event IDs in adapter diagnostics. Real device/key recovery
requires a homeserver certification before production use.

## Inspect and reconcile

Use the exact journal path from the Matrix store directory or gateway diagnostics:

```sh
hermes gateway matrix-intake status --store /path/to/intake-ACCOUNT.sqlite3
```

Status is read-only and does not dump message bodies. It reports pending intake,
frontiers, receipt states, parked encryption ages/attempts and the latest sync
error. Distinguish SQLite disk-full/corruption, missing history frontier, missing
keys, and ambiguous controls. Never delete the journal or reset the token to now:
that would invoke the first-install skip-history baseline.

For recovery, stop the gateway first and preserve a whole-home backup. Reconcile
an ambiguous control against its actual effects and the native execution/delivery
ledgers. Only after proving the control completed (or intentionally requires no
further action), acknowledge it:

```sh
hermes gateway matrix-intake resolve --store /path/to/intake-ACCOUNT.sqlite3 \
  --event '$EVENT' --reconciled 'verified effect completed in destination'
```

The command saves a mode-0600 SQLite backup before changing the receipt and
leaves cursor/frontier/pending payload unchanged. It does not replay effects.
For parked encryption, restore this device's keys in the existing crypto store,
then reset only that event's retry budget:

```sh
hermes gateway matrix-intake retry --store /path/to/intake-ACCOUNT.sqlite3 \
  --event '$EVENT' --reconciled 'device keys restored'
```

Restart the gateway; the next sync retries decryption and native admission.
Corrupt state requires a verified backup restore, including matching native and
crypto ledgers; the CLI refuses corrupt stores. Disk-full recovery needs free
space before restart. Failed receipt writes leave raw intake recoverable.

Completed transport receipts expire after seven days, only outside the pending
batch and parked encryption set. Unresolved/ambiguous records never expire.
SQLite reuses freed pages. History pagination is capped at 10,000 events or
16 MiB per room per attempt; exceeding it fails closed with the saved frontier
and cursor unchanged. Recover large gaps offline from retained history/backup;
explicitly reconcile any history unavailable on the server before resuming.
The pending/parked backlog necessarily uses disk until accepted/reconciled.

This is built-not-live. Cross-machine single-owner fencing, controller drain,
cutover/rollback manifests and delayed-old-host rehearsal remain F5 gates.

## Identity mount and process send namespace

For the provisioner layout, mount `agents/<agent>/identity/` at
`<HERMES_HOME>/platforms/matrix/store/`, as plan §3.8 specifies. Both `crypto.db`
and `intake-<account-hash>.sqlite3` resolve from `get_hermes_home()` and use this
same per-adapter pinned store. An existing mount takes precedence even if it is
empty and an old `<home>/matrix/store/` still contains data. Mount the restored
identity store before starting; do not start with an empty mount during recovery.
Without a canonical store directory, Hermes's profile-local legacy store remains
supported. Native execution and delivery ledgers remain private-home state.db.

New Matrix send plans include a random process namespace in each transaction ID.
It is generated once per process and persisted with the plan before sending.
Distinct audience processes using separate ledgers cannot collide even for an
identical obligation ID; a restarted process reuses the original stored IDs.
Existing plans remain unchanged. This prepares a publication seam; it does not
permit several sync consumers or implement the future sender-trust router.
