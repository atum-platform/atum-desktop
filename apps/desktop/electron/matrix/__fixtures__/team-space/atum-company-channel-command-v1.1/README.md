# Company channel command 1.1 (frozen)

Additive profile: `Atum-Company-Wire: 1.4` (also supported with existing channel
wires 1.5, 1.6, 1.8) plus `Atum-Company-Channel-Command: 1.1`.
Authentication is the existing Matrix domain bearer session. Content-Type is
`application/json`. The service-only RPC is `atum.company_channel_command_v15`.
Protocol package: `@atum/protocol` 0.7.80. The `15` export/RPC suffix identifies
the successor channel command; it does not mean Team Space wire 1.5 is required.

## Create with members

`POST /api/matrix/v1/companies/{companyId}/channels`

```json
{
  "requestId": "00000000-0000-4000-8000-3f27f2fc4915",
  "operation": "create",
  "displayName": "Launch",
  "visibility": "public",
  "initialMemberRefs": ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]
}
```

`visibility` is `public` or `private`. `topic` (max 250 characters) and `purpose`
(max 500) are optional. `initialMemberRefs` is required, unique, max 100; use
`[]` to create without teammates. References come from the existing company
member directory, never principal UUIDs, Matrix IDs, handles or email addresses.
The creator is admitted automatically, once, even if also selected.

## Direct add

`POST /api/matrix/v1/companies/{companyId}/channels/{channelId}/members`

```json
{
  "requestId": "00000000-0000-4000-8000-266cf79454ab",
  "operation": "add",
  "memberRef": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "expectedChannelGeneration": 1
}
```

Only an admitted channel creator or company owner/admin may add. Both channel
visibilities work. Archived channels and unfinished membership revocations refuse
adds. A current active company membership is required for every pick. An existing
active admission is retained; a pending invitation becomes an active admission
and its stale invitation is cancelled. Removal/rejoin epoch protections remain.

## Response (HTTP 200)

```json
{
  "schemaVersion": 6,
  "operation": "add",
  "channelId": "00000000-0000-4000-8000-f19cafd05964",
  "authorityGeneration": 10,
  "channelGeneration": 2,
  "admissions": [{
    "memberRef": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "state": "active",
    "admissionEpoch": 1,
    "admissionGeneration": 1
  }],
  "replayed": false
}
```

Create returns `operation: "create"` and admissions for the creator and all picks;
add returns the target admission. Admissions are sorted by memberRef. All are
active immediately; there is no invitation acceptance step. Existing creation
policy, role checks and service-role boundary apply. Creation and the entire
selection commit atomically. Reuse a requestId only for the identical route,
company, actor and body. Replay returns the original result with `replayed: true`
without changing admission/channel generations. Refresh the channel generation
before a different add command. Generation/replay conflicts use existing HTTP 409
Team Space errors; unavailable membership uses the existing unavailable error.

## Matrix delivery and compatibility

The command calls `company_channel_admit(..., 'active')`, exactly like the creator
in 0278. Existing expected-member/lifecycle/room-plan projections therefore feed
the selected teammates to the existing fenced room manager/appservice admission
path. Missing Matrix identities remain unresolved in that path rather than being
reported as completed room reconciliation. A successful command is durable SQL
admission, not a synchronous Matrix delivery receipt. Existing room readiness
continues to indicate reconciliation progress. No new Matrix membership mechanism
or controller contract is introduced.

Without the profile header, existing wire 1.4 commands remain frozen, including
private invite/pending/accept. GET members remains unchanged. Unknown profile
values and wrong operations/routes refuse. Clients must not retry new commands
through the invite path when the server does not support this profile.

## Rollout and rollback

1. Coordinator reviews/integrates and runs required checks.
2. Apply 0401 through the normal reviewed database rollout.
3. Publish protocol 0.7.80 and deploy Shell with the profile and POST members route.
4. Verify public/private creation and additions through the live existing room
   manager, including actual Matrix joined membership for both accounts.
5. Switch desktop creation to this profile, passing its selected memberRefs.

This implementation has local SQL/room-plan proof only; production/Matrix-live
acceptance remains required. No real database was changed by its implementation.
Rollback clients and Shell usage first, then apply the down migration. It removes
only the new command function and replay ledger. Active admissions created through
it remain valid under the prior schema; rollback never silently removes teammates.

## Native sources

Existing native seams: `supabase/migrations/0278_team_space_channel_admission.sql`
(`company_channel_admit`, expected members and room plan) and Shell's
`matrix-company-channel-room-controller.ts` (fenced manager boundary).
[Mattermost member management](https://docs.mattermost.com/end-user-guide/collaborate/manage-channel-members)
documents direct addition to public and private channels. Only documentation was
used; no Mattermost server code was copied. Matrix's
[application-service identity assertion](https://spec.matrix.org/latest/application-service-api/#identity-assertion)
is the native primitive behind the existing managed-user path.
