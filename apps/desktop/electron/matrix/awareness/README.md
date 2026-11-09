# AW owner-reader ingestion (source only)

Consumes `atum.awareness/1`, platform #404 merge
`681aef96e916f8957b54881e3bef034fa1f3c9e9`. An exported native module, not an
enrolled/cloud reader process, knowledge service or enabled user feature.
No Electron composition, SDK, renderer, shared-contract or root-dependency edits.

## RT / KS composition request

RT integrates the native exports from `index.ts` in its allocated batch: a new
owner-reader adapter beside `electron/matrix/main-agent-content.ts`, composed by
`electron/matrix/main.ts`/`account.ts` and the existing SDK host. AW does not edit
those files. KS provides the actual local/managed service transport. The ports
do not invent HTTP routes.

### Local provider transport

`awarenessLocalTransport({ destination: 'local', brain, owner, current })` connects
the existing five AW ports to `MatrixLocalBrain`: info/prepare, ingest, withdraw,
fence and reportCoverage. `owner` captures the canonical native account key and
session generation; `current()` must return null until native admission and
control reconciliation are current. It must not be an unconditional account
lookup or a renderer-provided selector. Bind the reader metadata to that same
account/device/destination, and keep its `live()` and `readAccess()` authoritative.

This adapter never activates a provider, refreshes a credential, acquires SDK
visibility, claims contiguous history, or exposes generic RPC/recall/send. Calls
check exact current custody and native readiness before dispatch and after reply.
A pre-dispatch abort does no work. After-dispatch abort, failed RPC or stale reply
has an unknown outcome: retire the adapter and stop only its still-ready captured
provider. The reader retains operation/withdrawal custody. Explicit native
activation must await provider cleanup/replay; then construct a new adapter and
reopen the same metadata, never reset it. Late replies cannot revive the retired
adapter or stop a successor account. Native supervisor stop errors remain its
code-only operational responsibility; the adapter stays closed regardless.

Local `observeFence()` retains reader metadata but does not publish a managed
fence. RT's existing native Google-fence feed owns the actual local provider
notice; the transport's bounded `fence` port does not confer that authority.

1. One reader/store owner per canonical native account/device and destination.
   Bind `binding` to an opaque identity, never display name/email. Store under a
   private owner directory on encrypted storage; one process owns the live file.
   `create: true` is only initial provisioning. Restarts leave false: missing or
   corrupt metadata stops, never resets tombstones. Before replay, RT reconciles
   newer cross-device controls; a restored local file is not their authority.
2. `live()` means active, unexpired, unrevoked native admission **and** the initial/
   current policy, withdrawal and account-fence snapshot has been applied. Unknown
   or stale authority keeps it false. Renderer/model input confers no authority.
3. `readAccess(source)` uses actual membership/history visibility and keys; its
   synchronous `readable(revision)` proves this exact revision is owner-visible,
   not pre-join history. Rechecked after `transport.prepare(signal)` immediately
   before dispatch. Display DTOs, SDK sync tokens and max event timestamps are
   not proof. RT binds source/sender/revision/edit/redaction identity from the real
   SDK, Drive or acknowledged native-memory source; strips control events, hidden
   reasoning and private app instructions. Narrow credential screening is not DLP.
4. Register sources (temporary starts excluded). Apply owner inclusion, membership
   leave/revoke/rejoin, key/visibility changes and `io.atum.google_fence` before
   backlog. `keysChanged` invalidates prepared work, not permission epochs. W1
   moves epochs; concurrent-device policy authority is an RT/W4 integration gate.
5. `replayHint(source)` identifies an unknown receipt's source revision to reread
   before newer revisions. Submit authenticated contiguous batches, <=200
   revisions, `after` (null for a full scan, otherwise no later than the durable
   watermark), verified no-gap `through` and honest historical `complete`. Recent/
   active 30-day priority, older idle/targeted reads remain RT SDK scheduling.
6. Authenticated KS `restoreGap` rewinds durably before backfill; retains pending
   identities and suppression controls. A new verified scan must close the gap.
7. `reportCoverage` batches <=200 entries, sends none for no sources. UI uses KS's
   combined coverage/summary. No per-message model calls, charges or notifications.

