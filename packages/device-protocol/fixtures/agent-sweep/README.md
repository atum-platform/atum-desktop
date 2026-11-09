# Agent sweep v1

`atum.agent-sweep/1` is the frozen platform contract for Atum's built-in,
system-owned background follow-up occurrence. It is not an agent routine, a
Hermes cron job, a model tool, or a new chat session. The platform owns due
state, admission, funding, dedupe and final publication authority. A current
cloud or Mac home only wakes and executes admitted work.

Protocol release: `@atum/protocol` 0.7.47. Migration: 0316. The held 0315 Bot
API allocation is not a dependency and this contract does not alter the frozen
`atum.agent-home/1.8` or `atum.controller-routines/1` wire.

## Owner setting

`GET /api/matrix/v1/agents/{assistantId}/background-sweep` returns exactly:

```json
{"profile":"atum.agent-sweep-setting/1","assistantId":"00000000-0000-4000-8000-288c0dd127cf","enabled":true,"revision":1,"activeForOwner":false}
```

`POST` accepts exactly `profile`, `requestId`, `expectedRevision`, and
`enabled`. The authenticated owner is authoritative and the server resolves
assistant to agent. The request cannot name an owner, agent, model, schedule,
cadence or room. The same request/body replays; a changed body conflicts. A
stale revision returns 409 with the current snapshot. New and existing active
personal assistants default to enabled; lazy ensure and activation never
overwrite an existing false.

`activeForOwner` is platform rollout truth, independent of the owner's switch:
it is true only for policy `all`, or for an unexpired `owner_canary` naming this
owner. Clients keep legacy between-brief nudges until this field is true, so an
off or other-owner canary does not create a coverage gap.

Disable serializes with dispatch and publication admission. It cancels or
invalidates undispatched work and suppresses a not-yet-admitted offer. A running
attempt settles honest usage without a notification. An already admitted
Matrix send may finish under its existing receipt. Re-enable schedules the next
opportunity after ten quiet minutes and does not replay missed time or erase
finding hashes.

## Executor routes

- Cloud: `POST /api/matrix/v1/cloud/controller/executors/{executorId}/sweeps`.
  The controller credential and cloud enrollment establish runtime identity.
- Native: signed `POST /api/matrix/v1/agents/{assistantId}/background-sweep/executor`.
  The current Mac executor key, current home/term and answering lease establish
  runtime identity. An owner bearer without the signed envelope cannot execute.

Both routes accept the same closed `request` operation. A native claim wraps it
with the signed meta and current lease/home observation; active native work
wraps it with a fence whose operation is exactly `{kind:"job",id:occurrenceId}`.
No request accepts prompt, title, interval, room, owner, agent or model
overrides.

### Claim

```json
{
  "profile":"atum.agent-sweep/1",
  "operation":"claim",
  "requestId":"00000000-0000-4000-8000-c2dc6232adb9",
  "leaseToken":"00000000-0000-4000-8000-1f36c4162676",
  "activity":{
    "lastOwnerEvent":{"eventId":"$owner-event:test","at":1793010000000},
    "lastDialogueAt":1793010060000,
    "busy":false,
    "pendingWork":false,
    "pendingApproval":false,
    "typing":false
  }
}
```

The platform rechecks all authoritative facts, derives owner, agent, room, due
slot, definition and policy, and returns either `decision:defer` with a reason
and `notBefore`, or `decision:claimed` with occurrence identity, 120-second
lease, settings revision, owner IANA zone, fixed policy and per-source
watermarks. Two homes observing the same due slot converge on one occurrence.

### Dispatch

```json
{
  "profile":"atum.agent-sweep/1",
  "operation":"dispatch",
  "occurrenceId":"00000000-0000-4000-8000-149a1ef8d82f",
  "leaseToken":"00000000-0000-4000-8000-1f36c4162676",
  "activity":{
    "lastOwnerEvent":{"eventId":"$owner-event:test","at":1793010000000},
    "lastDialogueAt":1793010060000,
    "busy":false,
    "pendingWork":false,
    "pendingApproval":false,
    "typing":false
  }
}
```

Dispatch rechecks enabled/revision, home authority, activity, funding and caps,
then holds one 120-second compute budget and at most one 8,000-input/1,000-output
model attempt. Authorization is a strict tagged union:

- `kind:cloud`: one bounded budget plus either a `kind:managed` `nguyet-thuc`
  grant at medium effort or `kind:google_protected` grant from the first token.
