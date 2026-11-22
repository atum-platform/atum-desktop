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

History acquisition precedes the transaction. A read failure retires the request
with a durable refused receipt and no claim or dispatch, enabling one fallback. An explicit
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
authority remains valid. Old cutoff/reset results are silenced. Authenticated request-id reset
requires native stop/idle confirmation (including pending background work), then
advances the epoch and floor in room ordering. Old threads and receipts remain.

Background history is bounded to 20 pages, 100 events per page, and one megabyte
of text. Missing upper boundaries fail closed. Budget exhaustion after the upper cutoff
returns a bounded suffix with known omission counts and an explicit unknown-total
truncation disclosure; missing explicit boundaries on an exhausted room fail closed. Encrypted/group rooms are
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


## Review fixes (2026-11-22)

Built locally, not live. The retained review verdict was fix-then-ship; this
checkpoint addresses G1–G7, C1 and C3 without push, PR, CI or deployment.

- G1: the admitted/non-forwarded path atomically writes a void receipt with
  `forwarded:false`, settles never-sent, and clears the binding's open request.
- G2: retain the binding's owner-event/admission-to-close queue window. An owner
  event queued within that window remains admissible after a long hold. The
  15-minute rule still refuses unrelated old events, and future events remain
  bounded. Carry the window through consecutive queued turns.
- G3: binding keys include account, Mac and native T3 session identity. A stable
  room pointer retains the previous binding until its native work is stopped and
  confirmed. Session replacement raises the epoch, preserves a reset boundary,
  and launches a new native thread; old receipts remain silenced history.
- G4: background history stops at its existing 20-page/one-megabyte budget once
  the upper event is found. Whole-message omissions have known byte/message
  counts; unscanned older history is explicitly truncated with unknown total,
  never represented by an invented exact count. Reset floor ordering remains
  fail-closed when a truncated read cannot prove the old floor was reached.
- G5: Hermes Matrix final sends use `m.in_reply_to` (and `m.thread` for actual
  threaded sends). Preserve these messages; exclude edits. Skip assistant replies
  whose source event belongs to a forwarded relay receipt so a published answer
  is not fed back to its own thread. Ordinary replies remain contextual history.
- G6: wire tool is exactly `reset {room_id, request_id}`. Main obtains and freezes
  the newest canonical plain-DM Matrix event as the floor; callers cannot supply
  it. Receipt: `{gateId,requestId,class:"reset",receipt:"reset",epoch,stopConfirmed}`.
  Pending native work/descendants returns false; retry the same id. Stop owed is
  durable before interrupt; receipt settlement and epoch/floor change are atomic
  after idle confirmation. A pending reset blocks sends. Replay retains its epoch
  and boundary without another stop. Changed-room reuse is refused. Reset authority
  checks counters/entitlements independently of the stop it is settling.
- G7: relay `read` uses a nonblocking native thread observation, with no native
  wait. Relay `wait` is the one native wait, default/max **25,000 ms**, below the
  cloud's 55-second HTTP timeout; caller 50-second values are clamped. The inherited
  thread-id 1.2 API remains unchanged. Native wait still settles descendants.
- C1: pre-admission exceptions now persist `refused`, proving non-dispatch, rather
  than returning `none`. Post-forwarding exceptions still hold without fallback.
- C3: known holds expose `phase:"held"` with `waiting_for_mac`, `approval`, or
  `plan_limit`. Map consent/switch fallback reasons to `consent_off`/`switch_off`.

Regression coverage includes each finding, authenticated HTTP read/wait/reset,
reset replay and descendant stop, native-room boundary authority, session
replacement, stale-versus-queued events, budget limits and ordinary reply history.
All checks run with a disposable test HOME; no credential stores are read.

Verification:

- Focused relay/assembly/history/HTTP/sync/fallback-reader: **168 passed, 1 skipped**
  across eight files. The optional skip requires the external strict protocol module.
- Full Electron suite: **13,824 passed, 46 skipped**, 802 files passed and 12
  skipped. The first run exposed missing Python fixture dependencies; reusing an
  already available disposable test environment resolved all of these without
  installing anything. Its temporary ignored environment link was removed after
  the run. The subsequent final G1 binding restoration and fallback-reader
  amendments were covered by the focused rerun.
- Electron TypeScript no-emit check passes. Full repository `typecheck` still
  fails with the eight existing renderer errors from the absent
  `@assistant-ui/react-streamdown` dependency; no dependency installation attempted.
- Touched-file ESLint passes. Full repository lint was run; unrelated existing
  lint errors remain outside the modified files (21 errors, 4,394 warnings). `git diff --check` passes.
- Public guard is executed directly on the local commit and its actual exit
  code is **0** against the prior checkpoint as base. It is rerun directly after
  saving this result in the final amended commit. No piping or suppressed status.

The additive agent-turns/1.7 fallback reason union and runtime allowlist now
accept `consent_off` and `switch_off`, with one regression case for each.

 Installed/real-route
acceptance, physical sleep, provider inference and packaging remain coordinator
work. No extra review was launched by this implementation child.

## Round 3 recovery amendment (2026-11-22)

Built locally, not live. Reuses the existing gate ledger, reset receipts and
native stop/read boundary. No new execution or provider surface is introduced.

Reset now accepts optional `floor_event_id: string` (a Matrix owner event ID) in
its arguments. The gate validates owner and room provenance, freezes that event
as the history floor and rejects a changed floor on an idempotent retry. Legacy
callers omitting it still use the observed history boundary. This keeps messages
after the owner's reset above the floor even if the Mac wakes much later.
The protocol coordinator owns the matching shared contract amendment.

A failed or incomplete reset clears the temporary `resetPending` latch in
`finally`. The existing open operation and stop scope remain authoritative;
the cloud can retry its durable reset rather than leaving a permanent latch.
The fallback reader now covers `consent_off` and `switch_off` using the existing
fallback explanation category.

Focused relay, HTTP, history and fallback tests: 121 passed, one existing skip.
Full Electron, typecheck, lint and outbound guard results follow in the final
verification entry. No push, PR, CI run, deployment or paid API use.
