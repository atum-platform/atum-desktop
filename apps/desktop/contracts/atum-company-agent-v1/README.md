# atum.company-agent/1 — native company execution (S0.N)

Frozen contract; implementation is built-not-live. Owner ruling 2026-11-03:
“always full power, by default, at all times”. Plan: atum-app
610636a9a518, docs/design/2026-11-03-cos-full-power-plan.md. DR-2/DR-3:
contracts precede P1/C1b/C2b/D1b. No SQL/runtime activation in this pack.

## Reuse inventory and wire selection

Reuse peer CloudTaskExecutor -> HermesControl -> native prompt.submit/session
create/resume, ModelBroker and controllerTurnSlice. Reuse MatrixTurnEffects,
journalingEffects and agent/turn-resume.ts (atum-app); agent-home/1.6 and /1.8
supply requeue/receipt/outbox semantics. This is a company authority branch,
never personal enrollment, human Store entitlement, or a second agent loop.
Use existing company controller lease/agent/invocations endpoints, selected by
Atum-Company-Wire: 2 and the advertised company-ai/2 or company-private-cos/2.
Unknown version is update_required (426); do not allocate money first. The
common company-agent/1 profile is embedded in these messages, not a new public
route. Keep old decoders only for draining/recovering old in-flight journals.

## Homes, fencing and native continuation

binding is server-authored after current company/member/channel authorization.
Channel home namespace is (companyId, agentPrincipal, audiencePartitionId).
Private namespace additionally binds memberPrincipal and membershipIncarnation
from audience; no other pair/channel may hydrate it. A homeId is immutable for
that namespace. Native DB, memory, files, skills, routines, MCP and supported
computer/browser state are stored in its encrypted versioned archive. Never
include transport tokens, model tokens or bridge credentials in archives.

Acquire home.lease.request after acquiring the shared HostTaskSlots slot, before
hydration/admission; do not hold money/home leases while waiting for slots.
Different partitions may execute/commit concurrently. Same-partition writers
serialize by homeId/leaseGeneration, even on different threads. Transport or
service-session leases do not authorize home writes. Renew requires the same
holder/token/generation; expiry or authority loss fences all writes immediately.
A free lease result is distinct from denied/stale/conflict/unavailable.

home.commit CASes expectedGeneration to exactly generation + 1 under a live
home lease, sealing encrypted manifest and per-thread session link atomically
with the turn's receipt/final outbox. Idempotent operationId returns its prior
result; different content under that ID conflicts. Failed/stale CAS leaves the
committed pointer intact. Pending exports remain recoverable, never visible as
committed. A session belongs to this home and exact thread, with one fixed
prompt/tool snapshot per conversationEpoch; changes activate at the next epoch.
Publication rechecks current destination audience/source/correction authority
for every progress/interim/final/write; no timeline or other-room fallback.

home.transition vectors are authority decisions, not client requests. Join,
leave, rejoin and authority-generation churn preserve the entire committed home
reference; leaving still revokes access immediately. Rotate only for a real
disclosure change (e.g. history visibility/private-to-public), with a new home,
partition, disclosureEpoch+1 and fenced migration of still-authorized completed
content. Never inject forbidden retained history. Retired private incarnations
stay retired; readmission never restores them. Delete every private object
version/local cache/journal/pointer/crypto artifact before an erasure witness.
Shared company objects are governed by S0.D, never by pair erasure.

## Turn funding, effects and recovery

Company payer is the fairness key (members cannot multiply the company's share).
Full peer native tools include multi-round and delegated/auxiliary model calls.
company-funding/2.2 defines the single immutable funded slice; no renewable
segments or automatic new reservation when exhausted. Stop, lease/funding loss
or hard deadline interrupt execution, quiesce/export only with current authority,
then settle exactly once. Preserve model accounting uncertainty separately from
tool-effect evidence: a billable model response proves no board/file mutation.

Persist effects before prompt.submit. Persist mutating tool starts and lost
visibility with the peer tracker. Effects are monotonic across attempts; absent
legacy evidence is unknown. none/read_only may requeue under live authority,
new accounted dispatch and existing peer bounds (none: chat <30min, occurrence
<5min; read_only: peer count <=2). side_effect_possible permits one CHECK only,
read back by the SAME operation ID, never repeat effects or continue arbitrary
work in a check. Unknown, stopped, deadline, exhausted recovery, interrupted
check or revoked authority terminate with truthful body-free status. No repeated
checks, replay of unknown mutations, expired-grant reuse, or blanket refusal
merely because dispatch previously happened. turn.request uses the same fences
for claim/dispatch/result/complete/requeue/check; these are not new recovery
machinery. Settlement/outbox delivery reuse peer idempotent receipts.

## Native host bridge

bridge.context is bound out-of-band by the host to session/turn/request, company,
lease and audience. Models supply domain/resource arguments only, never tenant,
payer, principal, token or home selectors. Existing chats/routines callbacks and
the single company domain bridge retain these facts through TS/Python wrappers.
bridge.result is a body-free control receipt, not arbitrary tool result data.
Success receiptRef identifies an authorized domain result fetched through that
domain. Network loss AFTER sending a mutation is outcome_unknown, not unavailable.
Unknown requires read-back by the identical operationId; if absence is proved,
only the original idempotent request may retry. Authority loss stops writes and
requires fresh authority; conflict requires refetch and never auto-overwrites.
Unavailable/resource reasons are factual, not a reduced permission tier. Domain
payload/error text must not smuggle private bodies into these control receipts.
No gateway tool-policy validation; the toolProfile discriminator denotes the
peer runtime profile, not a schema snapshot or a tool-name allowlist.

## Verification and handoff

Run pnpm verify:cos-native-contracts: independent Python/Node pack validators,
TypeScript Zod fixtures, and a TS->Python real-byte seam over every fixture.
P1 owns proposed 0422 grants, 0423 homes, 0424 recovery and lineage assembly.
0396 stays reserved for erasure. Profile inventory is
spec/company-agent/PROFILE-ALLOWLIST-INVENTORY.md. Integration must prove actual
native tools, resume, Stop/crash/deploy, budget exhaustion, independent home CAS,
join/leave retention and disclosure isolation; vectors are contracts, not live
runtime evidence. Delta streaming, renewable segments and gateway tool-policy
validation are excluded. Roll back admission only; retain pointers, funding,
effect receipts and acknowledged inputs; never replay unknown effects or silently
downgrade to one-completion Company AI.
