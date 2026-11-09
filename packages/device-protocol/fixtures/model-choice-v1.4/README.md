# `atum.model-choice/1.4`: the account-wide subscription source

- **Row:** Owner 2026-10-27 account-wide subscriptions, R1: source-aware cloud model choice (OpenCode Go). Authored 2026-10-28 on `feat/subscriptions-r1`.
- **Base:** `atum.model-choice/1.3` at `spec/model-choice/v1.3`, pinned `d0d410f1fad966150ab208e6f74000231d6408c6f0fea621c3e21fa4902f1bed`. Every 1.3 type, message, route, parameter, state machine and fixture is carried unchanged.
- **Scope:** contract-first records only. Shell storage, the subscription edge and consumer changes land separately.
- **Status:** frozen when merged; never edited after.
- **Checked by** `pnpm verify:s1-contracts` (both `spec/_tools/contract_pack.*` checkers).

## The one new choice

A **cloud** destination may name `source: opencode_go` with a model from the server-owned
`atum.provider-connections/1` catalogue and one managed effort. That is the owner's own OpenCode
Go subscription: it is account-wide, it charges zero Atum Protons, and the provider key never
crosses this contract. A Mac destination may not name it in R1; ChatGPT-plan and own-key choices
stay exactly as 1.3 wrote them. The one-choice-per-destination rule is unchanged.

## The subscription grant

A live subscription choice resolves to `atum.model-grant/1` with `source: opencode_go`, the exact
model and effort, the catalogue digest `3fd4371d5e5006735eabe91264ac4b67f55c1a9c12c0ddca37863998cba8cac0`, the model's context/output budgets
and `maxTurnMicroProtons: 0`. The dispatch carries that shape in `atum.cloud-execution/1.13`.
The managed Proton gateway refuses it, so there is no path from this grant to Atum billing.

If the connection is revoked, replaced or unavailable, the grant is `unavailable` with reason
`provider_unavailable`. It never silently becomes an Atum grant. Switching back to Atum is an
explicit owner write that clears the subscription choice.

## Compatibility

The two profile literals widen to accept `atum.model-choice/1.3` and `/1.4`. A 1.3 consumer
keeps validating 1.3 snapshots; a consumer that validates 1.4 also accepts the 1.3 shape and the
new subscription variant. `byoProvider` gains `opencode_go` in the same additive way.
