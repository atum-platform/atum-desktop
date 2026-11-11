# `atum.agent-turns/1.6`: company progress and interim messages

Frozen additive company presentation profile. Base: `atum.agent-turns/1.5`,
`8e236155820b879627d58774044755cbea73e047a26fe1cb7811e3c6ab12f2ca`. This freezes the D1a/D1b contract only; no controller, client,
RPC, migration or activation is supplied. Personal 1.3/1.4/1.5 rules and markers
remain unchanged, including private-only personal publication.

## Admitted public identity

Only an admitted company publisher may produce this profile. These fields are
visible to **every current Matrix room member**, not just the invoking person:

- `profile: 'atum.agent-turns/1.6'`, `scope: 'company'`;
- `companyId`, `agentPrincipal` (UUID principals, not Matrix user IDs);
- `audience: {kind:'channel',channelId}` OR
  `{kind:'private',memberPrincipal,membershipIncarnation}`;
- `roomId`, `threadRootEventId`, `taskId`, `invocationId`, `revision` (0–48).

A progress marker additionally has `phase: working|waiting|settled`,
`kind: todo|heartbeat|device|touch_id|settled`, optional `device` (room-disclosable
name, at most 80 characters), optional `heartbeat` boolean. Narration is never
progress kind `interim`: it is a real message. An interim marker has exactly the
common fields above, with no phase/kind/device/heartbeat.

The projection copies companyId from binding.owner.companyId, agentPrincipal
from binding.agentPrincipal, the audience discriminator/IDs from binding.audience,
roomId from binding.audience.roomId, threadRootEventId from session.threadRootEventId,
and taskId/invocationId from admission. Native `private_pair` maps to wire `private`.
Do not invent an identity from a room name, sender display name or personal marker.
Never copy a whole native binding/session into content.

**Controller-only:** executorId, assignmentEpoch, authorityGeneration,
audiencePartitionId, disclosureEpoch, homeId, home/pointer/manifest/storage
references, nativeSessionId, conversationEpoch, profileDigest, lease tokens,
lease generations/epochs/expiry, model tokens, grants and credentials. None may
appear anywhere in event content, fallback body, descriptors or transaction ID
preimages. Public IDs are correlation metadata, never bearer authority.
Private membership incarnation is deliberately public only inside that exact
private room; rejoining with a new incarnation never reuses old presentation.

## Matrix content and revisions

Progress is ordinary `m.room.message` content: `msgtype:'m.notice'`, redacted
`body` (1–1000 characters), `io.atum.progress` carrying the company progress
marker, optional strict 1.5 `io.atum.presentation`, and `m.relates_to`.
Interim is `msgtype:'m.text'`, redacted Hermes narration `body` (1–1000),
`io.atum.interim:true`, `io.atum.company` carrying the company message marker,
and `m.relates_to`. It notifies and stays in history, as in 1.4. Neither carries
`io.atum.result`. No raw tool names, arguments, results, reasoning, cross-audience
text or raw admission is rendered. Tools map to existing 1.5 activity categories;
unknown/mismatched descriptors fall back to the safe body per 1.5.

Every original, including in a private CoS room, requires:
`m.relates_to:{rel_type:'m.thread',event_id:threadRootEventId,is_falling_back:false,
'm.in_reply_to':{event_id:triggerEventId}}`. The reply target must be the admitted
trigger in that same thread (the root itself is allowed). No root means no
publication; never fall back to an unthreaded room timeline. The root and trigger
are authoritative admission facts, not client choices.

One transient progress event per identity (sequence 0); revisions edit the
original event with standard outer `m.relates_to:{rel_type:'m.replace',event_id}`.
`m.new_content` is the full new original content, including its exact `m.thread`
relation; both outer and inner markers are identical. Outer fallback body follows
Matrix `* ` edit convention. Interim corrections use the same replacement shape
with `io.atum.company` instead of `io.atum.progress`. Identity, sender, room,
thread root and trigger reply never change across revisions. Revision increases
strictly; retries keep identical revision and bytes. An edit targets the original,
never a previous edit or an unrelated event. Receivers verify room and sender
against the bound admitted agent; schemas alone cannot prove authority.

