# `atum.cloud-execution/1.10`: line-up managed dispatch grant

- **Row:** R3 / S2b+S3 two-model line-up managed dispatch (model line-up plan 2026-10-17). Authored on 2026-10-20 on `feat/model-lineup-r1-finish`.
- **Base:** `atum.cloud-execution/1.9` at `spec/cloud-execution/v1.9`, pinned `23e4c5f4d548126b1a77127aace59c0e1c0abd522e9d3570eb48773986909072`. 1.9 is a text amendment over 1.8, so this pack carries 1.8's shapes and fixtures byte for byte and 1.9's A9 by reference.
- **Policy dependency:** `atum.model-choice/1.2`, pin `5e687bef3c3d9b28e1ce1471b048fd3c01728377ccbae55990c774a7e6a5ab09`; policy `2026-10-17.1`, digest `489e82bc…d7a0`.
- **Boundary:** contract and synthetic fixtures only. It changes no alias, dispatch row, route, migration, controller or flag.
- **Status:** unmerged 1.10 candidate; frozen when merged, and never edited after.
- **Checked by** `pnpm verify:s1-contracts`. Authored and re-checked by `spec/_tools/s1/author-packs.mjs`.

## Why a new grant beside 1.7's

1.7's `managed_model_grant` pins policy `2026-10-13.1` (`53c77b31…`) and six rows. Migration 0242 moves the
policy to `2026-10-17.1` with two catalogue rows, so a dispatch under it cannot validate against 1.7. Editing
1.7 is not allowed, and a narrowing is not additive, so 1.10 adds `managed_lineup_grant` and the
`managed.lineup.dispatch.response` message. Both are strict: one singleton alias, its logical model, exact
budgets from the policy row, and the new digest. A grant under the previous digest is a fixture that must be
rejected.

| Alias | Logical model | Context / output | Worst single-call hold |
| --- | --- | ---: | ---: |
| `default` | `nguyet-thuc` | 1,000,000 / 16,384 | 10,317,213,000 |
| `nguyet-thuc` | `nguyet-thuc` | 1,000,000 / 16,384 | 10,317,213,000 |
| `nhat-thuc` | `nhat-thuc` | 120,000 / 16,384 | 19,626,624,000 |

`default` is the unsaved-agent alias; it carries Nguyệt Thực's numbers and must equal the policy default's row.

## Which aliases can dispatch is data, not contract

`cloud_dispatch_policy.aliases` decides which of the three a dispatch may return. This pack does not change it.
`nhat-thuc` is described here so the controller can be built and tested against it; whether production ever
admits it on cloud is the owner's money decision (plan Q2: the #28 daily cap or a written waiver, and a hold rule
for Sol-priced calls). The controller must reject any alias the grant does not name.

## Controller rules (A11, A12)

- The controller may cap its own window per alias, never above the grant's `contextBudget`. Doing so does not
  touch the grant, the catalogue or the digest, so it is a controller deploy and not a policy revision.
- Conversation identity is a fixed compatibility value that moves only when the tool set or system prompt
  changes. The policy digest is not part of it, so a catalogue revision, including 0242, reseeds no room.
  This supersedes 1.7 A6 for line-up grants. The large→small→large vector records one session and zero reseeds.

## Activation and rollback

Order: migration 0242 applied → controller consuming this pack deployed → dispatch row widened to
`["default","nguyet-thuc"]` → Shell flag. Rollback first returns the dispatch row to `["default"]`, then drains
non-default grants. Saved choices are kept. Every production write waits for the owner's explicit go.
