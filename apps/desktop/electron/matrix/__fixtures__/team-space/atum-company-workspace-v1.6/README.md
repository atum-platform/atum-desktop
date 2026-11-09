# `atum.company-workspace/1.6`: joinable browse and invitee directory

Status: frozen additive A1/A2 follow-up. This pack changes no SQL, route,
deployment, desktop, or phone behavior. Select it with `Atum-Company-Wire:
1.6`. All 1.1–1.5 messages and schema versions remain unchanged. Only the two
reads introduced here use `schemaVersion: 7`.

Base: `atum.company-workspace/1.5` at `4cdb01a6be636a3f0b83dbd806861e601f69a4fde023516aa18ed09c6c60aa86`.

## Availability and discovery

Capability discovery keeps its ordered-prefix invariant and therefore does not
append 1.6 to `supportedWireVersions`. A desktop probes A1/A2 availability
directly by calling either the public-channel browse route or the caller
invitation route with `Atum-Company-Wire: 1.6`. A `404` or unsupported-wire
response means that 1.6 is not available on that server.

This deliberately decouples the two 1.6 reads from optional 1.5 conversation
support without creating a gap in the advertised version prefix. A future
additive discovery field, such as a separate `features` list, could advertise
A1/A2 explicitly without weakening that rule; 1.6 does not add such a field.

## A1: one-read public-channel join

The 1.6 public browse summary adds `channelGeneration`. A caller can therefore
send the existing `join` command with the exact
`expectedChannelGeneration` from the browse result. The summary remains public
metadata only: it carries no room binding, admission generation, member refs,
private-channel metadata, files, messages, or authority for content access.
`memberCount` is a non-negative count: a newly created public channel with no
active admissions is valid and must not invalidate the rest of the browse.

The 1.4 and 1.5 browse shapes remain byte-for-byte unchanged. A server returns
the schema-version-7 browse only when the caller selects wire 1.6; older wire
selections keep the schema-version-5 response without `channelGeneration`.

## A2: caller's pending company invitations

`GET /api/matrix/v1/company-invitations` is a caller-scoped directory. It
returns only pending, unexpired company invitation attempts whose target is the
authenticated caller. Each item contains exactly:

- `id`: invitation attempt ID;
- `companyId`: the company ID required by the existing accept/decline route;
- `companyDisplayName`: bounded presentation text;
- `role`: `admin` or `member`; and
- `expiresAt`: epoch seconds.

It contains no target handle or identity, inviter, membership row, company
roster, authority generation, audit data, request receipt, Matrix identity, or
another person's invitation. Expiry is applied synchronously before the read,
so an expired attempt is absent rather than presented as pending.

An empty list means this caller has no pending invitation. It says nothing
about other people or about how many invitations a company has issued. The
read is not company-ID-scoped because a not-yet-admitted invitee must discover
the company ID before calling the existing accept or decline mutation.

## Compatibility and security

Both responses are `no-store` and require a currently authenticated native
caller resolved by the Shell. The client never supplies the actor to SQL. The
read RPCs are `SECURITY DEFINER` with a pinned `pg_catalog,pg_temp` search path,
are revoked from `public`, `anon`, and `authenticated`, and are reachable only
through the service-role-backed Shell boundary.

Old wire selections retain their old response schemas. Unknown wire values are
refused without falling back. Mutations, admission rules, invitation lifecycle,
replay rules, and error bodies are unchanged.

## Required conformance cases

- A public browse item includes a positive safe-integer `channelGeneration`.
- A public browse item accepts `memberCount: 0`.
- Missing, zero, or non-integer generation is rejected.
- Private visibility, room bindings, and admission metadata are rejected from
  public browse.
- The invitee directory accepts pending rows for the caller and an empty list.
- Any target, inviter, state, roster, authority-generation, or other-invitee
  field is rejected.
- Duplicate invitation or channel IDs are rejected.
