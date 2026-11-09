# `atum.device-service/1.1`: `atum.device-service/1` plus the migration snapshot

- **Row:** Cloud program P-1 (cloud program plan §4.4): device-service/1.1, the migration snapshot (S1 test 10). Authored by the launch coordinator on 2026-10-05 in the cloud program's contracts PR (P-1).
- **Base:** `atum.device-service/1` at `spec/device-service/v1`, pinned `5410649e899a775a1fd3b735ddf88e54b01b560f01f1ccc3891f0d0da91a983f`. **Additive:** every v1 type, message, invariant, state machine and fixture is carried unchanged (the authoring harness checks that each base schema is kept or only widened, and that each base fixture is carried byte for byte). A v1 frame means the same in 1.1.
- **Provider(s):** DA (WS-1): registry, controller keys, routes; CX hub (WS-3a): controller side of the protocol; CX controller (WS-2): staging writer, reconcile sandbox, generation 1.
- **Consumer(s):** Desktop device service (WS-3b, WS-4); CX controller (WS-2, WS-3a); Desktop migration (WS-3b `AgentMigration.stage()`).
- **Status:** unmerged 1.1 candidate; frozen when merged, and never edited after (an amendment is a new version directory). It defines wire shapes, states and rules; it builds no route, migration, service or host and changes nothing in production.
- **Canonical JSON** is the one platform function, `packages/protocol/src/host-fs.ts` `canonicalJson`. atum-app vendors this pack in place of v1 (it is a superset) under `packages/device-protocol/fixtures/`. `version` is the string `"1.1"`.
- **Checked by** `pnpm verify:s1-contracts` (both `spec/_tools/contract_pack.*` checkers). Authored and re-checked by `spec/_tools/s1/author-packs.mjs`.

Moving an agent that runs on the owner's Macs to the cloud must not lose its memory. In v1 no message carries a Mac's Hermes home to the controller, so the S1 build plan's migration steps 4–5 and acceptance test 10 could not be met, and WS-3b kept the snapshot on the Mac (`AgentMigration.stage()` is the hook). 1.1 adds that wire: each Mac that ran the agent uploads one snapshot of its home; the controller stages them in S3, reconciles them in a sandbox, sends the owner the report, applies the owner's choices and commits the result as the agent's generation 1 in `atum.agent-home/1` — before the owner switches the agent to `cloud` (`atum.cloud-answering/1`).

A snapshot is the archive `python -m hermes_cli.atum_home export` writes: one JSON header line, then the home's files, already filtered by `atum.agent-home/1`'s hydration allowlist. It travels as binary chunks on the device connection, like a Receipt artifact; the identity-signed offer carries its size and SHA-256, which are the integrity check.

## The flow

1. **Initiator.** The owner chooses "Move to the cloud" on one Mac. It inventories and quiesces the agent's writers on that Mac, exports the home, and sends `MigrationOffer` with `role: "initiator"` and a fresh `migrationId`. The agent must be the owner's, have a live, trusted cloud enrollment on this controller and have no cloud home yet (pointer generation 0).

2. **Upload.** The controller answers `MigrationAck` `send`, which carries the Mac's `holdUntil` ("The hold", below). A Mac that gets no `MigrationAck` within `admission_ms`, 15 s, treats the offer as refused and sends nothing. The Mac sends the archive as migration chunks; the controller checks them as `case.migration_upload` does, seals the archive into S3 staging and answers `MigrationAck` `staged` with the size and SHA-256 it stored (a Mac treats a `staged` that differs from its offer as refused). Any mismatch is `refused` (`size_mismatch`, `hash_mismatch`, `chunk_invalid`) and nothing is staged. A connection lost mid-upload discards the partial snapshot (`migration_snapshot`: `receiving` → `discarded`); the Mac offers again with the same `migrationId` on its next connection.

3. **Other Macs.** For every other active device service of the owner, the controller sends `MigrationRequest` on its connection — at once, or when it connects within `migration_wait_ms` (10 minutes) of the initiator's offer. A Mac checks a request as `case.migration_request` does (pinned controller key and signature; this Mac as the target; current connection and epochs; not expired) and ignores one that fails. A request carries the migration's `holdUntil`. The owner's confirmation on the initiator covers every Mac's snapshot: a participant shows that the move is under way, quiesces the agent's writers, exports and offers with `role: "participant"`. A Mac with no local home for the agent answers `MigrationDecline` `no_local_home`, and an owner at that Mac may decline (`owner_declined`). A Mac that stays offline for the window, declines, is refused or lets its request expire is listed in the report's `missing` and never waited for past the window. At most `migration_snapshots_max` = 2 snapshots, and one slot is always the initiator's: a participant is refused `too_many_snapshots` once another participant is staged (the reconcile tool is pairwise; a third Mac is a later version).

