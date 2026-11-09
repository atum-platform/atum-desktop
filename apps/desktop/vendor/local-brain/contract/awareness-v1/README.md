# Public conversation-awareness contract projection

This directory contains client-facing contract data. Internal planning, review and release-authority records are not part of this public projection.

## 1. The product decision

Atum's assistant is privately aware of the conversations its owner can read, and people
never set that up. Concretely, for the launch:

1. **On by default.** A new account's assistant privately remembers and searches the
   owner's assistant chats, human DMs and groups, owner-visible app exchanges, Atum Drive
   files, and each agent's curated memory. There is one account control and, per
   conversation, **Keep out of assistant memory**. A temporary conversation starts excluded.
   Exclusions and pauses a person already chose stay in force.
2. **Awareness, speaking and acting are three separate powers.** Reading a group never lets
   the assistant post there, invite itself, or act for the owner. A received message, a
   recalled instruction or an inferred promise authorizes no send, spend or change.
3. **Answers are separated by audience** (§2.2). A private answer may use everything the owner
   can read and has included; an answer that other people will see uses only what that
   audience can already see.
4. **Answers cite their sources**, and "correct that" or "forget this" work in ordinary
   language. A forgotten fact is not recalled again, after restarts, backfill, restore or a
   stale device reconnecting.
5. **Coverage is honest.** A missing match is never proof that nothing was said: the
   assistant says when it hasn't caught up, lacks keys, or is paused, and why.
6. **Initiative without noise.** One private recap a day, at 08:00 in the owner's time zone,
   only when useful; quiet hours; no notice per message; private drafts stay private until
   the owner sends them.
7. **The brain is managed.** GBrain runs as a local PGLite brain on a desktop-only account
   and as a dedicated per-account service for a cloud account. No `gbrain init`, keys,
   repositories or schedules appear to the person. Background indexing runs on an included
   service budget and never debits the person's balance.
8. **While every device is off**, the owner's cloud companion (an Atum device of the owner,
   disclosed at cloud enrollment; `atum.cloud-execution/1`, kind `owner_reader`) keeps
   reading, so the cloud assistant stays current.
9. **What is said about privacy:** Matrix transport stays end-to-end encrypted, but the
   devices and services that read for the owner see plaintext, and the managed brain is
   server-readable with its own encryption at rest, access, backup and retention. It is never
   marketed as an operator-blind encrypted archive. The notice and the privacy text are
   G6-04·LG's.

This supersedes the older defaults that limited awareness to explicit invocations or made
each conversation a separate opt-in (the awareness plan §1). There are no legacy customers to
migrate (the Matrix fresh-foundation ruling).

### 2.1 Sources

| `source.kind` | What it is | Default | Read under | Excluded by |
|---|---|---|---|---|
| `assistant_chat` | The owner's rooms with their own agents | Included | The owner's read entitlement and keys | Keep out of memory; a temporary conversation |
| `human_dm` | The owner's DMs with people | Included | The same; never history before the owner joined | Keep out of memory |
| `human_group` | Groups the owner is in | Included, from the owner's join, by the room's history visibility | The same | Keep out of memory; leaving the room |
| `app_exchange` | App conversation text and artifacts actually delivered to the owner | Included, within the app's data contract | The same | Disconnecting the app |
| `drive_file` | Atum Drive files, and content the owner attached or enrolled | Included | The owner's Drive identity | A folder exclusion |
| `native_memory` | An agent's curated `MEMORY`/`USER` entries, indexed per acknowledged revision | Included | The agent's revisioned content | The per-agent pause |
| `owner_statement` | "Remember this", corrections and withdrawals the owner states | Recorded | The owner | Forget |

Never sources: another account's data; a partner app's database, prompts or other customers;
events the owner can't decrypt; history before the owner joined; microphone, screen or disk
capture; purchased skill internals; a connected Google account's content while the fence
holds (§4). Connected email and calendar are read live by tools on the device that holds the
grant; they are not ingestion sources in v1.

