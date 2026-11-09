# `atum.company-workspace/1.3`: ownership, roles and invitation attempts

Status: frozen C1 contract. This pack adds no migration, route implementation,
controller process, deployment or client behavior. The request header is
`Atum-Company-Wire: 1.3`. Existing 1.1 messages remain schema 2 and existing
1.2 invite-link messages remain schema 3; only the messages introduced here use
`schemaVersion: 4`. A later wire selection never widens an earlier closed shape.

Base: `atum.company-workspace/1.2` at `0fc711022a043c94594390092a9579b41cc2ee420a798efcb7e515487ff58e7c`.

## Authority model

A non-retired company with members has exactly one active human `owner`. The
owner is an effective admin and older wires project the owner as `admin`. The
roles visible on 1.3 are `owner`, `admin`, and `member`; guests are deferred.

- Owner: all admin authority, plus owner transfer and admin promotion/demotion.
- Admin: member invitations, pending-invitation cancellation/resend, invite-link
  operations, ordinary-member removal, and allowed workspace settings.
- Member: accept or decline their own invitation and leave the company.
- Admins cannot remove or demote the owner or another admin. Inviting or
  promoting an admin is owner-only. Invite links always grant `member`.
- Rank grants no private-channel or company-conversation access.

The designated owner is stored separately from the underlying administrative
role. The 1.3 projection renders that row as `owner`; old projections render it
as `admin`. A non-empty company always has an owner and at least one effective
administrator. Owner leave/removal/account deletion with other active members
returns `409 owner_transfer_required` on every wire, including legacy routes.

## Atomic ownership transfer

`POST .../{companyId}/ownership/transfer` takes
`{requestId,targetMemberRef,expectedAuthorityGeneration}`. Under the global
target-person-quota then company lock order it verifies the current owner/generation, requires a different active human
member, promotes the target's underlying role when needed, moves ownership,
keeps the former owner as admin, advances authority generation, journals the
result, and appends an audit event. Concurrent transfer, demotion, removal,
leave, or deletion cannot create an ownerless company.

The replay key is `(actor,requestId)`. Same normalized input returns the stored
receipt with `replayed:true`. This is the narrow self-receipt exception: the
former owner may replay their own completed transfer even though they are no
longer owner. All first executions reauthorize current owner authority. Changed
input is `409`; another actor's equal UUID never observes the first actor's
receipt. `expectedAuthorityGeneration` mismatch is
`owner_generation_conflict`. A sole active owner may use the established
retirement path; pending invitees never inherit ownership.

Migration chooses the active creator when eligible, otherwise one deterministic
active admin and records the choice. A company without an eligible active admin
is repair-required and C1 remains inactive for that tenant.

## Role changes and policy

`role-change` accepts `admin|member`, never `owner`. Only the owner can change an
admin role. The owner cannot be demoted through this command. Role change,
member removal, and ownership transfer share the company lock and expected
authority generation. Replays reauthorize current privilege.

`policy-update` takes `{requestId,policy,expectedAuthorityGeneration}` and is
authorized for the owner or an active admin per Decision 3. It journals replay
by `(actor,requestId)`, advances authority generation exactly once, and emits an
audit event. `policy.channelCreation` is `members` by default or `admins_only`.
It controls future channel creation once C2 is active; it grants no channel
admission and does not rewrite existing channels.

## Invitation attempts

A direct invitation is a durable attempt, separate from the membership row:

`pending -> accepted | declined | cancelled | expired | superseded`

All terminal states are final. Direct invitations expire exactly seven days
after creation. Reads and acceptance apply expiry synchronously; a sweep is
cleanup only. Terminal attempts release reserved capacity.
During migration, an existing pending attempt with no `expiresAt` receives
`expiresAt = migration time + 604800`; terminal attempts are unchanged.

- Create by handle uses the established normalized lookup protections. An
  admin may invite `member`; only the owner may invite `admin`.
- Accept and decline are authenticated server mutations by the target. Decline
  is therefore visible on every device and never a local dismissal.
- Cancel ends only a pending invitation. It never removes an active member.
- Resend always creates a fresh invitation ID and seven-day expiry and marks the
  old pending attempt `superseded`. A resend replay returns the same replacement.
