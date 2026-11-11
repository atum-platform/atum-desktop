# `atum.agent-turns/1.7`: file presentation

Additive over 1.6, base pin `9fc19bfc6a4cd8d1f22e383360287160300c004859e98d8a48a4168083f5a7d9`. Protocol package 0.10.5.
Slice 1 is passive only: no new producer, UI, resolver endpoint or save/recovery behavior.
All earlier messages, warning offsets, amendments and fixtures remain readable unchanged.

## Wire and fallback

The final `m.room.message` answer is `files.answer`: ordinary `m.text`, a nonempty
`body` containing the final publishable agent words, `io.atum.files`, the required
`io.atum.result: {invocation, transaction}` (the earlier answer shape), and an exact
non-fallback `m.thread` relation. No result_warning offset or appended system text.
The result invocation must equal `io.atum.files.identity.invocationId`; it is the
answer identity used by history continuity, never inferred from chip metadata.
For personal chat the producer MUST set both the thread root (`event_id`) and
`m.in_reply_to.event_id` to the triggering question, as earlier answers do.
Company answers retain their bound thread root and reply to the triggering question.
The ordinary body is the fallback for old clients; new readers must preserve it too.
Only the final answer part carries files for multipart answers. It owns every key;
updates target that part's original Matrix event ID, never another part or an edit.

`files.update` is the decrypted content of custom Matrix event type
`io.atum.files.update`, with an `m.reference` to the answer and the identical
answerEventId in its marker. It contains one complete file snapshot, never an
`m.replace` or a body edit. Old clients ignore the custom event. File names and
outcomes stay in encrypted content, never plaintext event envelopes/transaction IDs.

Each output has one opaque fileKey (16–128 URL-safe characters), stable through
recovery and copy placement. name and place are bounded display labels, never
paths, URLs or authority. Each answer has at most 32 distinct keys. Unknown fields
inside the marker, identities, file snapshots and relations are rejected.

## Honest states and outcomes

- saving / recovering: broker commit or exact-request recovery still running.
- saved / committed: broker proved placement.
- saved_as_copy / committed_with_siblings: broker proved deterministic sibling placement;
  name is the actual sibling's name.
- not_confirmed / terminal_unknown: no proof either way after recovery ends.
- not_confirmed / refused: no placement proof; reason is authorization, size, quota,
  excluded_name or other. Never automatically retry a refusal as a copy.
- expired / draft_evicted: retained bytes are no longer kept; never claims lost.

Saving/not_confirmed include draftAvailable, true only for verified retained bytes.
Expired requires false. Saved states omit it. Eviction emits the expired outcome
before removing bytes (24 hours / 256 MiB per agent). This contract does not implement
the store or the durable next-eligible-turn outcome journal (slice 3).

## Authority, ordering and history

Identity is exact: owner_private includes ownerPrincipal; company reuses 1.6
company/agent/audience, including private membership incarnation. Both include room,
thread root, task and invocation. Personal shared-room disclosure is not enabled here.
Each receiver requires current authoritative binding plus bound Matrix sender;
compare all identity fields, root and trigger, never infer them from display names
or event metadata. Missing binding, wrong room/sender/audience means ignore metadata
and keep the existing body. Company private output never crosses its pair.

Each file's revision is a nonnegative safe integer. The answer seals initial keys;
an update may only replace an existing key for that exact original answer, with the
same sender/room/identity and strictly higher revision. Equal retries are no-ops;
conflicting equal/lower revisions are ignored. saved and saved_as_copy are terminal;
expired never resurrects draft availability. not_confirmed may later gain proof or
expire; saving may settle into any truthful outcome. Labels may change on a copy.
Unknown-answer updates do not create chips. History loading must find the original
first, then replay authorized updates in revision order; do not rely on live sync.
A redacted answer removes its file state and rejects later updates. Redacting an
update never restores an older draft claim: rebuild without actions pending a fresh
resolver check. Encrypted-but-not-decrypted events are ignored until decryption.

No chip field grants access. Future open/preview/Finder operations resolve fileKey
server-side against current viewer, owner, agent, audience and answer. No action
without a currently authorized target. Finder additionally requires an existing
local synced file inside the identity-pinned Drive root. Missing files offer search;
revoked access yields plain text. These operations are follow-up work, not slice 1.

## 1.4 acknowledgement clarification

The first real agent-authored interim remark remains history under 1.4. A canned
acknowledgement is not required: desktop may rely on typing/working presentation
and publish only real narration. No fabricated opening sentence is required before
work. Frozen 1.4 schemas and fixture bytes remain unchanged.

Adoption: `packages/protocol/src/agent-turns.ts:532` (company identity),
`:572` (native thread relation), `spec/_tools/s1/pack-agent-turns-1-6.mjs:6`
(additive builder), `spec/_tools/s1/lib.mjs:114` (schema DSL), and Matrix's
native custom events, m.thread, m.reference and encrypted event transport.