The per-agent private-memory toggle controls only the revisioned `MEMORY`/`USER`
snapshot's sync and retrieval. An active assistant's definition/persona/model and
selected skills still materialize when private memory is off; this is not a
profile-deletion toggle. A Google-protected workspace is stricter: definition,
skill, memory and pet-content exports remain local-only irrespective of that
toggle. Reuse the existing content materialization and fence, not another
profile-sync service (AW-7).

### 2.2 Audiences

The controller binds the audience from the authenticated request and its destination
**before** anything is fetched. The model never supplies the owner, the audience, a room or a
scope, and nothing it supplies confers access.

| `audience.class` | When | Evidence it may use |
|---|---|---|
| `private_owner` | The owner asks their assistant privately, on any surface | Every included source the owner can read |
| `background_private` | Recaps, briefs and suggestions delivered only to the owner | The same; it has no path to publish |
| `shared_room` | A reply other people in a room will read | Only evidence **scoped to that room** and visible to its current intended audience, plus material the owner explicitly shared into it |
| `partner` | A reply in an app's thread | The partner's thread and material deliberately handed to it |

Rules:
1. The filter applies before retrieval, ranking, synthesis and graph expansion, and to
   metadata, titles, snippets, citations, entity names and counts too.
2. A summary drawn from several sources may be used only where **every** one of its sources
   may be; a private input never becomes a shareable fact.
3. Leaving a room stops new ingestion and recall for it; rejoining resumes it, but never
   clears a deliberate exclusion or withdrawal (the `source_inclusion` machine).
4. Membership, visibility and exclusions are checked again before publishing. If the
   audience changes while an answer is generated, the answer is rebuilt or not published;
   the owner can still receive it privately. A late joiner gets nothing from before their
   join.
5. Shared answers run in their own Hermes session, without the personal session's memory
   snapshot, compression summary, scratch files or tool results, in an isolated sandbox with
   only the approved files and mediated tools (the awareness plan §3).
   They also receive no personal-brain credential or home-directory mount. A
   room/partner session gets only evidence and material explicitly admitted for
   that audience. W3 must test a cross-room private canary, scratch/session-state
   isolation and mid-generation membership changes; an unavailable service is
   never an empty successful recall (AW-5).
6. **Marked evidence never reaches another person.** An item marked as Google-derived
   (`provenance.google`, §3.4) is withheld from `shared_room` and `partner` answers before
   anything else is decided, which fails closed; a private answer may use it, marked. The
   schema refuses a shared answer that carries one (`retrieval-shared-room-google-derived`).
   This is the conservative contract boundary, not a finding that all Google use
   is compliant. Private use remains subject to §4's custody and §4.1's release
   checks; no model argument, generic consent or approvals-off setting relaxes it.

## 3. Wire shapes

All shapes are in `contract.json`, with worked examples in `fixtures/`.

### Reader execution and credential boundary (AW-1, AW-2)

The owner reader is an account-isolated Matrix device, not an agent/task runtime.
MAS issues it a full human Matrix personal session; that token is **not read-only**.
No-send is enforced by the reader's command/process boundary and by DA's refusal
of answering leases, invocations and occurrences for `owner_reader`. W1 exposes
only sync/decryption and required device-verification/key-recovery traffic, not
room-event/message send, generic Matrix commands, model brokers, task sandboxes
or publish commands. Required tests exercise each denied command and an allowed
verification/recovery exchange; schema checks alone cannot prove confinement.

Use cloud execution §4.3's same `ATUM_COMPANION_<executorId>` device/session,
serialized rotation and token lifetime of at most 3,600 seconds. Tokens and
device crypto/recovery material stay encrypted in that owner's reader credential
compartment, never in knowledge envelopes, Hermes context, tools, renderers or
logs. Failed rotation stops work before expiry, reports an offline coverage gap
and retains its checkpoint; an unknown create is reconciled through the existing
begin/finish fences, not blindly repeated. This is a future W1/DA runtime
obligation, not a deployed reader or a new OIDC refresh mechanism.

### 3.1 The source envelope (W1 → W2)

