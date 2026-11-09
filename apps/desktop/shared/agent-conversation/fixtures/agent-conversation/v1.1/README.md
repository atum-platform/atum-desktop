# `atum.agent-conversation/1.1`: text amendment to `atum.agent-conversation/1` (no wire change)

- **Row:** 0.20 shave-down §2d and §3 step 3-4 (owner decision D1, 2026-10-09; owner, 2026-10-10). Authored on 2026-10-10 on the platform's 0.20 branch.
- **Base:** `atum.agent-conversation/1` at `spec/agent-conversation/v1`, pinned `7480613655e28360b6fba428e8306084d9b627bd27c5e0feebf65560d4a1455e`. That pack is merged and frozen and is not edited; this directory records its amendment beside it.
- **Wire: unchanged.** The marker, the per-Mac version record and every fixture are the base's. Whatever conforms to `/1` conforms to `/1.1`. A consumer vendors 1.1 in place of the base and records it in its `VENDORED.json`.
- **Status:** unmerged 1.1 candidate; frozen when merged, and never edited after.
- **Checked by** `pnpm verify:agent-conversation-contract` (both `spec/_tools/contract_pack.*` checkers). Authored and re-checked by `spec/_tools/s1/author-packs.mjs`, which re-derives the base pin from the base's own files.

## A1. The plain replacement needs every Mac on 0.20.0

From 0.20 a new assistant room is a plain (unencrypted) Matrix room. Replacing an agent's encrypted main with a new plain main uses the base's existing replacement path: create the room, write `main` on it, then `earlier` on the old room, then repoint scheduled jobs and restart Hermes once. A 0.19 desktop cannot open a plain room, so before that replacement every active macOS device in the owner's registry, online or not, must report `0.20.0` or later in its `io.atum.app_version.<deviceServiceId>` record. A missing or invalid report fails the gate, exactly as the base says. Comparison stays numeric semver.

The base's 0.19.0 floor is unchanged for every other marker write (silent marking, migration, make-main). A cloud-capable agent also still needs its enrollment's `conversationReady` before the move.

## What does not change

Everything else in the base: the marker shape and owner-sender rule, the resolver, sweep, ranking, migration state machine and rollback, the per-Mac record shape, and all 88 fixtures. The amendment is also listed in `contract.json` `amendments`.
