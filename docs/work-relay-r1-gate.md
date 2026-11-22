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

## Mac assembly follow-through (2026-11-22)

Built locally, not live. The real Matrix composition (`matrix/main-work.ts`), not
legacy `main.ts`, now passes the assistant provisioning ports to the gate factory.
It reuses the device enrollment, owner-bearer device-service client, Matrix owner
history/verifier, `account.agents` and `account.agentDefinition`. A completed
definition read is fenced against account/generation changes before local writes.
The existing peer-link `agentName` registration continues to supply T3's native
"Started by" attribution; no caller attribution fields were added.

`WorkSync` negotiates 1.3 on the existing pull; explicit 400 falls back to 1.2,
then the existing 1.1 path, with the existing retry interval. Strict local 1.3
readers mirror P1's selections/consent page and entitlement invariants. Selection
and its server issue time are committed beside consent in the existing ledger,
before the unchanged ack. Legacy pages clear relay selection. Regressed issue
times refuse the page. The factory refuses selection when account sync/consent
is stale, the snapshot is too old, or the plan is not compiled-in Codex. Status
now reports disconnected on stale selection/preflight authority even when the
native provider advertises a connection. Reset epoch/history floor remain in the
existing per-binding Mac ledger: P1 carries no reset fields in account sync.

`RelayAssembly` uses the existing authenticated T3 MCP transport to list/reuse or
create a project for the assistant's single folder under `Atum/Assistants`.
Folders use a stable digest of the agent principal, avoiding rename churn and
path input from display names. Native project arguments were checked against
T3's `toolkits/project/tools.ts` and contracts `project.ts`: title/workspaceRoot,
with no synthetic caller fields. Listing before creation recovers a project
whose creation reply was lost. No model call is involved.

Selection is resolved in two stages: sync metadata for status/admission, then
main-owned project/persona provisioning after owner-event and history checks,
only for a new native thread. The derived full selection is frozen in G1's
existing receipt transaction. On send/resume the binding supplies the pinned
project and persona revision; a replay does not call provisioning at all.
`AGENTS.md` holds only the synced SOUL and an explicit definition-revision stamp,
written through a private temporary file and rename. The persona pin is durable
per native thread. Record sync does not rewrite a live thread's persona. A reset
or other confirmed new native session takes the latest definition revision and
reuses the project/folder. No memory, Google tools or skill bundle is copied.

Verification: 450 tests passed, 8 skipped across 28 passed test files and one
skipped real-provider file (gate, mount and Matrix main-work suites). New coverage
includes sync persistence-before-ack, 1.2 fallback, stale/regressed snapshots,
project reuse after restart, persona revision pinning (RT11), native project wire
arguments, main target/persona freezing and no provisioning before owner-event
verification. Tests ran with disposable decoy HOME directories. Electron
TypeScript no-emit check passed. ESLint passed for all touched files; the large
Matrix main file retains four pre-existing padding warnings and no errors.
`git diff --check` passed. Public guard passed directly against the local
assembly commit with exit code 0 (no piping); it is rerun on the final amended
commit containing this result, with its actual exit code in the handoff.

Remaining: installed real-route acceptance, including actual maker loading and
retention of instructions across provider resume/compaction (R-0-4/RT11), physical
sleep/stop, and signed packaging. Reset UI and cloud publication-close remain
coordinator assembly items from G1's handoff. No push, PR, CI, installation,
production access, inference, spending, or credential-store reads were performed.