## Receipts, controls and storage

`prepare` owns serialized refresh and returns no token. Each port has an
AbortSignal with a default 10s wait, configurable 1–60,000ms. Metadata writes are
serialized; another source can proceed after timeout. Timeout is **unknown**, not
proof an ingest failed: retain pending identity and reread/retry the same operation,
digest and observation. Late promises cannot mutate reader state after timeout.
RT/KS must honor real transport cancellation/admission.

| Result | Action |
| --- | --- |
| Matching accepted/duplicate/superseded | Persist receipt, clear pending; a verified gap-free scan may advance its time watermark |
| Named refused | Persist receipt, clear pending, partial coverage; reconcile actual policy/service state, never guess epochs or claim complete |
| Missing/mismatched/malformed/unknown receipt | No checkpoint; retain exact source reread hint and operation/digest/observation |
| Fenced/undecryptable/invalid/unparsed content | Honest gap/partial/paused/key coverage; no jump over an unacknowledged gap |
| Withdrawal recorded | Validate ID, suppression IDs, <=24h purge deadline; persist before true/success or later content |

Withdrawals are persisted before dispatch and replayed before content. Source
exclude/leave/revoke carry the current epoch; merely-left rejoin advances epoch,
but never clears deliberate exclusion. Object/fact/account forget/delete survives
edits, reinclusion and restart. KS owns payload purge. AW retains minimal controls
and suppression IDs forever, not TTL/FIFO deletion. Account deletion is terminal.

Metadata only: binding/destination, source epochs/inclusion/watermarks, pending
object/fingerprint/observation, receipts, withdrawal requests/suppression IDs and
earliest fence. No event/file/memory plaintext, attachment bytes, token/key or live
DB. Private 0600/0700 atomic temp-file fsync/rename/directory fsync. At 16MiB or a
write failure stop rather than discard controls. RT owns capacity and process
custody. Filesystem crash guarantees are not proven by a unit test.

## Google boundary

Managed output never carries a marked item; any present malformed mark also fails
closed before text validation. Fenced Drive versions pause. Unrelated unmarked
sources still flow with `accountFence: true`, even while a fence ack is unavailable.
Earliest `since` is sticky and notice retries until valid ack; no v1 reset.
Coverage is partial/paused, not complete. Separately bound `local` permits a valid
marked local envelope only on the granting Mac's local brain. Changing local
metadata to managed is refused; this is not cloud import. W4/KS withdrawal-first
filtered import and RT's learned-content/profile/pet upload/restore fence remain
separate. No Google credentials, content or activation/legal proof is used here.

## Verification / open acceptance

Real imports/private temporary files and deterministic owner-bound transport
doubles. Selected central schemas/vectors in `fixtures/contract-inputs.json` are
test-only preserved JSON values at the immutable merge: not another frozen pack,
deployed validation framework or brain schema. Tests validate exported wire seams.

From `apps/desktop`, run
`npx vitest run --project electron electron/matrix/awareness electron/matrix/local-brain.test.ts`.
For the real synthetic local composition, prepare the immutable package using
`scripts/stage-local-brain.mjs --prepare` with the producer Node/zlib versions in
`vendor/local-brain-source.json`, then run `node scripts/prove-awareness-local.mjs`.
The proof requires >=1 GiB free space; checks and stages the pinned archive;
bundles the actual reader/store/transport/supervisor imports; uses private
temporary account roots and real pinned GBrain/PGLite; withholds real receipts
to exercise unknown outcomes, exact replay and withdrawal persistence; and
checks account isolation and process departure before deleting its own fixtures.
Only source/admission fixtures are synthetic. This is not a real SDK scan,
authenticated history watermark, managed-reader proof or installed acceptance.

Open: DA enrollment/disclosure; encrypted owner SDK/key recovery; same-device MAS
rotation; no-send process/credential confinement; KS live ingestion/restore and
two-owner isolation; cross-device controls; W3 bounded recall/audience-separated
Hermes sessions; W4 content/import; W6 two-Mac/exact-artifact/cost/privacy/installed
acceptance. MAS's full human token is **not read-only**. This module has no token,
generic Matrix command, room send, lease, invocation, model or task port; that does
not prove a future host process cannot misuse its credentials.
