# Room participation v1

Frozen data-only contract for Groups plan §6 and §7. Policy lives in the owner's private room account data, never room state keyed by an assistant. Only owner SDK writes it; preserve unknown fields. Stored settings cannot establish identity, trust, payer, membership, toolset or consent.

The wire schemas cover policy, usage and optional `io.atum.chain`. `rules` is normative for decisions. Consumer-vector fixtures contain verified-reader facts and expected outputs. Accepted refusal vectors mean the consumer returns no action/a refusal, not that the hostile request is admitted. The generic Python/Node checkers prove wire shapes and pins, not SHA ranking, trigger classification, chain walking, daily rollover or fixed session profiles. Slice 1 must execute every vector through the real pure functions. Runtime adapters must independently re-read authority.

Dynamic `agents` entries need each Matrix user ID and `agent_entry` validated by the consumer because the existing data-only checker has no map-values form. It deliberately preserves unknown extension keys. Malformed known values fail closed. Reserved `consentEpoch` and `speak` confer no permission in v1. Client-supplied authority keys are forbidden at any depth.

Only verified owner's top-level text starts a normal turn. Explicit assistant mentions take precedence, then reply target, then meeting-only everyone. Everyone picks at most two by SHA-256 UTF-8 digest order; named answers preserve mention order. Shared rooms keep owner-only addressed behavior and policy can only lower it. The production meeting default stays addressed until 0200 is live under owner approval.

Room cap is 30 answers per UTC day, configurable 1–200. Client counters are advisory; ledger transaction is the hard authority (0200). Chain turns count. No claim/hold at cap; one paused notice, named requests never bypass. The pure profile suffix table enumerates all eight shared_room × reply_only × pet_surface combinations; reply_only always has zero tools and memory, shared ceilings never widen, all keys remain distinct. Shared chain intake itself is refused. The gateway combined test and cross-profile resume refusal land in slice 6 after PT-10a. Pets affect reply presentation only.

Chain fixtures walk verified owner-SDK events; stamps are untrusted until verified against parents and origin. Depth at most three, six total origin turns, ten-minute origin window, no repeat target or foreign/shared chain. Each chain event is claimed once and runs in a separate reply-only conversation. The single table is owned here; Plan 3 references it. Plan 5 owns the shareGroupKeys legacy guard and deletion precondition.

Disclosure follows turn-time audience, never merely join time. No notice in meeting rooms. First shared answer after audience change posts existing copy once.

Verify: `pnpm verify:room-contracts`. Amend frozen packs by new version. No production apply, default flip, cloud activation, release or publish is authorized here.
