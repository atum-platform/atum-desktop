# Work gate retirement

This is the implementation follow-up to the November 26 audit at `c466b3c777b4`.
The desktop base includes the native provider defaults, owner selection read,
and Connect credential remint. The S2 handoff removal was reported live in R54
before this desktop change.

## Desktop changes

- Remove the Work Unix listener, assertion and grant handling, sync and settlement
  delivery, legacy T3 launch and status calls, and relay history and persona
  assembly. The Work view still starts, recovers, updates and resets its own
  native session. The renderer uses native Mac connection controls and keeps
  Mode B transcript notices, picker choices, and native usage limits.
- Retire receipt-derived assistant activity, shared-chat names, and scheduled-run
  counts. The native route does not expose those receipt fields. Historical
  ledgers, workspaces and threads stay on disk. Billing still recognizes past
  delegated Atum runs.
- Start one managed Hermes gateway and publish native T3 Connect as before.
  The supervisor removes exactly `atum-managed-delegated` and `atum-relay-codex`
  from saved provider instances under the existing startup lock. The owner’s
  `atum-managed` profile, Codex, Claude, Antigravity and OpenCode defaults,
  explicit disables, and custom provider settings keep their existing merge.
- The owner-facing consent view reads the account’s active assistant roster.
  Consent and plan selection still use owner-scoped device-services operations.
  The native provider catalog supplies subscription facts. Turning Work off
  withdraws facts and clears Connect publication. The native Mac disconnect
  also persists the opt-out and withdraws both. Refresh keeps its account and
  device fences and republishes unchanged facts after device key rotation.

## Platform compatibility and release status

The subscription write still validates the owner, active device, enrollment
epoch and Work route epoch. For 404/409 responses the fact reporter reads the
matching device and can send the metadata-only `work_enroll` required by the
current server. This request carries neither a Work grant nor a listener. The
server currently requires the historical socket path shape, so the request
includes that path as metadata. The reporter reads the previous route epoch
and reporting opt-out from the old ledger read-only. Subsequent opt-out changes
persist separately. The old encrypted store namespace remains compatible with
existing Connect credentials.

Scheduled Mode B is a release dependency. In the checked-in handoff-removal
revision, its selection reads `ATUM_WORK_SUBSCRIPTIONS` and requires both
`consented` and `alsoWhenScheduled`. The platform’s 0540 subscription projection
derives those flags from legacy per-device `work_agent_state.announced`. A fresh
device, rotated key, or newly added assistant can lack that announcement after
desktop gate sync is removed. The earlier native-enrollments projection does
not resolve this because the direct MCP migration replaced that endpoint and
scheduled Mode B still reads the subscriptions endpoint. Provisioning a gate
grant or fabricating an announcement would restore the retired authority.
Before rollout, the platform subscription projection needs to derive scheduling
authority from native connection facts, device identity and the owner’s consent
scope. Verify that path on fresh and rekeyed devices, including consent revoke.

Owner DMs resolve and dispatch through native T3 using `work_selection_read/set`.
The examination of platform and S2 source was local. Live provider launches,
installed Welcome validation and the scheduled rollout remain unverified.
