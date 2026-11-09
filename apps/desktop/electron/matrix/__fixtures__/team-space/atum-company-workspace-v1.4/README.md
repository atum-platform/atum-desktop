# `atum.company-workspace/1.4`: public and private channel admission

Status: frozen C2 contract. This pack changes no SQL, route, manager process,
Matrix room, deployment, desktop or phone. Select it with
`Atum-Company-Wire: 1.4`. Existing message families retain schema versions 2,
3, and 4; only C2 messages use `schemaVersion: 5`.

Base: `atum.company-workspace/1.3` at `3bceb11b539c34cea10219dbd951ffee8397016e9c49375bec4acee24a8444c7`.

## Three separate authorities

Company membership is necessary but does not itself grant every channel.
Channel access is an authoritative
`(companyId, channelId, memberRef, membershipAdmissionEpoch)` admission. Matrix
membership, room IDs, cached directories, project association, admin rank, and
knowledge of a channel UUID grant nothing.

The membership admission epoch advances whenever a removed person is readmitted.
Every channel admission records that epoch. A stable member ref therefore cannot
revive a restricted grant from an earlier company admission.

## Visibility and discovery

Visibility is immutable after channel creation. `update_metadata` may carry a
visibility value only so the server can compare it with the stored value;
different values return `channel_visibility_immutable` without mutation.

- Public: bounded name/topic/purpose/state/member-count metadata is discoverable
  by active company members. Message, search, file, preview, room binding and
  notification access still require an active admission. Self-join is explicit.
- Private: invitation-only. A non-admitted person receives no name, topic,
  purpose, count, room ID, search hit, file/preview, notification, link unfurl or
  existence confirmation. Owner/admin rank does not bypass this rule.

Public names are unique within a company. Private names need not be unique;
requiring global uniqueness would disclose hidden metadata. Channels are
identified by UUID. There is no hard delete and no visibility conversion.

The wire has two collections: `channel-browse.response` for public metadata and
`channel-admitted-directory.response` for current admissions. Only the admitted
shape may contain a room binding. A private channel is absent from browse.

## Creation and metadata

All active members may create channels by default. C1 policy may restrict future
creation to owners/admins. Changing policy does not change existing channels.
Every room is provisioned by the hosted manager; clients never create a
substitute Matrix room.

The creator is the immutable channel owner. Admitted members may update bounded
name/topic/purpose and invite active company members. Removing another member
and archive/restore require the admitted channel owner or an admitted active
company admin. Admin rank without admission grants no metadata or moderation
action and does not silently admit its caller.
Archived channels retain audience and history, reject posting, uploads and new
admissions, and restore only through fresh manager reconciliation.

## Admission lifecycle

The admission state machine is:

- `none -> active` by public self-join or default auto-join;
- `none -> invited -> active` by private invite and recipient acceptance;
- `invited -> revoking -> none` on decline, cancellation, or expiry, only after
  the room plan's acknowledged, issued, and uncertain possible grants are
  witnessed banned;
- `active -> revoking -> left` for self leave;
- `active|invited -> revoking -> removed` for administrative/company removal.
- `left|removed -> none` only by creating a new admission generation; public
  channels then self-join, while private channels require a fresh invitation.

Removal from an ordinary public channel is not a durable ban. After revocation
is witnessed and the removed admission advances through a fresh `none`
generation, the member may self-join again, as in Slack. Keeping a person out
requires removing them from the company or using a private channel; `#general`
remains separately protected and cannot remove a member independently.

Private invitations are durable seven-day attempts. Pending attempts terminate
once as `accepted`, recipient `declined`, moderator `cancelled`, or synchronously
`expired`. Decline, cancellation, and expiry end SQL authority immediately but
do not clear the admission directly: it remains `revoking` until the hosted room
plan witnesses bans for every acknowledged, issued, or uncertain invitation
identity. Migration assigns `expiresAt = migration time + 604800` to an old
pending attempt lacking expiry. The channel-members read shape exposes member
refs and admission state/generations, including `revoking` pending cleanup.

SQL authority ends when `revoking` commits. Directory, search, file, preview,
notification and new-admission checks deny immediately. Matrix cleanup is an
external effect and completion waits for current ban witnesses, including
acknowledged and potentially issued invitations. The API exposes pending cleanup
honestly; it does not promise zero-gap transport revocation.