4. **Report.** The controller reports once the initiator's snapshot is staged and every requested Mac has staged, declined or been refused, or the window has ended; a migration whose initiator has not staged within `migration_wait_ms` of opening is abandoned (`expired`). The reconcile always uses the initiator's snapshot as its base (`initiator_and_other_staged`). With two snapshots it sends the initiator `MigrationReport` with the `reconcile_report` and its `reportSha256` (SHA-256 hex of the report's canonical JSON; `vectors.migration_report` is a worked example). With only the initiator's (`initiator_staged_alone`) there is nothing to reconcile: `report` and `reportSha256` are `null`. A reconcile that fails, or has not finished `migration_reconcile_ms` (10 minutes) after the migration entered `reconciling`, fails the migration (`reconcile_failed`). The report carries the earliest `holdUntil` of the Macs whose snapshots are staged, and its `expiresAt` is the earlier of `issuedAt + migration_decide_ms` (1 hour) and that `holdUntil - migration_commit_ms`; a report that would leave the owner no time is not sent and the migration is abandoned (`expired`), as `case.migration_report` pins. After `expiresAt` the migration is abandoned (`expired`).

5. **Choices.** The owner reviews the report on the initiator and the Mac sends `MigrationChoose` naming the `reportSha256` it showed, the paths to `drop` and the paths to `takeOther`. By default every one-sided file and both copies of a skill that differs are kept; a file in `replaced` — both Macs had it, with different bytes, and the reconcile could not merge it — keeps only the initiator's copy unless the owner takes the other Mac's with `takeOther`, so the report must show the owner every `replaced` path before the choice. The controller checks it as `case.migration_choose` does: the frame's signature, device, connection and epochs; a known migration of this agent (`unknown_migration`); sent by the initiator (`not_initiator`); the migration `reported` (`wrong_state`); received, by the controller's clock, no later than the report's `expiresAt` (`expired`; `decidedAt` is the Mac's claim and is not checked); the same `reportSha256` (`stale_report`); and every dropped path a `oneSided[].path`, or `skills/<name>` for a skill in `onlyBase`, `onlyOther` or a `bothKept[].otherName`; and every `takeOther` path a `replaced[].path` (`invalid_choice` for either; with no report, both lists must be empty). A refusal is `MigrationResult` `refused` and the migration stays `reported`, so the owner can choose again.

6. **Generation 1.** The controller applies the drops and the `takeOther` copies (the other Mac's file in place of the initiator's), exports the merged home and commits it with `atum.agent-home/1` `learn` from `expectedGeneration: 0` under its lease term for the agent. It holds the agent's answering lease only for the commit: it takes the lease after accepting the choice (`committing`; in `local` mode the lease is free once the Macs have quiesced) and releases it right after `learn`, or as soon as the migration fails; a lease it cannot take (`held: false`) fails the migration with `commit_failed`. So a failed migration never leaves the cloud holding the lease that the Macs' restored writers need. It sends `learn` only before `migration_commit_ms` (10 minutes) has passed since it accepted the choice, by its clock; a commit not done by then fails with `commit_failed`. A pointer that is no longer 0 fails the migration with `home_exists`: a migration never overwrites a cloud home.

7. **Result and switch.** The controller sends `MigrationResult` (`committed` with `homeGeneration: 1`, or `failed` / `abandoned` with a reason) to every Mac that offered or was requested, at once or on its next connection. Only after `committed` does the owner's Mac call the answering switch to `cloud`. A Mac puts its quiesced writers back as "The hold" says. `MigrationCancel` from any participating Mac (the owner cancelled, signed out or switched account) abandons a migration that is `collecting`, `reconciling` or `reported` (checked as `case.migration_cancel` does, below); once the owner has chosen, a cancel is refused `wrong_state` and the commit runs to `committed` or `failed`.

## The hold

A Mac's snapshot is its home at export, so anything the agent writes on that Mac afterwards is not in generation 1. The hold keeps those writers quiesced for as long as the controller may still commit, and the controller never commits after a Mac could have put them back.