The owner's reader turns each readable event, edit, redaction, file version or memory
revision into an envelope. **The owner is not a field**: the knowledge service takes it from
the reader's authenticated, per-account channel, and refuses an envelope that names one.

- `operationId` makes the write idempotent. The **deduplication key** is
  `(source.kind, source.id, object.id, object.revision)`: a retry, a lost acknowledgement or a
  second device produces one ingestion and no second paid enrichment.
- `object.kind` is `message`, `edit` (with `replaces`: the original object), `redaction`
  (with `replaces`, and **no content at all**), `file_version` or `memory_revision`.
- `author` is a stable participant: `owner`, `human` (a Matrix user ID), `agent` or `app`.
  Two people with the same display name are never merged.
- `policy.epoch` is the source's inclusion epoch: it increases whenever the source is
  excluded, re-included or its access changes. The service refuses an envelope from an older
  epoch than it holds (`stale_policy_epoch`), so exclusions are applied before any stale
  backlog.
- `policy.googleDerived` is **always `false`** in `envelope.managed` (§4). Only
  `envelope.local`, sent to the local brain on the same Mac, may carry `true`.
- `policy.accountFence` says whether the owner's Google fence is active (§3.7). In
  `envelope.managed` a `drive_file` envelope must carry `false`: while the fence holds, no
  Drive file reaches the managed brain (§4.4).
- `content.text` is normalized plain text, at most 65,536 characters; control events, hidden
  reasoning, credentials and private app instructions are left out. Attachments are
  references with their parse state (`parsed`, `pending`, `unsupported`); an unparsed
  attachment is reported in coverage, never silently dropped.
- `digest` is the SHA-256, in lowercase hex, of `content.text` encoded as UTF-8; a
  redaction's is the SHA-256 of the empty string. Every fixture follows it.

### 3.2 The ingestion receipt (W2 → W1)

`accepted` or `duplicate` (with the accepted revision), `superseded` (a newer revision is
already held), or `refused` with a reason: `google_derived`, `fence_active`, `excluded`,
`withdrawn`, `stale_policy_epoch`, `invalid` or `unsupported`. The reader advances its checkpoint only on
a receipt. The per-source receipt is an indexing checkpoint, not a second chat store.

A restart after a lost receipt resends the same operation and revision; a durable
`duplicate` receipt is sufficient to commit that checkpoint. A timeout or missing
receipt advances nothing. A named refusal may be recorded as processed only with
its durable receipt. The `reader_checkpoint` sequences capture that ordering;
they describe the existing receipt seam, not an additional wire protocol (AW-3).

**The order of the checks.** The two fence refusals come first, so that a Google-derived or
fenced envelope is counted and reported as a fence refusal even when it is malformed:
1. `google_derived`: `policy.googleDerived` is anything but explicitly `false`. A marked
   envelope fails `envelope.managed`'s schema (`googleDerived` is `const false` there), and
   the service still answers `refused: google_derived`, never `invalid`: it reads the mark
   before validating the rest;
2. `fence_active`: a `drive_file` envelope while the account's fence bit is set (§4.5);
3. then `invalid`, `unsupported`, `stale_policy_epoch`, `excluded` and `withdrawn`;
4. and last the answers that aren't refusals: `duplicate`, `superseded`, `accepted`.

### 3.3 Withdrawals and corrections

- A **withdrawal** names a scope (one evidence item, one object, one source, or the whole
  account) and a reason (`forget`, `exclude`, `delete`, `left_room`, `revoked`,
  `account_deleted`). Its receipt is written **before** success is shown: `recorded`, with the
  suppression IDs kept forever and `purgeBy` at most 24 hours later, by which derived
  payloads (chunks, embeddings, graph edges, summaries, drafts, caches) are purged. New recall
  stops at once. A restore replays withdrawals before serving anything.
