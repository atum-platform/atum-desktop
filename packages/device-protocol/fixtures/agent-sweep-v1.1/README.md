# Agent sweep v1.1

`atum.agent-sweep/1.1` is the additive warm-up extension to the frozen `/1`
runtime contract. The server remains the sole schedule authority. A claim adds
`occurrenceKind` and `effectiveDueAt`; a `warmup_nudge` also carries its immutable
index 1–4. The four server slots are anchor +5, +15, +35 and +60 minutes.

The anchor is `atum.assistants.created_at`, the durable platform timestamp that
makes the personal assistant definition available. Migration 0328 persists its
cutover and anchors only assistants created at or after that instant. There is no
universal first-run-completed timestamp, and existing agents are never enrolled
retroactively.

If a slot lands outside the owner's 08:00–21:00 IANA-zone window, it moves to the
next 08:00; later slots retain the remaining 10/20/25-minute gaps. A nudge uses
the existing funded 1,800-second turn slice, may offer without a fresh finding,
and does not consume the two-per-day nonurgent offer cap. Disablement, rollout
policy, owner-first fencing, funding, model/source caps, and per-index dedupe
still apply.

Normal sweeps use a 3,600,000 ms interval through anchor+24h. From +24h through
+48h the interval increases linearly to 7,200,000 ms; after +48h the exact `/1`
baseline scheduler applies. Source/model caps scale inversely with the effective
interval, peaking at 24/16 and returning to 12/8.

## Complete server shapes

The 1.1 pack describes every shape the server emits or accepts for a 1.1 client,
not only the warm-up fixture variant:

- `activity.lastOwnerEvent` is either `null` or the same `{eventId, at}` owner
  event `/1` accepts; `lastDialogueAt` is `null` or a timestamp.
- `claim.response` and `dispatch.response` are either `defer` or their granted
  shape. A `defer` is the same closed reason/notBefore object as `/1`.
- `dispatch.response` covers a normal sweep (`occurrenceKind:
  "followup_sweep"`, `warmupNudgeIndex: null`, 120-second compute) and a nudge
  (`occurrenceKind: "warmup_nudge"`, index 1–4, 1,800-second compute). Either may
  authorize a cloud run (managed or Google-protected grant) or a native Mac run
  (standard or Google-protected protection). `warmupNudgeIndex` is always
  present and is `null` exactly for a normal sweep.
- `settle` accepts 0–5 unique source statuses, either commit binding, harm or
  normal urgency for an offer, and 0–3 unique finding hashes. A nudge offer may
  carry no finding hashes; the server derives its occurrence-scoped dedupe hash.
- `settlement` covers normal sweeps and nudges, every outcome (`answered`,
  `failed`, `stopped`, `uncertain`), every disposition (`silent`, `offer`,
  `none`) and every publication state (`none`, `suppressed`, `admitted`).
- `release` (below) is the only new operation. `/1` has no release.

The `/1` wire stays byte-identical. The additive fields are the policy
`effectiveSourceIntervalMs`, `effectiveSourceChecksPerLocalDay`,
`effectiveModelAttemptsPerLocalDay`, `warmupActiveComputeSeconds`,
`warmupOffsetsMs`, `warmupReleaseLimit` and `warmupReleaseBackoffMs`; the claim
`occurrenceKind`, `effectiveDueAt` and `warmupNudgeIndex`; the dispatch
`occurrenceKind`, `warmupNudgeIndex` and per-kind compute; the settlement
`occurrenceKind` and `warmupNudgeIndex`; and the release messages.

## Release

A nudge claim holder that cannot produce one honest message returns the claim
unconsumed with `release`. A release is not a settlement and never publishes.
The request carries the occurrence and its lease token, a closed `reason`
(`invalid_result`, `ambiguous_submission`, `unusable_claim`) and optional
`usage` that records only what was actually metered.

- The first two releases per nudge retry the same index after
  `warmupReleaseBackoffMs` (120,000 ms) inside the owner's delivery window. The
  server refunds the dispatch holds, records one source check for a dispatched
  scan, and charges only the release model `usage` (zero when absent). A Mac
  managed run is charged its server-minted hold, as in settlement, because a Mac
  cannot self-report around the spend envelope.
- The response is `released` with `releaseCount` 1 or 2 and `retryAt`.
- Releasing again after the retry bound retires the nudge: the occurrence is
  recorded terminally with outcome `uncertain`, disposition `none`, publication
  `none`, and the warm-up index advances. The response is `retired` with
  `releaseCount: 2` and the settlement receipt fields. A retired nudge can never
  publish, so exactly-once publication is unchanged.
- Replaying the same release for the same occurrence returns the same durable
  response.

The release is idempotent per occurrence. The server rejects a release for a
normal sweep, a non-holder lease, a completed or skipped occurrence, or an
unknown occurrence.

Compatibility is negotiated by the request profile. `/1` callers keep the
frozen response shape and continue normal sweeps; they cannot claim a nudge they
do not understand. `/1.1` callers receive the new fields and budgets. This pack
is released by `@atum/protocol` 0.7.52 and migration
`0328_agent_sweep_warmup.sql`.