**One deadline per migration.** When the controller admits the initiator's offer, the migration opens and its `holdUntil` is that moment, by the controller's clock, plus `migration_hold_ms` (90 minutes: `migration_wait_ms` + `migration_reconcile_ms` + `migration_decide_ms` + `migration_commit_ms`, the four deadlines in order). The initiator gets it in `MigrationAck` `send`; a participant gets the same value in its `MigrationRequest` and again in its own `send`. A request's `holdUntil` is no earlier than its `expiresAt` and no later than its `issuedAt + migration_hold_ms` (the frame's invariants), and every `send` stays within `migration_hold_ms` of the offer's receipt (`case.migration_offer`).

**The Mac.** It keeps the agent's writers quiesced from its export until a `MigrationResult` `failed` or `abandoned`, or until its own clock passes `holdUntil + skew_ms` (30 s), whichever comes first. It puts them back at once when its offer is refused (a `MigrationAck` `refused`, or a case step 2 treats as refused: the migration will not use that snapshot) and after its own `MigrationDecline`. On `committed` it leaves them quiesced until that same time; the initiator switches the agent to `cloud` meanwhile, and putting the writers back after the switch is harmless (`cloud-answering/1` fences the local entry points). The initiator keeps the hold it was given even if it re-offers on a new connection.

**The controller.** It never commits generation 1 after the earliest `holdUntil` of the Macs whose snapshots it staged: the report expires no later than that `holdUntil - migration_commit_ms` (and is not sent when that leaves the owner no time: the migration is abandoned, `expired`); it accepts a choice only up to the report's `expiresAt` (`case.migration_choose`); and it sends `learn` only within `migration_commit_ms` of accepting the choice (`commit_failed` after). `case.migration_report` pins the report's `expiresAt` and `holdUntil`, including a second Mac whose hold ends first, and a frame invariant holds every `MigrationReport` to `expiresAt <= holdUntil - migration_commit_ms`.

**What the hold does not cover.** A Mac that was offline when the result was sent and puts its writers back at `holdUntil` keeps anything it writes after that on that Mac only; if the result it then hears is `committed`, that is not in generation 1.

**Clock safety.** Absolute `holdUntil + skew_ms` expiry assumes the Mac keeps its clock within `skew_ms` of the controller. If it cannot ensure that, it MUST keep writers quiesced for at least `migration_hold_ms + skew_ms` measured on a monotonic clock from the latest `MigrationRequest` or `MigrationAck` `send` receipt, unless a refused offer, its own decline, or a failed/abandoned result ends the hold. A later frame never shortens the stored hold.

## Admitting an offer (the controller)

Every device migration frame (offer, decline, choose, cancel) is first checked the same way: the identity key of the connection's device service signed it (`bad_signature`); `deviceServiceId` is the connection's (`wrong_device`); `connectionId`, `enrollmentEpoch` and `accountEpoch` are current (`stale_connection`, `stale_enrollment`, `stale_account_epoch`). An offer then needs: an agent of this owner with a live, trusted cloud enrollment on this controller (`not_enrolled`); its home pointer at generation 0 (`home_exists`); the archive within `migration_archive_max_bytes` and `migration_files_max` (`too_large`); an unknown `migrationId` opens a migration only for an `initiator` (else `not_requested`); a known one must be this agent's and `collecting` (`migration_closed`), must not already hold this Mac's snapshot (`duplicate`), must match the Mac's role (the initiator, or a Mac it requested: `not_requested`), and a participant needs a free participant slot (`too_many_snapshots`). Otherwise `send`, with the migration's `holdUntil` (the initiator's offer that opens the migration sets it to the offer's receipt plus `migration_hold_ms`). The first failure is the answer. The `case.migration_offer` fixtures pin every step, and the authoring harness re-derives each expected outcome from this order, as it does for `case.migration_upload`, `case.migration_request`, `case.migration_choose`, `case.migration_cancel` and `case.migration_report`.

## Other frames

**Cancel (the controller).** After the four checks above, a `MigrationCancel` needs a known migration of this agent (`unknown_migration`), sent by its initiator or by a Mac it requested (`not_participant`), while the migration is `collecting`, `reconciling` or `reported` (`wrong_state`). Otherwise the migration is abandoned (`cancelled`) and every participating Mac gets `MigrationResult` `abandoned`; a refusal is `MigrationResult` `refused` and changes nothing. The `case.migration_cancel` fixtures pin every step.

