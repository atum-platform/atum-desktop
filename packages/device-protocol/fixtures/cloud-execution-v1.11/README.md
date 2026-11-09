# `atum.cloud-execution/1.11`: per-agent daily-cap admission refusal

- **Row:** Reliability-first program item 23 (D25/S18): per-agent daily spending cap refusal. Authored on 2026-10-21.
- **Base:** `atum.cloud-execution/1.10` at `spec/cloud-execution/v1.10`, pinned `9d0ff12e2df9a10ecd93dcc142f62c737ff77c3a9a73965985f6aa01e6beb175`. Every 1.10 type, message, invariant and fixture is carried byte for byte; 1.11 adds one refusal message and two fact types.
- **Policy dependency:** `atum.model-choice/1.3`, pinned `d0d410f1fad966150ab208e6f74000231d6408c6f0fea621c3e21fa4902f1bed`; default 200,000 Protons, 0 = no cap, 80% warning, `Asia/Ho_Chi_Minh` day, Atum-billed spend only.
- **Boundary:** contract and synthetic fixtures only. It changes no admission function, dispatch row, route, migration, controller or flag.
- **Status:** unmerged 1.11 candidate; frozen when merged, and never edited after.
- **Checked by** `pnpm verify:s1-contracts`. Authored and re-checked by `spec/_tools/s1/author-packs.mjs`.

## Why 1.11

1.10 has no admission refusal: its messages are the three dispatch responses and their vectors. The frozen
model-choice/1.3 pack already records the cap rule and says execution refusal reasons belong to the later
cloud-execution contract. 1.11 is that contract, one additive version later so 1.10 stays byte-identical.

The refusal is data, not a new policy. The platform decides every refusal; the controller maps it. A
controller must not compute the cap itself: it has no authoritative spend view and a local refusal would
be a second source of truth.

## The refusal facts

| Field | Meaning |
| --- | --- |
| `state` | always `refused` |
| `reason` | always `daily_cap_exhausted` |
| `cap.dailyProtons` | the agent's cap for the day, 1 or more; 0 is uncapped and cannot be a refusal |
| `cap.timeZone` | always `Asia/Ho_Chi_Minh` |
| `cap.warningPercent` | always `80` |
| `cap.counts` | always `atum_billed_only` |
| `spend.day` | the `Asia/Ho_Chi_Minh` calendar day, `YYYY-MM-DD` |
| `spend.usedProtons` | held plus settled Atum-billed Protons for that agent and day, ceiled once |

The message is strict: exactly these keys, no retry duration and no provider endpoint or credential.
A refusal whose `spend.usedProtons` is below `cap.dailyProtons` is invalid; a refusal from a cap of 0
is invalid. The conformance vectors pin that a cap-0 admission is admitted, never refused.

**Pack spelling.** The pack DSL writes a strict object by omitting `additional` and spells the
"at or over the cap" rule as the `le` invariant `cap.dailyProtons <= spend.usedProtons`; the checker has
no `ge`/constant comparison. Both are the existing convention's spelling of §C.3's `additional:false`
and `usedProtons >= dailyProtons`, with the same meaning.

## Semantics

- **The crossing call finishes.** A model call or Mac provider attempt admitted while committed spend was
  below the cap completes and records its full charge. No call is killed mid-stream.
- **Later calls and later turns are refused.** The next call in the same turn is refused, and the next
  turn is refused before its sandbox starts or its Mac reservation is made.
- **Held and settled both count.** `usedProtons` includes an admitted call's remaining ceiling and a
  completed call's actual charge. A turn's funding quote is not spend and is not counted.
- **Nothing is stored.** The refusal is re-evaluated on every admission, so raising the cap admits the
  next call and lowering it below spend refuses the next one. This differs from a permanent
  `budget_exhausted` denial.
- **The day is the retry boundary.** The refusal clears at 00:00 `Asia/Ho_Chi_Minh` of the next day, or
  earlier if the cap is raised. No duration is carried.
- **Routines skip, they do not fail.** A refused occurrence records `skipReason: daily_cap`, posts one
  summary line and is never dispatched.
- **Never `couldnt_confirm`.** The refusal is terminal for the message; the controller maps it before its
  funding and dispatch branches.

## Wire mapping (A14)

The cloud controller envelope is `{"error":"matrix_403","details":{"reason":"daily_cap_exhausted","cap":{…},"spend":{…}}}`.
The Mac owner-managed edge uses `{"error":"daily_cap_exhausted","retryable":false,"details":{…}}`.
`details` is this message without `state`. The sandbox provider error code is
`atum_daily_cap_exhausted`. Existing consumers of `{error,details.reason}` keep working.

## Relation to model-choice/1.3

model-choice/1.3's `daily_cap.dailyProtons` allows 0 because it is the stored setting and 0 means
uncapped. This pack's `model_daily_cap.dailyProtons` starts at 1 because a refusal must name an
enforceable cap. The two shapes are deliberately not the same type; a cap-0 snapshot can never become a
refusal fixture. The default, warning percentage, time zone and counted-spend value are quoted from
model-choice/1.3 and change only with a new pack version.

## Conformance

Every `accept` fixture is a valid refusal or vector; every `reject` fixture names the violation category
its `contract.json` entry records. The two pack checkers prove only that the pack is self-consistent; a
provider or consumer proves the wire in its own tests.