Use native Matrix send/redact endpoints with deterministic transaction IDs:
`atum-company-presentation-` + lowercase hex SHA-256 of UTF-8
`'atum.agent-turns/1.6\0' + canonicalJson({identity,operation,stream,sequence,revision,targetEventId})`.
`identity` is exactly the public identity object above, without profile/scope/revision.
`operation` is send|edit|redact, `stream` progress|interim, `sequence` is a
persisted nonnegative safe integer (0 for progress, increasing per real interim),
and `targetEventId` is null for send and the original event ID for edit/redact.
Persist sequence, revision, target and exact payload before sending; retry an
ambiguous send with the same key and bytes, never allocate a fresh key or reuse
one with new content. Different audiences/tasks/invocations/operations/revisions
have distinct keys. The key grants no authority. No RPC is introduced here.

## Authority and terminal cleanup

Immediately before **every send, edit and redact**, including retries and cleanup,
recheck the current company/agent assignment, active channel audience or active
member plus membership incarnation, exact room/root/trigger/task/invocation,
executor/lease/fence, disclosure scope and Stop/terminal state through the existing
controller authority path. An earlier admission or valid-looking marker never
substitutes for this check. Denied/stale/missing facts mean no operation; never
retarget to a replacement room, incarnation or task. A terminal turn permits
only specifically authorized cleanup, never more progress/interim publication.
The cleanup authority may survive Stop for the original owned event but cannot
be inferred from the stopped work lease. If it is unavailable, retain pending
cleanup controller-side; do not bypass authority to redact.

Working/waiting progress is silent and transient. Keep the existing 3000 ms edit
gap, 48-edit cap, 180000 ms quiet heartbeat, 20000 ms interim gap and duplicate
answer suppression. On final answer, terminal status, failure or Stop: quiesce
and drop queued edits/held narration, stop typing, then redact the owned progress
root using a fresh cleanup authorization check. Retry cleanup idempotently.
Cleanup failure must not suppress the final/status. Interim messages remain real
history; only an owned duplicate or explicit correction is edited/redacted, also
under a fresh check. Stop does not erase all interim messages.

Clients hide progress after settled/redacted/terminal and never resurrect it on a
late revision. Terminal matching uses the exact company/agent/audience/room/root/
task/invocation tuple, never merely a later message by the agent in the room.
A final in thread A cannot hide thread B's progress. Progress/interim never counts
as a final answer, changes execution state or authorizes side effects.

## Coexistence and adoption

The strict personal `io.atum.progress {profile:'atum.agent-turns/1.3',scope:'owner_private',…}`
MUST NOT be relabeled, widened or accepted as company authority. All prior shapes
and fixtures are carried byte for byte. A 1.6-aware consumer dispatches by exact
profile/scope; an unknown profile is ignored as semantic metadata. Older readers
may show the standard safe body/thread relation (and ordinary interim messages),
but must not infer authority, finality or personal progress state from an unknown
marker. Native Matrix redaction still cleans up for them. Personal localization
and receipt/typing behavior remains unchanged.

Adopted seams: `packages/protocol/src/agent-turns.ts:182` (personal marker),
`:282` (real interim), `:360` (localization),
`spec/_tools/s1/pack-agent-turns-1-5.mjs:60` (additive builder),
`spec/_tools/s1/lib.mjs:114` (schema DSL),
`packages/protocol/src/host-fs.ts:308` (`canonicalJson`),
`supabase/migrations/0442_company_agent_full_power.sql:309` (admitted identity;
controller-only authority and home/session material), and company-workspace's
frozen membership contracts. Matrix `m.thread`, `m.replace`, transaction IDs
and redactions are extended directly; no parallel transport is introduced.