**Decline (the controller).** A `MigrationDecline` passes the same four checks and counts only from a Mac the migration requested, while it is `collecting`; the controller ignores any other decline (a decline has no answer frame). A counted decline only lists that Mac in the report's `missing` with `declined`, which the owner sees before choosing, so it is pinned by its frame fixture rather than a case.

**Report (the controller).** The controller issues `MigrationReport` once collecting ends (one snapshot) or the reconcile finishes (two), as `case.migration_report` does: `holdUntil` is the earliest hold of the staged Macs, and `expiresAt` the earlier of `issuedAt + migration_decide_ms` and `holdUntil - migration_commit_ms`; when that is not after `issuedAt` the migration is abandoned (`expired`) instead, and every participating Mac gets `MigrationResult` `abandoned`.

**Controller frames (the Mac).** `MigrationAck`, `MigrationReport` and `MigrationResult` are signed by a controller key the Mac has pinned and arrive only on the Mac's current device connection; they carry no epochs. A Mac acts on one only for a migration it offered in or was requested for, and on a `MigrationAck` only when its `deviceServiceId` is the Mac's own; anything else is ignored. A `MigrationAck` `send` never shortens the stored hold: when its deadline differs from the request, the Mac keeps the later value and treats the mismatch as a controller defect. A `MigrationReport` is ignored if its `holdUntil` is later than the Mac's stored hold or its `expiresAt` is later than `holdUntil - migration_commit_ms`; an earlier report hold is allowed because another staged Mac can have an earlier deadline, and never shortens this Mac's writer hold. A repeat moves nothing, because the state it names is already reached. `MigrationRequest`, the one controller frame that starts work on a Mac, carries its target, connection and epochs and is checked as `case.migration_request` does. A Mac ignores a controller frame whose `type` it does not know, so a v1 Mac ignores `MigrationRequest`: the request expires and the report lists that Mac in `missing` as `expired`.

## Chunks

A migration chunk is a binary frame with the artifact chunk's layout: `u16 headerLength || utf8(canonicalJson(header)) || bytes`, big-endian, with a `migration_chunk.header` (`migrationId`, `offset`, `size`) and exactly `size` bytes. Chunks are sent in order from offset 0, contiguous, each at most `migration_chunk_max_bytes` and each whole frame within the hub's 1 MiB payload. They are unsigned: they ride the authenticated connection, and the signed offer's `bytes` and `sha256` are the integrity check. The controller refuses a chunk for another migration, out of order, or whose header size differs from its bytes (`chunk_invalid`), a total other than the offer's (`size_mismatch`) and a digest other than the offer's (`hash_mismatch`). A hub that accepts only v1 never sees one, because it never answers `send`.

## Staging and the reconcile sandbox

A staged archive is sealed at `v1/<owner>/<agent>/staging/<migrationId>/<deviceServiceId>/home.archive` under `atum.agent-home/1`'s per-agent key, object kind `staging`. The controller never deletes staging (the executor role has no `s3:DeleteObject`), including an abandoned migration's; its expiry is an S3 lifecycle rule that hosting owns. A staged archive is never hydrated as a home: the reconcile sandbox hydrates each archive into its own scratch home through the same allowlist, then runs `hermes_cli.atum_home reconcile` with the initiator's home as the base. The sandbox has no model grant, no egress grant and no network, and is stopped at `migration_reconcile_ms` ("The flow", step 4). Its `report.json` becomes the `reconcile_report` as `reconcile.report_mapping` sets out (maps become lists, `a`/`b` become `base`/`other`), and past the caps (128 memories, 64 per skill list, 256 one-sided paths) entries are counted in `omitted` and kept. `replaced` has no overflow: it lists every file the reconcile kept only the initiator's copy of (at most 16; the hydration allowlist has five such files today: `SOUL.md`, `cron/jobs.json`, `kanban.db`, `projects.db`, and `state.db` when its sessions are not merged). If more than 16 files would be `replaced`, reconciliation fails `reconcile_failed`; it never truncates the list or counts a replaced file in `omitted`. A file merged entry by entry is not listed (memory files, `cron/jobs.json` when merged by job id, `state.db` when its sessions merged), and neither is a file both Macs had with the same bytes. `--label-b` is a short name for the other Mac that the owner can recognise, `[A-Za-z0-9-]{1,24}` (the tool refuses anything else); it ends every `bothKept[].otherName`.

