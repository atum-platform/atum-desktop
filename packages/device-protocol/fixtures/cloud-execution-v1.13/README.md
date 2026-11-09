# `atum.cloud-execution/1.13`: the subscription grant on a cloud turn

- **Row:** Owner 2026-10-27 account-wide subscriptions, R1: the OpenCode Go subscription grant on a cloud turn. Authored 2026-10-28 on `feat/subscriptions-r1`.
- **Base:** `atum.cloud-execution/1.12` at `spec/cloud-execution/v1.12`, pinned `d8f556eba8d40ea7761e271faee028cb2c1af8660144cf2a755acddcdf9741ef`. Every 1.12 type, message, invariant and fixture is carried unchanged.
- **Dependencies:** `atum.provider-connections/1` and `atum.model-choice/1.4`.
- **Status:** frozen when merged; never edited after.
- **Checked by** `pnpm verify:s1-contracts`.

## The new dispatch

A turn whose live cloud destination choice is `source: opencode_go` is dispatched with
`subscription.dispatch.response`. Its grant is a turn-scoped opaque token, the selected model and
effort, the provider catalogue digest, the model's exact budgets and `maxTurnMicroProtons: 0`.
There is no managed alias, no Atum policy digest and no Proton model spend.

## What the sandbox receives

Exactly the existing three names: `ATUM_MODEL_BASE_URL` (the platform subscription edge, derived
from `source` and never carried on the wire), `ATUM_MODEL_KEY` (the opaque grant token, whose
digest the platform stores) and `ATUM_MODEL_ALIAS` (the selected model). The provider key is
never in the controller, the sandbox, a home, an archive, an export, the model context, a log or
an error. A durable provider key is a refusal, and so is any fallback to Atum billing.

## Failure

If the connection is revoked, replaced or unavailable, dispatch does not silently choose Atum. The
grant resolution is `unavailable` with reason `provider_unavailable`, and the edge answers a
revoked grant with its closed connection reason. Consumers must surface that state plainly.

## Compatibility

The managed lineup, Google-protected, daily-cap and all earlier dispatch messages are carried byte
for byte. A controller that knows only 1.12 keeps validating 1.12; a controller that validates
1.13 also accepts the subscription response. Acting on it is a controller change recorded in the
platform session log, not implied by this pack.