- Resending a declined/expired/cancelled invitation is an explicit fresh create,
  subject to normal lookup and rate limits; it does not rewrite history.
- Legacy acceptance of a superseded, cancelled, declined, or expired ID grants
  nothing and uses the same current checks.

Create, accept, decline, cancel and resend journal by `(actor,requestId)` with
immutable normalized input. A replay reauthorizes current privilege except a
narrow self receipt may confirm the caller's own already-completed accept or
decline. No replay after removal/reactivation revives membership or an old
invitation grant.

The invitation audit records attempt ID, company, target member/identity
reference, actor, operation, before/after state, request ID, authority generation
and timestamp. It never records bearer tokens, message content, email addresses,
Matrix credentials or provider errors.

Company authority generation advances on membership admission/revocation,
role change, ownership transfer and policy update. Invitation create, decline,
cancel, expiry and resend do not advance it until a membership acceptance
actually commits. Invitee-facing mutation responses never expose the counter.
Accept/create with reserved capacity, transfer and role change use the same
target-person quota → company → invitation/link lock order where applicable.

## Capability discovery and activation

Authenticated `GET /api/matrix/v1/company-capabilities` returns the ordered
supported wire-version prefix (including 1.4/1.5 when implemented), per-feature
support flags, tenant activation, and hosted room
controller readiness. Reads may be retried. Clients must not downgrade and retry
a mutation after an ambiguous result. A feature button is shown only when both
support and activation allow it; server authorization remains decisive.

C1 can activate while C2/C3 remain inactive. Owner migration/repair and R1
offboarding completion are prerequisites. Email delivery remains absent until a
current verified-email assertion bound to authenticated issuer/subject exists;
the supported UX is handle invitation or copy invite link.

## Audiences and compatibility

- Active member: their 1.3 company role/policy and their own invitations.
- Owner/admin: active roster plus authorized invitation history; only the owner
  receives controls requiring owner authority.
- Invitee: only their own attempt and bounded inviter/company projection.
- Outsider: nothing; guessed IDs normalize to `invitation_unavailable`.

Old clients see the owner as admin and only their old pending invitation shape.
They do not receive new keys. Every legacy route uses current single-owner,
expiry, decline, cancellation and supersession checks. A 1.3 server never lets
an old route remove the owner, accept a terminal attempt, or grant admin as an
ordinary admin.

New enforcement errors are projected into each selected old wire's already
closed shape: owner-removal maps to the 1.1/1.2 `last_admin` body; new generation
or role conflicts map to plain `matrix_409`; unavailable targets map to plain
`matrix_404`. No new `details.reason` is sent on an old wire.

## Errors

Bodies are closed. Plain `matrix_400|401|403|404|409|429|503` remains available.
Typed reasons are:

- `409 owner_transfer_required`
- `409 owner_generation_conflict`
- `409 role_change_forbidden`
- `404 owner_target_unavailable`
- `404 invitation_unavailable`
- `409 invitation_terminal`
- `409 invitation_expired`
- `409 invitation_changed_input`

Private target lookup, a guessed invitation, and an attempt not belonging to the
caller disclose no state beyond their normalized error. Responses are no-store.

## Replay and acceptance matrix

- Concurrent ownership transfers serialize to one owner.
- Transfer racing owner leave/removal cannot retire or orphan a non-empty company.
- Role replay after actor demotion grants nothing.
- Accept versus decline/cancel/expire/resend has one serialized result.
- Resend replay returns one replacement ID; changed input and cross-actor request
  reuse conflict without exposing the stored receipt.
- Expiry is enforced without waiting for a sweeper.
- Readmission preserves `memberRef`, increments internal admission epoch, and
  restores no private-channel or conversation grant.
- Invite-link rotation remains revoke plus create; no link secret is reissued.

## Rollout and rollback

Deploy additive authority and routes inactive, then controller readiness, then
client parsers and controls, then activate C1 for the acceptance cohort. Rollback
turns off new mutations first but retains owner designation, attempt history,
audit, request journals and revocation work. It never restores pre-C1 routes that
can violate owner or terminal-invitation invariants.