| Tool `report.json` | `reconcile_report` |
|---|---|
| `sessions` `{}` (no `state.db` on both) | `{merged: false, added: 0, skipped: 0, reason: "one_side"}` |
| `sessions` `{merged, added, skipped, reason?}` | the same |
| `memories` `{<path>: {addedFromB}}` | `[{path, addedFromOther}]`, sorted by path |
| `skills.bothKept` `[{a, b}]` | `[{name, otherName}]` |
| `skills.onlyA` / `skills.onlyB` | `skills.onlyBase` / `skills.onlyOther` |
| `oneSided` `[{path, side: a\|b, default}]` | `[{path, side: base\|other, default}]` |
| `replaced` `[{path, kept: a}]` | `[{path, kept: base}]` |

At those caps (and 16 `replaced` paths), with every path at agent-home's 512-byte limit and every byte escaped, the report frame is at most `reconcile.worst_case_report_frame_bytes`, under the hub's 1 MiB (the builder checks it). The report names the owner's own paths and skills and goes only to the owner's Mac, on the owner's device connection.

## Rollout

Nothing here changes a v1 frame, and 1.1 adds no negotiation. A v1 Mac never offers and ignores the controller frames it does not know ("Other frames"), so it works with a 1.1 hub unchanged; it is only listed in a report's `missing`. A Mac that offers needs a 1.1 hub, so the executor host runs a 1.1 controller before any desktop that offers is released (A-2 ships that desktop as 0.19.0). Because a Mac sends no bytes before `MigrationAck` `send`, an offer that reaches an older hub moves nothing. No SQL: the migration lives in the controller's state and in S3 staging, and generation 1 uses agent-home's existing `learn`.

## Routes

```
{
  "owner": {
    "native_base": "/api/matrix/v1",
    "operations": {
      "POST /device-services": [
        "enroll.request",
        "device_service.response"
      ],
      "GET /device-services": [
        null,
        "device_services.list.response"
      ],
      "DELETE /device-services/{deviceServiceId}": [
        null,
        "device_service.response"
      ]
    }
  },
  "public": {
    "GET /api/matrix/v1/cloud/controller-keys": [
      null,
      "controller_keys.response"
    ]
  },
  "controller": {
    "base": "/api/matrix/v1/cloud/controller",
    "operations": {
      "POST /devices": [
        "devices.list.request",
        "devices.list.response"
      ]
    }
  },
  "device_hub": {
    "url": "wss://devices.atumplatform.com/v1",
    "dev_fallback": "ws://127.0.0.1:<port>/v1 (dev builds only, SSM port forwarding)",
    "frames": "JSON text frames carrying one envelope each; binary frames only for artifact chunks (README §3.4)"
  }
}
```

## Messages

| Message | Direction | Fixtures |
|---|---|---|
| `frame.Hello` | device → controller | 1 accept, 1 reject |
| `frame.Challenge` | controller → device | 1 accept, 0 reject |
| `frame.Proof` | device → controller | 1 accept, 0 reject |
| `frame.Ready` | controller → device | 1 accept, 1 reject |
| `frame.TurnGrant` | controller → device | 2 accept, 2 reject |
| `frame.GrantAck` | device → controller | 2 accept, 0 reject |
| `frame.Execute` | controller → device | 2 accept, 3 reject |
| `frame.Renew` | controller → device | 1 accept, 0 reject |
| `frame.Receipt` | device → controller | 3 accept, 1 reject |
| `frame.StatusQuery` | controller → device | 1 accept, 0 reject |
| `frame.Status` | device → controller | 1 accept, 0 reject |
| `frame.Cancel` | controller → device | 1 accept, 0 reject |
| `frame.Revoke` | controller → device | 1 accept, 0 reject |
| `frame.Stop` | device → controller | 1 accept, 0 reject |
| `frame.OriginReceipt` | device → controller | 1 accept, 0 reject |
| `frame.Approve` | device, local only | 1 accept, 1 reject |
| `artifact_chunk.header` | device → controller | 1 accept, 0 reject |
| `enroll.request` | owner → DA | 2 accept, 1 reject |
| `device_service.response` | DA → owner | 1 accept, 1 reject |
| `device_services.list.response` | DA → owner | 1 accept, 0 reject |
| `controller_keys.response` | public | 1 accept, 0 reject |
| `devices.list.request` | controller → DA | 1 accept, 1 reject |
| `devices.list.response` | DA → controller | 1 accept, 0 reject |
| `error.response` | DA → any caller | 1 accept, 0 reject |
| `case.grant` | test vectors | 14 accept, 2 reject |
| `case.execute` | test vectors | 25 accept, 8 reject |
| `case.renew` | test vectors | 6 accept, 1 reject |
| `case.revoke` | test vectors | 4 accept, 1 reject |
| `case.approval` | test vectors | 7 accept, 1 reject |
| `case.enroll` | test vectors | 13 accept, 2 reject |
| `vectors.canonical` | test vectors | 1 accept, 0 reject |
| `vectors.hashes` | test vectors | 1 accept, 0 reject |
| `vectors.signatures` | test vectors | 1 accept, 0 reject |
| `vectors.public_keys` | test vectors | 1 accept, 0 reject |
| `frame.MigrationOffer` | device → controller | 2 accept, 2 reject |
| `frame.MigrationDecline` | device → controller | 1 accept, 0 reject |
| `frame.MigrationChoose` | device → controller | 1 accept, 2 reject |
| `frame.MigrationCancel` | device → controller | 1 accept, 1 reject |
| `frame.MigrationRequest` | controller → device | 1 accept, 3 reject |
| `frame.MigrationAck` | controller → device | 3 accept, 0 reject |
| `frame.MigrationReport` | controller → device | 2 accept, 4 reject |
| `frame.MigrationResult` | controller → device | 3 accept, 0 reject |
| `migration_chunk.header` | device → controller | 1 accept, 1 reject |
| `case.migration_offer` | test vectors | 20 accept, 3 reject |
| `case.migration_upload` | test vectors | 7 accept, 1 reject |
| `case.migration_request` | test vectors | 7 accept, 1 reject |
| `case.migration_choose` | test vectors | 15 accept, 3 reject |
| `case.migration_report` | test vectors | 5 accept, 4 reject |
| `case.migration_cancel` | test vectors | 8 accept, 1 reject |
| `vectors.migration_report` | test vectors | 1 accept, 0 reject |

