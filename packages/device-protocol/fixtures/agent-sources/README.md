# Agent sources v1

`atum.agent-sources/1` is the private descriptor and live-access contract for agent-readable sources. A source ID and kind are open, opaque data rather than product enums. Trusted integrations register descriptors beside their existing broker or operation registration; the host expands only verified connection and scope references and intersects them with live owner/agent authority. A descriptor is ON by default when that authority exists, while existing opt-out gates still win.

The contract does not carry credentials, arbitrary URLs, model-written code, or a new permission grant. Unknown IDs and kinds round-trip. An unresolved operation is unavailable; an unfamiliar mandatory policy is `policy_unsupported`. Sources without a background-safe bounded scan remain interactive-only.

## Bounds

- 64 source instances per agent.
- Source IDs match `[a-z0-9][a-z0-9._:-]{0,159}` and reject prototype-reserved keys.
- Cursors are 1..2,048 printable ASCII bytes; the open cursor map is at most 64 entries and 65,536 encoded bytes.
- Descriptor arrays are at most 64 entries and 65,536 encoded bytes.
- Provenance and mandatory-policy tag lists contain at most 16 sorted unique ASCII tags of at most 64 bytes.
- A complete route body remains below 262,144 encoded bytes.

`ok` includes an empty successful read. `partial` may advance only a provider-proven cursor through retained evidence. `not_configured`, `not_authorized`, `unavailable`, `failed`, `budget_skipped`, and `policy_unsupported` carry no evidence or cursor. Cursor reuse requires exact connection, scope, descriptor-revision and authority-revision equality.

`atum.followup-sweep-evidence/2` carries the open source ID and inherited provenance/policy tags. The derived-output fixture shows the union that must survive model context, outbox and derived-memory boundaries. `atum.followup-sweep-result/1` is unchanged because it already cites opaque evidence IDs.

Protocol release: `@atum/protocol` 0.7.56. Runtime migration and activation belong to the platform and client lanes; this pack creates neither.
