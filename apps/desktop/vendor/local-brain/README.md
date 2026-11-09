# `@atum/local-brain`: the local brain package (G8-37·KS)

The managed brain for a desktop-only account: the pinned GBrain engine with its embedded
PGLite datastore, behind **one Atum-owned process per Mac account for all its agents**. It
speaks `atum.awareness/1` (atum-platform `spec/awareness/v1`, PR #404): the reader's
envelopes, the fence notice, withdrawals and corrections in; receipts and cited recall
out. Built by KS, supervised on the Mac by RT (G8-37·RT), shipped with the app by RL
(G8-37·RL). S3's local half (G8-40) is proven against it.

- **Pin:** GBrain `v0.59.20.0`, commit `a9c46ffb…`, release asset `gbrain-darwin-arm64`
  (SHA-256 `3d76f213…d1ae3`, 145,975,794 bytes), which embeds PGLite `0.4.3` as that tag
  pins it (`pin.json`). The binary is fetched into the git-ignored `.cache/` and
  verified byte for byte; it is never installed globally.
- **Runtime:** Node 20.19 or later (Electron 40's Node with `ELECTRON_RUN_AS_NODE=1` in
  the app). No npm dependencies.

## What RT's supervisor does (the contract)

1. **Start one service per account**, and only one:
   `node <pkg>/src/cli.mjs serve --root <account root> [--forbid-under <Drive sync root>]... [--binary-sha256 <hex>]`.
   - `--root` is a private, non-synced folder, for example
     `~/Library/Application Support/Atum/local-brain/<account>`. The service refuses a
     root inside iCloud Drive, `~/Library/CloudStorage`, Dropbox, Google Drive, OneDrive,
     any folder with an ownCloud/OpenCloud sync journal, or any `--forbid-under` path.
     **A live PGLite directory is never synced through Drive.**
   - A second start on the same root fails with `owner_lock_held`. GBrain's own lock on
     the datastore is a second, independent guard (a second opener is refused).
   - Every start checks the GBrain binary's SHA-256 against the pin (about 0.3 s). Once RL
     signs `bin/gbrain` for the app its bytes change, so the app passes the signed
     binary's SHA-256 from its release manifest instead: `--binary-sha256 <hex>`.
2. **Speak newline-delimited JSON-RPC 2.0 on the service's stdin/stdout.** Wait for the
   `brain.ready` notification (or `brain.failed`, then exit code 2). There is no socket and
   no port: only the process that started the service can reach it, so no agent's shell
   can connect to it or name its own audience.
3. **Close stdin to stop it.** It writes its replay watermark, stops GBrain and exits. It
   never outlives the app, and nothing is installed to run at login.
4. **Restart it if it exits.** It restarts its own GBrain child up to three times; after
   that it reports `error` and waits to be restarted.

### Methods

| Method | Params | Result |
|---|---|---|
| `brain.ingest` | `envelope.local` | `ingestion.receipt`: `accepted`, `duplicate`, `superseded`, or `refused` with a reason. Error `-32001` (unavailable) means retry; the reader keeps its checkpoint |
| `brain.fence` | `fence.notice` | `fence.ack`: `{ active: true, since }`, the account's sticky Google fence (the earliest `since` seen) |
| `brain.withdraw` | `withdrawal` | `withdrawal.receipt`, written and fsynced **before** it returns; recall stops at once |
| `brain.correct` | `correction` | `correction.receipt`: `{ correctionId, state: "recorded", evidenceId }` |
| `brain.retrieve` | `retrieval.request` (the audience bound by the controller) | Exactly a `retrieval.response` (`unavailable` with no items on any outage). A private Google-derived item has `provenance.google: true`; a shared or partner answer refuses it. |
| `brain.reportCoverage` | `coverage.report`: `{ entries: coverage.entry[] }` | The reader's own coverage (keys, catch-up, offline), merged into answers. |
| `brain.coverage` | – | `{ summary: coverage.summary, entries: coverage.entry[] }` |
| `brain.info` | – | Status, pins, counts, start timings, the fence, purge debt |
| `brain.backup` | `{ path }` (absolute) | A consistent archive (`atum.local-brain.backup/1`) with its SHA-256 |
| `brain.compact` | – | Rebuilds the datastore from live pages (see Withdrawal) |
| `brain.export` | – | The cloud import manifest (`atum.local-brain.import/1`) |
| `brain.shutdown` | – | Stops and exits |

The JavaScript client exposes `retrieve(request)` and a retained convenience alias,
`retrieveLocal(request)`. Both return the same frozen retrieval response, including
per-item Google provenance; the alias adds no wrapper or local-only fields.

Offline restore, with the service stopped: `node src/cli.mjs restore --root <root> --from <backup.tar.gz>`.

## How it keeps the contract

- **Receipts.** The deduplication key is `(source, object.id, object.revision)`; an edit
  or redaction belongs to the object it replaces. A retry, a lost acknowledgement or a
  second device is one ingestion. The order: a retry of the same operation, or the held
  revision itself, is `duplicate`; anything older than what is held is `superseded` (after
  a redaction, everything but the redaction is); a refused operation ID can't be reused
  for another object. Evidence IDs are derived from the source and the logical object, so
  every device, backup and import agrees on them, and a withdrawal can name a fact this
  Mac hasn't seen yet.
- **Audiences.** A room's audience (`shared_room`, `partner`) is fenced inside GBrain's
  own query: each room's pages carry a page type (`atum-r-<hash of the room ID>`) passed
  as GBrain's `types` filter, so the search only ever reads that room. Every hit is then
  checked again against Atum's ledger (room, withdrawal, redaction, exclusion, correction)
  and the whole response against the contract's invariants before it is sent. Content
  marked as Google-derived is never served to a shared audience; to the owner privately
  it is served with `provenance.google: true` on that exact evidence item, so the
  controller can taint the session without a non-contract wrapper.
- **Withdrawal.** The record is appended and fsynced, and the receipt returned; recall
  stops at once, because every served item is checked against it. The pages are then
  deleted and purged in GBrain (`delete_page`, then `purge_deleted_pages`), next in line.
  "Forget" and "delete" suppress for good (the object, and a watermark against backfill);
  account deletion is terminal (nothing is ingested again); excluding, leaving a room and
  revocation purge and stop ingestion until a newer policy epoch re-includes the source.
  A correction supersedes a fact but keeps the original traceable (§3.3); only a
  withdrawal removes text.
- **Bytes, not just rows.** GBrain keeps every write's full request, text included, in its
  journal for 30 days (`persistence_requests.intent`, a fixed threshold in this tag), and
  PGLite never vacuums, so withdrawn text stays in the datastore's files after the logical
  purge. **Compaction** rebuilds the datastore from live pages only, swaps it in and
  deletes the old one whole. It runs online: the copy runs beside recall, ingestion and
  withdrawals, and only the final step (what was accepted meanwhile, then the swap) holds
  the queue. It runs automatically when the oldest unpurged withdrawal, redaction or edit
  is 12 hours old (checked every ten minutes while the service runs), or on
  `brain.compact`. The tests prove the withdrawn bytes are gone from every file of the
  datastore afterwards. A backup still holds what it held; a restore never serves it
  (below), and the next compaction removes it again. A crash mid-swap is rolled back at
  the next start.
- **Restore.** A backup holds the datastore, GBrain's configuration and the ledger. A
  restore keeps the newer live ledger (the backup's must be a prefix of it). Before
  anything is served, the replay gate applies every withdrawal and redaction recorded
  after the backup's watermark, and finds pages ingested after the backup, whose sources
  then report `catching_up` (`backfill_pending`) and whose receipts are forgotten so the
  reader's re-send is accepted.
- **Outage.** Any failure of the engine answers `unavailable` with no items, never an
  empty success; ingestion answers `-32001` so the reader retries.
- **A lost ledger stops the brain.** A provisioned brain whose ledger is missing refuses to
  start (`ledger_missing`) instead of forgetting its withdrawals and the fence; restore it.
- **GBrain runs contained:** on macOS under a Seatbelt profile with no IP networking and no
  DNS (`brain.info` reports `sandboxed`); its own `HOME`, `GBRAIN_HOME` and `TMPDIR` under
  the root; an environment built from scratch (no provider keys, proxies or `GBRAIN_*`
  overrides from the app); no update check or self-upgrade; no maintenance sweeps; no
  search cache; no eval capture; skills not published.

## The package

`node scripts/build-tarball.mjs` builds `dist/local-brain-<version>-darwin-arm64.tar.gz` and
its `.sha256`: `src/`, the vendored contract, `pin.json`, the licences, a `MANIFEST.json` of
every file's SHA-256, and the verified GBrain binary as `bin/gbrain`. The archive is
deterministic (sorted, owned by 0:0, one fixed time, normalised gzip header): the same
inputs on the same Node release give the same bytes. atum-app pins it by SHA-256 and RL
ships it under `Contents/Resources/local-brain/`; RL signs `bin/gbrain` with the app's
Developer ID (it is ad-hoc signed upstream). The datastore is never in the package.

## Tests

`pnpm --filter @atum/local-brain test` runs everything; the tests that need the pinned
binary skip locally until `node scripts/fetch-gbrain.mjs` has fetched it. The ready/dispatch
CI lane fetches and verifies the pinned Linux binary before its complete suite, with
`LOCAL_BRAIN_REQUIRE_BINARY=1` so the real integration proof cannot skip.
`pnpm --filter @atum/local-brain test:integration` runs only those, and fails instead of
skipping when the binary is missing.

## Known limits (S3)

- **Refused operation IDs.** Accepted receipts are durable. Refused operation IDs
  are remembered only for the owning process's lifetime, so a trusted reader must
  not reuse a refused ID for another object across a restart.
- **Write throughput.** GBrain's durable write path takes about 0.3 s a page on this
  Mac, so one page per message backfills about three messages a second, and compaction
  re-writes every live page at the same rate. See the session log and the S3 findings.
- **Keyword retrieval only.** No embedding provider is configured, so recall matches
  words (with GBrain's relaxed fallback), not meaning; a question in one language won't
  find an answer in the other. The managed semantic default needs an embedding route
  through Atum's gateway (not in this slice).
- **GBrain's journal cap.** Each write consumes a permanent request ID; the default cap
  (100,000 per writer) is raised at provisioning, and compaction starts a fresh journal.
- **Memory grows with the brain.** Atum's state (metadata only, no text) is held in the
  service's memory: about 2 KiB a message as measured (42 to 46 MiB across 2,000), so a
  brain of 100,000 messages would need on the order of 200 MiB. The managed service keeps
  it in Postgres (G8-16).
- **A synced folder inside the root** isn't looked for: the root is the app's own folder
  under `~/Library/Application Support`, and scanning the datastore's files on every start
  costs more than that unlikely case.
- **The Seatbelt profile is macOS's.** Elsewhere (the cloud half) the engine's network is
  closed by the host: a container without egress.
- **Licences.** `licenses/` holds GBrain's (MIT) and PGLite's (Apache-2.0). The compiled
  binary also contains GBrain's dependency tree and PostgreSQL; their notices are G6-12's.