## State machines

- **`ledger`**: states `not_started`, `started`, `completed`, `failed_no_effect`, `unknown`, `refused`; terminal `completed`, `failed_no_effect`, `unknown`, `refused`.
- **`connection`**: states `closed`, `hello_sent`, `challenged`, `ready`, `status_exchanged`; terminal (none).
- **`enrollment`**: states `absent`, `active`, `revoked`; terminal `revoked`.
- **`migration`**: states `collecting`, `reconciling`, `reported`, `committing`, `committed`, `failed`, `abandoned`; terminal `committed`, `failed`, `abandoned`.
- **`migration_snapshot`**: states `offered`, `receiving`, `staged`, `refused`, `discarded`; terminal `staged`, `refused`, `discarded`.

## Parameters (frozen)

```
{
  "admission_ms": 15000,
  "approval_ms": 60000,
  "heartbeat_ms": 5000,
  "authority_window_ms": 15000,
  "skew_ms": 30000,
  "dedupe_days": 7,
  "grant_max_ms": 1800000,
  "preauth_ms": 10000,
  "connections_per_ip_per_minute": 10,
  "max_payload_bytes": 1048576,
  "execute_per_second": 10,
  "execute_per_turn": 600,
  "protected_prompts_per_minute": 3,
  "denials_before_auto_refuse": 3,
  "status_max_commands": 256,
  "output_max_code_points": 65536,
  "artifact_max_bytes": 8388608,
  "artifacts_max": 16,
  "reconnect_backoff_min_ms": 1000,
  "reconnect_backoff_max_ms": 30000,
  "migration_archive_max_bytes": 545259521,
  "migration_files_max": 20000,
  "migration_snapshots_max": 2,
  "migration_chunk_max_bytes": 1048000,
  "migration_wait_ms": 600000,
  "migration_decide_ms": 3600000,
  "migration_reconcile_ms": 600000,
  "migration_commit_ms": 600000,
  "migration_hold_ms": 5400000
}
```

## Reserved migration numbers

- **0180** — WS-1: atum_private.device_services, atum_private.cloud_controller_signing_keys (reserved as 0176 in C0; renumbered because 0174-0177 were taken by other lanes).

1.1 adds no SQL and reserves no number: the migration is controller state plus S3 staging, and generation 1 is written through `atum.agent-home/1` `learn`.

## Conformance

A provider or consumer proves conformance in its own tests by loading this pack's fixtures: every `accept` fixture is produced or accepted, and every `reject` fixture is refused with the violation category its `contract.json` entry names. The two checkers here prove only that the pack is self-consistent; they are not a harness for any service. The `*.case.json`, `*.facts.json` and `*.vectors.json` fixtures are typed conformance evidence, not wire payloads.