Public join, leave, private invite/accept, remove, metadata update,
archive/restore and create are actor-scoped idempotent commands. Same normalized
input replays the stored receipt after current authorization. Changed input or a
different actor's equal request UUID conflicts without exposing the first receipt.
Every mutation except create carries `expectedChannelGeneration`; admission
mutations also carry `expectedAdmissionGeneration`. A stale value returns
`admission_generation_conflict`; metadata and moderation never use last-writer-wins.
Legacy channel routes cannot carry these fields. They are limited to the 1.1
create/archive/restore subset. Create retains its existing create fence;
archive/restore acquire the channel lock, read the current channel generation,
and apply against that exact generation before releasing the lock. A legacy
request for any newer admission, metadata, invitation, or moderation mutation is
refused without effect using the old wire's closed `matrix_400|403|404|409`
error body.

Shared history remains explicit: an admitted person may read history from before
admission, and later readmission may expose an absence interval. Already delivered
content cannot be recalled. Company readmission auto-admits only `#general`;
other public channels need a new self-join and private channels a new invitation.

## Protected `#general`

The stable `systemKey:"default"` channel is public and auto-admitted on company
acceptance. It cannot be left, privatized, archived, or have members removed
independently. Only company retirement archives it. These protections apply to
all legacy routes, superseding 1.1's ordinary default-channel archive behavior.

## Migration

Every existing company-wide channel becomes public forever. Backfill active
company members into admissions at their current membership admission epoch and
preserve channel UUID, Matrix room, immutable create metadata, history and file
references. Never relabel an existing room private. A private audience requires a
new private channel/room and no automatic history or file copy.

Repair a missing default designation explicitly. Restore the default for an
active company during migration; retired companies stay retired. After C2
activation, new company members receive only the default admission.

## Effective audience

Every dependent surface uses one predicate:

`active company membership AND matching current membership admission epoch AND active channel admission`

Search filters before ranking/counting and rechecks on open. File reserve,
publish, grant, ingress, thumbnail and preview recheck it. Preview caches include
resource and audience identity. Push payloads, mention counts, catch-up and link
unfurls use it. Project membership and company-wide readers cannot inherit a
private channel. The successor company-drive-files contract owns exact file and
preview rules.

## Old clients

Old wires receive only admitted public channels mapped to their closed
`visibility:"company"` shape. Private channels are omitted even when the user is
admitted because those clients cannot classify or safely present them. Public
channels not yet joined are also omitted. A stale old client holding a room still
fails current platform/file/search authority; UI filtering is not enforcement.
Legacy mutations are restricted to the 1.1 create/archive/restore route subset;
non-create writes are fenced by a current-generation read under the channel lock,
and operations outside that subset fail closed on the legacy error surface.

C2 private-channel activation additionally requires the minimum supported
desktop/phone room classifier; without it, private creation/admission remains
inactive even when public channels are active. C2 activation advances the hosted manager assignment epoch and retires the old
manager session's mutation authority. Rollback first disables new admissions and
creation. It retains visibility, ACLs, bindings, revocation work and data and
never returns to company-wide roster derivation.

## Errors

Closed typed reasons:

- `404 channel_unavailable` / `channel_invitation_unavailable`
- `403 channel_not_admitted` / `channel_creation_restricted`
- `409 channel_visibility_immutable` / `default_channel_protected`
- `409 channel_archived` / `channel_name_conflict`
- `409 admission_generation_conflict`

Guessed private refs normalize to `channel_unavailable`; no private metadata or
duplicate-name signal escapes. All responses are no-store.
When an old wire selects the route, new typed reasons map to its closed plain
`matrix_403|404|409` bodies. Legacy `#general` archive/leave attempts remain
`default_channel_protected` enforcement without widening the old body.

## Required conformance cases

- Public metadata is browsable but content/files are denied before join.
- Private metadata is absent across guessed IDs, counts, duplicate names,
  search, links, previews and notifications.
- Raw Matrix join/invite cannot create platform admission.
- Leave preserves company and sibling-channel membership.
- An unresolved identity mapping never delays exclusions for other people.
- Every old channel stays public with its existing room/history.
- `#general` protections hold on current and legacy routes.
- Readmission never restores old private or non-default public grants.
