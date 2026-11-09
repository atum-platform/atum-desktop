# `atum.company-workspace/1.10`: invite a person by Matrix user ID

Status: frozen additive invitation contract. Base:
`atum.company-workspace/1.9` at `1b6d26ab79b9afef4ac73f404d5fdc44406b63df2852ef7a305f72006afb0142`. Select it with
`Atum-Company-Wire: 1.10`. Every 1–1.9 message stays byte-identical; only the
messages introduced here use `schemaVersion: 11`.

## Why

The people directory (Synapse user directory, the public alias directory and
the server-side exact-email lookup) answers with a Matrix user ID. A person
need not have claimed a public handle. The 1.3 invitation takes only a handle,
so a name or email match could be shown but not invited.

## Create

`POST /api/matrix/v1/companies/{companyId}/invitations` under 1.10 takes
`{requestId, memberMatrixUser, role}`. The platform:

1. checks that the authenticated actor is the owner or an admin (and the owner
   for `role: admin`) before any identity lookup, so a plain member cannot probe
   which Matrix IDs are people;
2. resolves the Matrix user ID itself, only through the recorded
   human-Matrix-user binding: an active human whose identity belongs to the
   company's issuer. The client never names a principal, and a client-supplied
   handle is never trusted for the target;
3. applies the 1.3 invitation rules unchanged: one pending attempt per person,
   person and company capacity, seven-day expiry, idempotent `requestId`.

Unknown, unrecorded, foreign-issuer and already-invited people all receive the
same `invitation_unavailable` refusal. The response names no Matrix ID.

`memberHandle` keeps working on the 1.3 create route.

## Invitation shape

A 1.10 invitation is the 1.3 invitation with `targetHandle` always present and
nullable: the target's handle at invitation time, or `null` when they have none.

1.10 reselects the invitation family: the administration snapshot
(`GET …/{companyId}/administration`), accept, decline, cancel and resend. Their
bodies equal 1.3 apart from `schemaVersion: 11` and the nullable handle.

## Frozen predecessors

1.3 and 1.8 messages require a handle. They therefore never see a handle-less
invitation: the 1.3 snapshot and the 1.8 invitation page omit it (a 1.8 page may
be short; its cursor is unchanged), and 1.3 accept, decline, cancel and resend
refuse it with `invitation_unavailable` before anything changes. The 1.1 accept
path and the 1.6 self directory carry no target handle and admit the invitee on
either wire.

## Discovery

`GET /api/matrix/v1/company-capabilities` under 1.10 answers
`{schemaVersion: 11, wireVersion: "1.10", supportedWireVersions, features:
{directoryInvitations: true}}`. A platform without 1.10 answers that request
with its 1.3 capability message, which this schema refuses: clients treat a
refused probe as "not available".