- **Two kinds of withdrawal:**
  - `forget`, `delete` and `account_deleted` **suppress for good**: the object, and a watermark
    that holds against backfill (a later envelope for it is refused `withdrawn`);
    `account_deleted` is terminal, and nothing is ingested again. These carry no
    `policyEpoch`: the schema refuses one.
  - `exclude`, `left_room` and `revoked` **purge and stop ingestion** (`excluded`), and carry
    the source's `policyEpoch` at the exclusion. The service refuses envelopes from that epoch
    and older (a stale backlog), and a newer epoch is the reader's re-inclusion, after which
    the history may be read again. Only the reader moves the epoch: after `left_room`,
    rejoining is a re-inclusion at a newer epoch; after a deliberate `exclude`, rejoining
    changes nothing, and only the owner's re-inclusion moves it (the `source_inclusion`
    machine).
  - Both keep their suppression IDs forever, and a fact- or object-scoped withdrawal always
    suppresses.
- **What "purged" means, honestly** (found by KS in S3): recall stops at once, and the text is
  removed from **active storage** within 24 hours while the device holding the brain is on.
  GBrain `v0.59.20.0` keeps each write's full request in its journal for 30 days and PGLite
  never vacuums, so a logical purge leaves the bytes on disk; the local brain meets the promise
  by **compaction**, a fresh datastore of live pages swapped in within 12 hours of the oldest
  unpurged withdrawal, whenever the Mac is on. The managed service (G8-16, on Postgres) needs
  its own answer. Backups keep what they held until they expire, and a restore never serves it
  (the replay gate). The privacy text (G6-04·LG) says: "removed from use at once, and from
  active storage within 24 hours when the device is on; backups expire on their own
  schedule".