- `kind:native`: one run-scoped authorization carrying the existing selected
  destination, attribution lane, explicit `standard|google_protected` privacy
  tag and the same call/token/compute limits. An Atum lane also carries its
  bounded call hold; a connected provider carries null because external spend
  is not denominated in Protons. It never creates a cloud compute reservation
  for Mac CPU or silently changes a connected-provider destination. The
  `google_protected` tag overrides ordinary destination routing from the first
  token without changing the saved choice.

Duplicate dispatch returns the existing authorization or a closed defer/refusal;
it never mints a second provider attempt.

### Settle

The closed settlement binds occurrence, lease, immutable result fingerprint,
actual usage, source digest/status/watermarks, owner-event watermark and the
home-specific commit binding. Cloud supplies queue sequence and expected home
generation. Native supplies current home ID/epoch, executor term and lease ID
inside the signed occurrence fence.

The disposition union is exact:

- `silent`: `outcome:answered`, no findings and no outbox.
- `offer`: `outcome:answered`, explicit `normal|harm_before_morning` urgency,
  one to three opaque finding hashes and one sealed existing answer outbox
  reference.
- `none`: `outcome:failed|stopped|uncertain`, no findings and no outbox.

An identical settlement returns the stored receipt. A changed fingerprint,
outcome, disposition, finding set or outbox conflicts. Disablement, owner
activity, stale authority or duplicate finding suppression converts an answered
offer to a silent completion before publication admission. No suppressed or
failed result becomes a recoverable status message.

A sealed sweep outbox is not claimable before that settlement commits
`completed/offer`. Native staging uses the existing queued receipt with a
private retry-time hold; settlement releases it and settlement refusal,
uncertainty or expiry refuses it. Cloud outbox recovery applies the same
occurrence gate. The native settlement route triggers the existing inline
publisher even when the general agent-home publication rollout flag is off;
transport failure is retryable by replaying the identical settlement.

## Result and limits

The tool-free classifier returns strict `atum.followup-sweep-result/1`: either
`silent`, or an `offer` naming one to three host-issued evidence IDs, urgency
`normal|harm_before_morning`, and at most 500 Unicode characters. The owner-home
adapter validates evidence and language before sealing an outbox. Outside the
08:00 inclusive–21:00 exclusive owner-local window, only evidence of harm before
morning may publish.

One agent may use at most 12 source checks, 8 model attempts and 2 nonurgent
offers per owner-local day. Held work counts before dispatch. The first
admission pins the day's bounded-call monetary envelope. Source-only unchanged
work uses no model call. One execution has at most 120 active compute seconds,
one model call, 8,000 input tokens and 1,000 aggregate output tokens. Funding,
trial, wallet, hire pause, entitlement and existing account concurrency rules
remain authoritative.

Finding hashes are host-derived source/revision fingerprints, unique by owner
across agents, pending for at most six hours and retained for 30 days after a
publication receipt; they are never mail bodies, snippets or memory prose.
Refused, uncertain and stale publications release pending hashes. Claim,
settlement and publication effects are replay-safe. An ambiguous provider
attempt is never re-inferred automatically.

Urgent `harm_before_morning` offers do not consume or consult the two-per-day
nonurgent cap. Silent streaks set a four- or six-hour `next_judgment_at`, and
claim returns `judgment_backoff` until it elapses. Re-enable and disabled claim
defers both point to the next ten-minute opportunity.

For native Atum-managed execution, the platform does not trust a Mac-reported
micro-Proton value. Until the managed gateway consumes native authorization
rows directly, settlement conservatively charges one attempt and the complete
server-minted hold; connected-provider work remains outside Proton accounting.

## State and lock order

The occurrence state machine is `claimed -> dispatched -> completed`, with
pre-dispatch cancellation/expiry represented as `skipped`. Sweep disposition
`none` is terminal sweep metadata, not a new legacy
`delivery_disposition`. Cloud queue rows exist only after an idle claim; native
silent settlement does not require a cloud reservation or queue receipt.

0316 preserves the existing money lock order, then serializes sweep state:
model-day/admission locks -> owner serial -> agent sweep state -> occurrence ->
owner-scoped findings/publication admission. Setting disable uses the same
owner/state order. No path takes a money/admission lock after the sweep-state or
finding lock.

Private sweep tables are RLS-enabled and explicitly revoked from public, anon,
authenticated, service and ledger roles. Only narrowly granted security-definer
RPCs expose closed data. Retirement, erasure and assistant deletion make work
ineligible and remove coordination/findings through the repository's deletion
path. Roll callers back before rolling 0316 back; never erase unresolved billing
or publication receipts merely to fit a rollback.
