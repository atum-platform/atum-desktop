# `atum.execution-policy/1`: per-agent executor order and enablement

This is the H-F provider contract for the October 13 cloud-completion program.
It extends the existing Matrix executor, enrollment, lease, invocation and
presence authorities; it does not add a second scheduler or answering-mode
switch. The owner can order and enable the logical cloud destination and their
Macs independently for each agent. Exactly one existing lease still authorizes
answering.

## Authority and identifiers

- The owner is derived from the authenticated bearer and the agent from the
  route. Neither is accepted in a write body.
- `cloud` is the one logical cloud destination. A Mac is
  `mac:<deviceServiceId>`, using the stable owner device-service UUID—not an
  executor UUID, lease token, Matrix credential or display name.
- The platform derives the destination inventory and refuses unknown, foreign,
  retired or changed inventory. A client can order and enable only the current
  owner/agent inventory.
- The wire carries one unique `order` array plus a unique `disabled` subset.
  This makes logical-destination uniqueness language-neutral; clients never
  reconcile duplicate objects or last-write-wins flags.
- `requestId` plus the complete body is the replay key. A same-body retry
  returns the accepted snapshot; another body is `request_conflict`.
  `expectedRevision` fences concurrent writes.

## Selection

An absent saved policy resolves to cloud first, then eligible Macs under the
existing presence rules. A saved policy is authoritative: the first enabled,
eligible and stable destination is desired. Offline, locked, busy, incompatible
or stale destinations are skipped, not silently made eligible. All-disabled is
a valid paused state and produces no claim.

A policy write applies before the next claim. It never deletes a busy lease.
An active turn finishes on its current term unless the owner explicitly stops it
or authority is lost. While such a turn drains, status remains `working` on the
current destination even when the new policy disables it; after release, an
all-disabled policy becomes `paused`. An idle lower-ranked holder enters the
explicit non-working `yielding` state, releases through the existing lease
fence, and only then may the higher-ranked destination acquire. Authority loss
returns `stop/authority_lost`: no other executor receives or replays that active
turn. There is no automatic replay after an uncertain dispatch. The selected
answering destination is separate from a tool's target computer.

Eligibility includes the destination's current model, Google/data, runtime,
entitlement and consent constraints. A local subscription remains local; the
platform reports incompatibility instead of copying a credential or silently
substituting a paid model. Group failover is not implied by this contract.

## Status and privacy

`atum.execution-status/1` exposes only logical destinations, closed state and
reason codes, order, enablement and observation time. It never exposes executor
IDs, lease terms, credentials, provider detail, account IDs or prompt/message
content. Only the current holder can be `working`; while it drains for a higher
rank it is `yielding/higher_priority` (not working) and the desired destination
is explicit. An unreachable authority refuses a write rather than claiming it
succeeded.

## Cross-language semantic cases and errors

The generic pack checkers validate JSON shapes. The `semantic_rules` list and
`validation.case` fixtures are the normative cross-language rules they cannot
express as scalar path arithmetic: one cloud destination, disabled-subset,
source/revision pairing, observation time, coherent status, and exact
policy/inventory membership. TypeScript is one reference implementation; SQL,
Swift, Python and other consumers must run the same cases and add their own
boundary proofs rather than copying TypeScript by inspection.

Feature errors use the existing Matrix envelope: `matrix_400/invalid`,
`matrix_409/{request_conflict|revision_conflict|inventory_changed}`, and
`matrix_503/unavailable`. The inventory and revision conflicts include the
current revision. Common authentication/ownership errors keep the surrounding
Matrix API's existing 401/403/404 forms.

## Rollout boundary

Every route in this pack is marked `planned`. This pack allocates no migration
and changes no production behavior. The
provider migration follows the active 0223 supplier in numeric order and must
replace functions from their actual then-current bodies. Platform implementation,
controller adoption and desktop rendering each need their own conformance proof
before activation.

Run `pnpm verify:execution-policy-contract`.