- A **correction** names the evidence or object it corrects and the owner's statement; it
  supersedes the fact it names across devices, and the original stays traceable. Its optional
  `statementRef` names the Matrix event (a source and an object) where the owner said it,
  usually in their own assistant chat, in a source the owner can read, so the correction can
  cite itself; without one, the brain cites the source it corrects and never
  shows a private correction to a room. The service answers `correction.receipt`
  (`recorded`, with the evidence ID of the owner's statement).
- A Hermes session that already holds the removed fact is replaced by a fresh, sanitized
  session at the next turn (the awareness plan §9); the middle of a cached prompt is never
  edited.

W1 durably retains suppression IDs and inclusion epochs, applies withdrawal
controls before reconnect/backfill/import, and treats `recorded` as the
acknowledgement boundary. An object/fact tombstone stays suppressed even after a
new source inclusion epoch. Runtime tests must combine withdrawal, restart,
old-epoch backlog refusal and deliberate re-inclusion; independent sequence
fixtures do not prove that cross-record behavior (AW-4).

### 3.4 Recall

1. The model calls the recall tool with `recall.tool_args` only: a query, optional filters
   (source kinds, a time range) and a limit.
2. The controller sends `retrieval.request` with the **audience it bound** (§2.2), the
   agent, the query and the limits (at most 20 items and 32,768 bytes of content).
3. The service answers `retrieval.response`:
   - `ok` or `degraded` (keyword-only, or some sources stale), with the items, the coverage
     of the sources that matter, and `contentBytes`, the UTF-8 size of all item content;
   - or `unavailable`, with **no items** and at least one error. An outage never reads as
     "nothing found".
4. In a `shared_room` or `partner` answer, every item is scoped to that answer's room.
5. Every item is marked `untrustedInput: true`: content from other people and documents is
   data, never instructions (G8-20's task-authority proof).
6. **Recalled marked evidence carries its mark:** an item recalled from content marked as
   Google-derived has `provenance: {"google": true}`. Only the local brain on the latched Mac
   ever sets it (the managed brain never holds marked content), only in a private answer (§2.2
   rule 6), and the controller taints the session that receives it (§4.2). An unmarked item
   omits `provenance`; it is never sent as `false`, and a shared answer's items can't carry the
   field at all.

### 3.5 Evidence

Each item keeps who said what, where, when and how sure: the source and object with its
revision, the author, the event and observed times, the policy epoch, its `scope` (private,
or a room), its `epistemic` state (`statement`, `question`, `quotation`, `proposal`,
`decision`, `commitment`, `correction`, `unknown`), its derivation (parent evidence and
source references, so a derived summary is never re-extracted as new evidence), a digest, a
`citation` that opens the source (a Matrix event, a Drive file version, or a memory revision)
and an optional expiry for time-limited facts.

**Evidence IDs are derived, never assigned**, so every device, a backup and the cloud import
agree, and a withdrawal can name a fact a device hasn't seen yet. The brain derives the ID at
ingestion, from the envelope, which carries `object.replaces` for an edit or a redaction; an
edit therefore keeps its original's ID. A recalled item carries its ID but can't be used to
recompute it, since its `object` (an `object_ref`) names the revision it shows and has no
`replaces`. With SHA-256 in lowercase hex, `\0` the NUL character, and the logical object
being the envelope's `object.replaces` for an edit or a redaction and `object.id`
otherwise:
1. `sourceKey` = `source.kind \0 source.id \0 (source.agentPrincipal or "")`;
2. `objectKey` = SHA-256 of `"object" \0 sourceKey \0 logicalObject`;
3. the evidence ID is the first 32 hex digits of SHA-256 of `"evidence" \0 objectKey`, laid
   out as a UUID (8-4-4-4-12), with the version digit (the 13th) set to `8` and the variant
   digit (the 17th) to `(digit & 3) | 8`.

A correction's own evidence (the owner's statement) uses the source
`{"kind": "owner_statement", "id": "corrections"}` and the correction's ID as its logical
object. Test vector: the group decision of the fixtures (`human_group`
`!synthetic-room-0001:example.invalid`, logical object
`$LnchDecisionEvt1aB2cD3eF4gH5iJ6kL7mN8oP9q`) has `objectKey`
`ccf73ec2ba92bc27e025fbccd237073ed4a0035b76ea7edfc9b1df59188763a0` and the evidence ID
`70f935cc-2c2a-8913-a35a-81300d46f107`. The local brain's `keys.mjs` is the reference
implementation, and every evidence ID in the fixtures follows the rule.

### 3.6 Coverage

A `coverage.entry` per source: `ready`, `catching_up`, `partial`, `offline`, `excluded`,
`needs_keys`, `paused` or `error`, with its reasons. `ready` has no reason; every other state
has at least one: `google_fence`, `cloud_access_ended`, `owner_paused`, `keys_missing`,
`backfill_pending`, `unsupported_media`, `service_unavailable`, `device_offline`,
`excluded_by_owner`, `temporary_conversation`. Backfill takes the last **30 days** and the
active conversations first, then older history in idle batches; thirty days is a priority, not
a cutoff, and a question about an older date triggers a targeted read at once.

`coverage.summary` is what the surfaces show (W5, G8-35): the worst state, the counts per
state, and whether the Google fence is active and how many sources it pauses. "Paused" and
"stale" are shown as such, never as complete.
- **The worst state**, worst first: `error`, `needs_keys`, `offline`, `paused`, `partial`,
  `catching_up`, `ready`. `excluded` is the owner's choice, not a problem, so it never makes the
  summary worse: the summary's state is the worst among sources that aren't excluded,
  `excluded` when every source is, and `ready` with no sources.
  The pack declares this priority once in `coverage.summary_priority`; both
  independent checkers refuse state/count contradictions (UI-A1). Fixtures
  cover every selected priority, all excluded, no sources and false-complete
  summaries. The mutation suite checks all 256 presence combinations, each
  against all eight possible output states. UI renders the provider's summary;
  it never repairs inconsistent counts with a competing renderer-local policy.
- **The reader tells the brain what only it knows.** The brain knows its own states (an
  exclusion, the fence, unsupported media, its own outage, a restore's gaps), not the
  reader's (`needs_keys`, `catching_up` while backfilling, `device_offline`,
  `temporary_conversation`). So the reader sends `coverage.report`, 1 to 200
  `coverage.entry` items (a reader with nothing to report sends none), and the brain merges
  each with its own view of that source: the worse state wins, and the reasons are united. `retrieval.response`'s coverage and the
  summary then include both.
- **`processedThrough`** is the time through which the brain holds the source with no gap.
  After a restore loses pages ingested after its backup, the brain reports the source
  `catching_up` (`backfill_pending`) with `processedThrough` just before the oldest lost event,
  and forgets those receipts; a reader whose checkpoint is later rewinds to it and re-sends.
  The reader reports `catching_up`/`backfill_pending` until the gap closes. This is
  a no-gap watermark, not the SDK sync token or proof every event was observed;
  the restore sequence refuses keeping a later checkpoint merely because sync
  resumed (AW-3).

### 3.7 Two Matrix keys

- `io.atum.provenance` in the content of an agent-authored event: `{"v": 1, "google": true}`
  marks it as derived from Google-protected material (§4). Absent means not derived.
- `io.atum.google_fence` in the owner's Matrix account data: `{"v": 1, "since": <ms>}`, set by
  any device of the owner that holds the Google latch. Every device of the owner, the cloud
  companion included, can read it. v1 never removes it. The first latched device writes it,
  with its own latch time; a later latched device leaves an existing value as it is, so
  `since` is the earliest. The fence applies **from `since` on**, never retroactively: an event
  authored before it carries no mark, correctly, because it wasn't derived from Google.
- **Each device marks by its own latch.** With two Macs, a latched and an unlatched one can hold
  the same agent's lease at different times. Only the latched Mac marks what it authors; the
  unlatched Mac's output is unmarked, which is right, since it never held the grant. A reader
  therefore never expects every event of an agent to be marked once any of its devices
  latched.

## 4. The Google source policy (G2-19)

Google-protected material is anything obtained through a Google connection grant (Gmail,
Calendar, Drive API responses and their attachments), and anything derived from it. While
the fence holds, **nothing derived from it leaves the device that holds the grant**: not to
the managed brain, not to the cloud companion, not through agent-content sync. Coverage
reports the pause, and unrelated work continues.

1. **The latch and the fence.** A device sets its latch (G2-19·RT) when a Google grant exists
   and keeps it after a disconnect. It then sets `io.atum.google_fence` in the owner's account
   data. The account's fence is active from then on; v1 has no way to lift it, and content
   produced under it stays fenced even if a later version lifts it.
2. **Tainted sessions.** A Hermes session is tainted once its context holds any of: a Google
   connector tool's result; recalled evidence or memory that is marked; for an account whose
   fence is active, the content of an Atum Drive file (v1 carries no provenance on files); or a
   delegated child's tainted result. It stays tainted until it ends, compression included.
   A runtime that can't prove a session untainted treats every session on a latched device as
   tainted.
3. **Marking.** Everything a tainted session authors carries the mark: its Matrix events
   (`io.atum.provenance`), its memory revisions (in the revision's metadata, AW) and the
   drafts it posts. RT marks events on the desktop; CX marks what cloud sessions author.
4. **Ingestion.** The reader, local or cloud, never puts a marked event or revision into
   `envelope.managed`; it records the source's coverage as `partial` (some content fenced) or
   `paused` (all of it), with reason `google_fence`. For an account whose fence is active, v1
   does not ingest `drive_file` sources into the managed brain at all (coverage `paused`,
   `google_fence`), because files carry no provenance yet.
5. **The knowledge service refuses** any envelope whose `policy.googleDerived` is not
   explicitly `false` (receipt `refused: google_derived`). It also keeps its own **sticky
   fence bit** per account: the reader sends `fence.notice` as soon as it sees
   `io.atum.google_fence`, and any envelope with `policy.accountFence: true` sets the bit
   too. Once set, v1 never clears it, and the service refuses every `drive_file` envelope
   (`refused: fence_active`) whatever the envelope claims, so a faulty reader can't send a
   Drive file of a fenced account through. These are second checks, not the first, and they
   come before every other check (§3.2).
   - **The notice is acknowledged:** the fence is a safety control, so the service answers
     `fence.notice` with `fence.ack` (`{"active": true, "since": <ms>}`), and the reader
     retries the notice until it gets one.
   - The service keeps the bit in its own records, never in GBrain's, so a restored or rebuilt
     index can't lose it, and the fence holds from the **earliest** `since` any notice or
     envelope reported: a later notice never moves it forward.
   - Drive files indexed **before** the fence stay: no grant existed yet, so they can't hold
     Google data. Only new versions are refused; there is no retroactive purge.
6. **The local brain** on a latched Mac may index fenced content with `envelope.local`: it
   never leaves the Mac. When the account later enrolls in the cloud, the import to the
   managed brain sends only items that are valid `envelope.managed` envelopes (so nothing
   marked, and no Drive file while the fence holds), with their withdrawals first; the
   import manifest's own format is KS's (G8-37·KS with G8-16) and is fixed there. KS has
   defined it in the local brain as `atum.local-brain.import/1` (`brain.export`: withdrawals
   and suppressed scopes first, then envelopes, then corrections, with counts of what was held
   back); CO packs it as `spec/knowledge-import/v1` with G8-16, its first consumer.
7. **Sync.** The existing containment continues (the Google sync boundary, 09-13): while the
   latch is set, automatic upload and restore of memory, learned skills, instructions and
   personal pet content pause on that device, and the transport rechecks before every
   dispatch, including after a token refresh. Local editing continues and cloud data is left
   as it is.
8. **What stays possible.** Human messages, unmarked agent output, cloud-executor output from
   untainted sessions, and every other source keep flowing; the assistant says plainly when a
   fenced source limits an answer. Cloud tasks never read Google themselves: Google tokens stay
   on the device (G2-08·RT).

### 4.1 Contract freeze is not Google connector activation

CO's dated source-policy disposition retains the strict shared/partner refusal
and the managed-brain fence. It closes the contract question without claiming
Google verification, approved scopes, legal clearance or an implemented guard.
No new consent, policy or provenance service is introduced. Before a Google
connector is activated for launch, the existing owning rows must retain:

- **G6-01·LG / OW:** permitted use, minimum scopes, OAuth verification and any
  required assessment; no inference from having working OAuth sign-in.
- **G6-04·LG, with UI:** actual data-flow/retention notices and required affirmative
  consent. Google's agentic/tool invocation requirements are not waived by O12's
  normal Hermes approvals-off choice; RT/LG must verify the concrete connector
  interaction rather than assume blanket account consent is sufficient.
- **G2-19·RT / AW / KS:** real latch, provenance, refusal, retry/restore and
  no-export tests. Include model routing, Matrix delivery/key backup, learned
  content and local caches: encrypted transport alone is not a policy exemption,
  and a marked private answer is not unrestricted export permission.
- **RT / LG:** verify model-provider data use and local cache/retention behavior
  for the actual connector feature. A local-only brain does not itself authorize
  permanent Google-derived storage or third-party model training.

These are activation gates for Google features, not a reason to rebuild identity,
chat, GBrain or upstream Hermes. Unrelated, unfenced sources retain their existing
dependency-ready implementation path.

## 5. Acceptance fixtures

`fixtures/` holds shapes and example payloads, positive and adversarial, for W1, W2, W3 and
W5 to test against, and for the W6 harness (G8-41) to build on. They are not a harness.

| Fixture | Shows |
|---|---|
| `envelope-human-group-message`, `envelope-edit`, `envelope-redaction` | A group fact, its correction by edit, and a redaction with no content |
| `envelope-redaction-with-content` | Rejected: a redaction must carry nothing |
| `envelope-names-owner` | Rejected: the owner comes from the channel |
| `envelope-google-derived-to-managed` | Rejected: the managed brain never receives fenced content |
| `envelope-local-google-derived` | Accepted: the local brain on the same Mac may |
| `envelope-drive-file`, `envelope-drive-file-fenced-account` | A Drive file for an unfenced account, and one for a fenced account rejected |
| `fence-notice`, `fence-ack`, `receipt-refused-fence` | The reader telling the service the fence is active, the service's acknowledgement, and a Drive file refused for it |
| `receipt-*` | Accepted, duplicate, and refused as Google-derived |
| `withdrawal-forget-fact`, `withdrawal-receipt` | "Forget this", recorded with suppression IDs and a 24-hour purge |
| `withdrawal-exclude-source`, `withdrawal-exclude-without-epoch` | "Keep out of assistant memory" with its policy epoch, and an exclusion without one rejected |
| `withdrawal-receipt-late-purge` | Rejected: purge later than 24 hours |
| `correction`, `correction-receipt` | A correction superseding a stated date, citing the owner's statement, and its receipt |
| `recall-args`, `recall-args-forged-audience` | What the model may send, and a forged audience rejected |
| `retrieval-private-request`, `retrieval-private-response` | A private cross-conversation question with two cited sources (gate A) |
| `retrieval-shared-room-response`, `retrieval-shared-room-canary` | A group answer using only that room, and a private canary from another room rejected (gate B) |
| `retrieval-private-google-derived`, `retrieval-shared-room-google-derived` | The local brain's private answer with a marked item, and a shared answer carrying one rejected |
| `retrieval-outage`, `retrieval-outage-with-items` | An outage reported as unavailable, and "empty success" rejected |
| `coverage-*` | Ready, partial behind the fence, paused, needs keys, and a paused source with no reason rejected |
| `coverage-summary` | What W5 shows |
| `coverage-report` | The reader telling the brain what only it knows |
| `reader-receipt-retry`, `reader-restore-rewind` | Same-operation lost-receipt retry before commit; restore gap rewinds before backfill |
| `reader-advance-without-receipt`, `reader-restore-without-rewind` | Rejected: a checkpoint without a receipt; reconnect treating a restore gap as caught up |
| `provenance-marker`, `google-fence-account-data` | The two Matrix keys |

## 6. Limits and targets

Frozen limits: 65,536 characters of text and 16 attachments per envelope; 2,048 characters of
query; 20 items and 32,768 bytes per recall; 8,192 characters per item; 200 coverage entries
per response and per report; 1,000 suppression IDs per withdrawal receipt; purge within 24
hours (from active storage, while the device is on; §3.3); the 30-day backfill priority.
Engineering targets, measured and not promised (the awareness plan §11): keyword-searchable
within 10 s p95 after a healthy reader receives an event; recall adds at most 1.5 s p95; at
least 90% grounded answers on the fixed 30-question Vietnamese and English benchmark; zero
accepted cases of scope leakage, resurrected withdrawals, duplicate external actions or
unrequested charges.

## 7. Conformance and agreement

`contract.json` holds the shapes, the `source_inclusion` and `withdrawal` machines, the
invariants and the fixtures;
`pnpm verify:g8-p0-contracts` checks them. Before merge, AW and KS agree on the PR; UI agrees
to §3.6, and RT to §3.7 and §4 (its latch and the event mark belong to G2-19·RT). **Status on
2026-09-30:** KS, RT and AW have agreed, with their amendments folded in; UI's
normative agreement is retained and its UI-A1 inconsistency corrected. The dated
source-policy disposition retains rule 6 for engineering freeze; UI-A2–A4
delivery/copy/acceptance and §4.1's LG/RT activation checks remain open. AW's agreement does
not close runtime acceptance: no-send isolation,
same-device rotation/expiry, receipt/rewind, suppression-after-restart, audience
isolation, malformed-marked/fenced refusal and fence-notice retry, and
profile-versus-memory-toggle tests remain W1/W3/W4/W6 obligations. KS's local brain
keeps a byte-for-byte copy of this pack
(`packages/local-brain/contract/awareness-v1/`) with a drift test, so after canonical merge
KS re-syncs that copy once to the exact merged pack, and moves its recall marker from `local.googleDerived` into the items'
`provenance`. Afterwards
AW's reader emits only accepted envelopes and never a rejected one; KS's service produces the
receipts and responses and refuses every rejected envelope with the named reason; UI builds
G8-35 on the coverage fixtures. After merge/release, changing anything here is
`atum.awareness/2`; this unmerged candidate amendment retains v1.
