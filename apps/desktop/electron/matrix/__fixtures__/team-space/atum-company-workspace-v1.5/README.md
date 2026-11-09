# `atum.company-workspace/1.5`: company DMs and group DMs

Status: frozen C3 contract. No migration, route, controller, Matrix room,
deployment, desktop or phone behavior is included. Select with
`Atum-Company-Wire: 1.5`. Existing families keep schema versions 2–5; only C3
messages use `schemaVersion: 6`.

Base: `atum.company-workspace/1.4` at `f6a0a2b912871a9acea15016d3d341d55350008e8e3d5dfd3a92dacb9a295f96`.

## Identity and audience

A company conversation has a stable platform UUID independent of Matrix room ID
and every Personal chat identity. Its immutable canonical participant identity is
the company plus the sorted set of `(memberRef,membershipAdmissionEpoch)` values.

The participant-set digest is normative. Sort participants by ascending UTF-8
bytes of `memberRef`, then encode this exact UTF-8/LF preimage (including the
final LF, with no BOM):

```text
atum.company-conversation-participant-set/1
companyId=<lowercase UUID>
kind=<dm|group_dm>
member=<43-char memberRef>:<base-10 admissionEpoch>
...
```

Hash those bytes with SHA-256 and encode lowercase hexadecimal. The pack's DM
and group-DM vector fixtures carry expected digests for SQL, TypeScript and Swift.

- DM: exactly two active humans.
- Group DM: three to nine active humans.
- Caller must be one of the participants.
- Every participant must be an active human in the same company.
- Owner/admin rank grants no list, read, search, file, preview or notification
  access unless that person is a participant.

The same people in another company, or in Personal, always produce a distinct
conversation and room. Stable member refs do not revive access because the
membership admission epoch is part of identity.

## Atomic open

`conversation-open` takes one actor-scoped request ID and the exact participant
member-ref set including the caller. Request order is irrelevant: under one
company/participant lock, the platform sorts and deduplicates the set, resolves
current admission epochs, and returns the existing
conversation for that exact set or creates it once. Concurrent callers converge
on one UUID and one recoverable room attempt.

Duplicates, cross-company refs, inactive humans, agents and sets outside 2–9 are
refused. Request replay is `(actor,requestId)` with immutable
normalized input and current authorization. Changed input and cross-actor UUID
reuse conflict without returning the first receipt. A lost response may be
retried; clients never create a substitute Matrix room.

## Adding people opens another conversation

`conversation-expand` names the source and a larger exact participant set. It is
the same atomic open operation for that new set:

- a new conversation/room when the set does not exist;
- the existing conversation when it already exists;
- no mutation of the source participant set;
- no copied transcript, attachment, file grant or automatic preview;
- the original conversation remains available to its original participants.

Clients must explain that history is not carried forward before confirming.

## Provisioning and classification

The fenced hosted manager provisions every company conversation. Immutable create
metadata binds company, conversation UUID, kind and participant-set digest. Rooms
remain plain, invite-only, no-guests, shared-history, manager power 100 and human
power 0. “Private DM” means participant-scoped access, not operator blindness;
clients disclose that the organization hosts the room and it is not E2EE.

Company conversation rooms are a distinct company-room target. Unsupported old
clients must quarantine them, never classify them as Personal. C3 activation is
gated on a minimum safe desktop/phone classifier and advances the manager
assignment epoch.

## Removal, readmission and hidden state

Company removal or admission-epoch change invalidates conversation participation
at SQL commit and queues exclusions for joined, invited and uncertain Matrix
grants. Remaining participants retain history. A group with at least two current
participants may continue; below two it becomes `read_only`. A DM becomes
read-only when one participant is removed.

`read_only` is terminal for that immutable participant set. There is no
`restore_participant_set` transition; a current set opens a different
conversation identity and receives none of the old conversation's history.

Readmission creates a new membership epoch and restores no old conversation. A
new open at the current participant epochs creates or finds a different identity.

For this slice, Close/Hide is per-user presentation state only. It changes no
participant authority, Matrix membership, search/file audience for other users,
or conversation lifecycle. Unhide restores the row. There is no Personal-style
leave/delete/ban action on a company conversation.

## Audience-dependent surfaces

The effective audience is:

`active company membership at the recorded epoch AND current conversation participation`

Directory, transcript, search, file grant/stream, preview, link unfurl, push,
mention counts and reconnect catch-up all use it. Protected file references carry
an explicit channel-or-conversation audience discriminator; a conversation is
never represented as a fake channel. Preview caches are scoped to resource,
audience target, participant generation and viewer admission epoch.

## Compatibility, rollback and errors

Wires before 1.5 return no company conversations. Their room classifiers must
quarantine the new immutable metadata; activation stops if they cannot. Company
conversation messages never appear in Home/Personal after a directory failure.

Rollback disables new opens/admissions first and retains participant ACLs,
bindings, room attempts, possible-grant exclusions, hidden preferences and files.
It never recasts conversation rooms as Personal or broadens them to company-wide.

Closed reasons:

- `404 conversation_unavailable` / `participant_unavailable`
- `409 participant_limit` / `participant_set_conflict`
- `409 admission_epoch_conflict` / `conversation_read_only`

Guessed conversation refs and nonparticipant administrators receive normalized
unavailable responses with no names, counts, room IDs, files or existence signal.

## Required traces

- Concurrent A+B opens converge within one company.
- Company A, Company B and Personal never share identity or transcript.
- Expanding A+B to A+B+C reveals none of A+B history.
- Nonparticipant owner/admin cannot list/read/search/download.
- Removal covers joined, invited and uncertain manager effects.
- Readmission does not restore the old conversation.
- Below-two remaining participants is read-only.
- Hide/unhide changes only that user's presentation state.
- Manager restart after uncertain create cannot create a duplicate room.
