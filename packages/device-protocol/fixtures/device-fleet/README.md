# Atum device fleet / 1 — optional facts on the existing Mac registry

This is a pinned additive data contract for the existing `device-service/1` owner
record and routes. There is no second registry. 0427 adds private fleet columns
on `atum_private.device_services`; its existing `device_services_list(owner)` and
GET `/api/matrix/v1/device-services` include optional `presence`, `sourceProtocol`
and `sources`. Legacy records may omit all three. Old clients ignore the facts;
new clients must ignore malformed optional facts and never infer readiness from absence.
These facts are advisory: neither OS permission nor source consent nor a tool grant.

Owner read has the existing native account authentication. The service-role query
uses only the authenticated principal; a client never names the owner. Private
registry columns and controller credentials are never returned. Presence is online
only while the device is active, the reporting cloud enrollment remains active and
trusted, its controller remains active, and its last observation is newer than
90 seconds. Stale rows project `connected:false`, keeping `lastSeenAt`. Any retained
readiness is the last negotiated Hello facts and must never imply an offline Mac is
usable; an explicit close clears those source facts.

The owner's desktop builds U1's frozen `macs[]` from each active registry row:
`id=deviceServiceId`, `name=displayName`, `thisMac` from its own enrolled identity,
`lastSeenAt=presence.lastSeenAt`, and optional `sources`. Determine `state` in order:
this Mac disconnected => `not_connected`; not freshly connected => `offline`;
missing `sourceProtocol:1` => `older`; enabled sources needing permission =>
`needs_permission`; otherwise `ready`. Apply the current account switches when
checking permission/readiness. The client owns `thisMac` and the current account
choice; neither is controller-writable registry authority. Preserve the U1 precedence
rules for source-row explanations. No server invents a missing Mac name or permission.

## Authenticated controller writer

POST `/api/matrix/v1/cloud/controller/executors/{executorId}/device-fleet` under the
existing controller bearer + `X-Atum-Controller`. Body `fleet_update`:
`{operation,deviceServiceId,connectionId,connectionStartedAt,presence,sourceProtocol?,sources?}`.
The account comes from the active, trusted controller enrollment for the executor.
The target must be that account's active Mac. No owner/account selector is accepted.
Only the authenticated hub, after verifying Hello/Proof/Status, may publish facts.
`sourceProtocol` and the complete four-source map are both present or both absent.

Use `connect` once for a newly authenticated connection; persist its immutable
`connectionStartedAt` (epoch milliseconds) in the hub's connection record. It must
be newer than the stored connection's start. `refresh`/`close` must match BOTH the
controller and connection ID and the immutable start, and have strictly newer
observed `presence.lastSeenAt`. A delayed old connect, close or heartbeat is ignored
with `{accepted:false}`. A closed connection cannot be revived: reconnect with a
new ID/start. Clock ties are refused conservatively. New observations must be within
90 seconds of server time and at most 5 seconds ahead. New connects must not regress
the stored observation time. The response is `{accepted:boolean}`; false acknowledges
a stale update and does not alter the newer connection. Unknown optional Hello
source fields must be dropped by the hub, not sent as ready/default facts.

After accepted `connect`, publish `refresh` about every 30 seconds and `close` on
disconnect. The hub's existing publisher must add the operation and immutable start;
it must not use each refresh time as a new connection start. Failures never change
gates or enable remote reads. Source reads remain gated off by 0427 until the separate
D1/U1/X1 disclosure, authority and installed acceptance gates pass.

## Authority transport (same 0427 release)

Mac POST `/api/matrix/v1/agents/{agentPrincipal}/source-authority` requires the native
OpenID account bearer plus `X-Atum-Matrix-Authorization: Bearer <Matrix access token>`
from the same verified MAS issuer/subject. Body is exactly `{gate,expectedRevision}`.
This route explicitly uses an agent principal, unlike source-gates' assistant ID.
The owner principal comes from account authentication, never from `ownerUserId` or
a body/header principal. SQL rechecks the owner/agent relationship.

Controller POST `/api/matrix/v1/cloud/controller/executors/{executorId}/source-authority`
uses the existing controller credential and body `{gate,expectedRevision,grant}`.
`grant` is the original signed TurnGrant envelope (`v,type,body,kid,sig`), using the
existing Ed25519 signing domain and registered active controller key. Shell verifies
its signature, the executor-derived agent principal, and owner/agent Matrix users
against MAS. SQL derives the owner again from the enrollment and rechecks current
credential, key, target device/epoch/connection, grant expiry/files scope, active lease
writer generation/token hash, and dispatched invocation/occurrence. It then calls
`agent_source_gate_authority_read` as service_role. No service key goes to Mac/model.

Both routes return the exact closed `atum.agent-source-authority/1` reply from 0427.
Use `expectedRevision:null` at START; at RELEASE, immediately reissue with the captured
revision and require `allowed:true` and exact owner/agent/gate/revision. Wrong identity,
timeout, missing/malformed result, expired/revoked grant, unknown status or any error
means drop buffered results. The global gate remains false by default. SQL revocation
or revision mismatch yields `allowed:false`; a 200 does not itself authorize release.
Retain the source-gates v2 runbook's disable → drain → re-enable/rollback ordering.
