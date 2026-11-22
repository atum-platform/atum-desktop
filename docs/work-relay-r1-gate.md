# Relay R1: Mac gate and background history

Built locally, not live. G1/G1b implementation for the session-handoff relay.
The coordinating session owns assembly, review, real-route acceptance and release.
No push, PR, CI, deployment, cloud access, provider inference or credential reads.

## Existing features reused

- GateLedger's FULL-synchronous SQLite transactions, event claims, receipt rows,
  forwarded mark and cutoff/stop settlement. Relay metadata is one additive
  receipt column; bindings use the existing meta table. No new store or outbox.
- The existing peer sessions, authenticated T3 `/mcp`, mode ceiling, native
  launch/send/configure/wait/read/interrupt. Wait includes
  `untilDelegatedWorkSettled:true`. Read pages use `afterPosition`, and long text
  uses `itemId` plus `textOffset`. No queued second relay operation.
- The owner's existing Matrix SDK host and its native `createMessagesRequest`.
  The main bridge resolves the canonical assistant DM from the account roster.
  Paging does not change the UI selection, scroll its timeline or create a client.
- T3's pure `handoffBudget`, `selectHistory`, rendering and cost functions,
  extracted verbatim by R-0a from T3 source revision
  `5d8d30d04ee11af5ba92d5aa40a7778505f04cff`. The exact lab CJS bundle is retained
  at `electron/work/gate/handoff-helper.cjs`, with its adjacent MIT notice.
  A normal main bundler statically includes it; no lab path or loader is required.

## Behavior

`send` accepts only `{request_id,event_id,room_id,selection_rev}`. Main derives
text, model, project and target. It validates current consent, local switch,
generation and route counters, provider connection, owner event, canonical plain
DM, age, unique claim and one open operation. Plan turns never consult balance.
Unknown limit state remains unknown; an injected exhausted fact refuses admission.

History acquisition precedes the transaction. A read failure has no receipt or
claim and answers `none`, never proof of non-dispatch for fallback. An explicit
refusal retires its request id durably. Same-request concurrent acquisition is
ambiguous; it must not authorize fallback while the first caller may still send.

The transaction freezes the claim, full native arguments, P1's frozen-call
snapshot and binding before dispatch. `relay_json.frozenCall` conforms to
`WorkRelayFrozenCallSchema`; `call_json` remains the exact native arguments.
Selected IDs, omitted message/byte counts, upper cutoff, lower cursor, floor,
selection, persona revision, session, target and epoch are retained. The intact
current request is separate from budgeted historical material. Oversized native
messages are refused rather than truncated.

A repeated send checks the frozen envelope and current fences, without rereading
selection, history or persona. It returns the frozen admission result. Request,
read and wait reconcile without dispatch. Lost launch acknowledgements recover
ordinal one on the gate's unique launch thread; lost send acknowledgements scan
for T3's deterministic native operation message identity and its run id. If that
identity cannot be established, the operation stays held, with no rerun.

The exact admitted/result run's last assistant item is selected, never a later
owner Work run or a tool row. Paginated text is joined intact and the first result
is frozen before returning its SHA-256, item identity and finish time. Native
read exposes no separate assistant phase, so final-only selection is the last
assistant item of the exact terminal result run, as confirmed by the coordinator.

Completion does not release the binding. `close {request_id}` acknowledges durable
cloud publication, is idempotent after later operations, and refuses unowned IDs.
A confirmed cutoff can be closed without plan consent while grant/counter
authority remains valid. Old cutoff/reset results are silenced. Main-only reset
requires native stop/idle confirmation (including pending background work), then
advances the epoch and floor in room ordering. Old threads and receipts remain.

Background history is bounded to 20 pages, 100 events per page, and one megabyte
of text. Missing upper/lower boundaries fail closed. Encrypted/group rooms are
refused. No historical material at or before the floor can be seeded.

## P1 contract and assembly seams

The executable P1 draft was read directly. Send/status/close, snake-case
request-based request/read/wait, receipt classes and frozen-answer fields match
1.3. Existing 1.2 launch and thread readers remain available. Optional conformance
tests load P1's exported strict schemas when `ATUM_RELAY_PROTOCOL` names its
module; no external checkout path is committed.

Per coordinator instruction, `GateOptions.relaySelection(principal)` remains an
injected authoritative seam returning revision, compiled provider instance,
model, main-provisioned project and pinned persona revision. Factory forwards it;
main composition wires history but does not invent a selection. Without this
seam, sends fail closed. The coordinator's R1 assembly owns 1.3 account-sync
persistence, assistant folder/project and pinned-persona provisioning, reset UI
invocation and H2's publication-close call. No 1.3 sync operation was silently
added to the existing 1.2 client.

Limit reporting is likewise an injected `relayLimit` fact; the default is unknown,
not an invented provider usage estimate. The helper uses its native conservative
default window when the public native read gives no context-usage telemetry.
Installed acceptance must verify shared native context pressure and compaction.

## Verification

- Gate, owner-event and history suites: **390 passed, 7 skipped**, 24 files
  passed and the real-provider integration file skipped. Includes authenticated
  real-socket ids-only admission/refusals and replay; SQLite claim/freeze tests;
  three sequential operations; close; cutoff/reset; lost acknowledgement read-only
  recovery; whole-message/multibyte/oversized history; intact long current request;
  background SDK cursor/floor/room behavior; strict P1 receipt/status/frozen-call
  conformance. The seven skips require an explicitly supplied real T3 runtime.
- Electron TypeScript build passed. ESLint passed for touched code. `git diff
  --check` passed. Bundled the relay into standalone CJS and loaded its export
  with Node successfully, including the native helper.
- Renderer typecheck could not pass against the prescribed shared dependencies:
  missing `@assistant-ui/react-streamdown` produces eight unrelated errors in
  markdown surfaces. No installation or lockfile change was attempted. Emitted
  untracked JS from that check was removed; no generated artifacts are committed.
- Public guard must be run directly on the local commit after this log is saved;
  its exact return code is reported in the coordinator handoff. No piping.

These are fake-service/local integration proofs, not signed/ASAR or installed
real-route acceptance, provider inference, physical sleep or real quota proofs.
