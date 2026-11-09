# `atum.agent-routines/1.3`: import of old scheduled jobs

This frozen additive pack carries every `atum.agent-routines/1.2` fixture byte-for-byte. It adds one operation, `import`, to the controller executor command route (`POST /cloud/controller/executors/{id}/routines/commands`); the authority is migration 0252.

## Base and verification

The exact `/1.2` digest is pinned in `contract.json.base.sha256`. Rebuild or compare this pack with `node spec/agent-routines/author-pack-1-3.mjs --check`; the contract verifier runs both independent standard-library validators.

## `import`

A home that predates the routines list may still hold scheduled jobs. The cloud controller reads them from the home and sends them as drafts in one call (1 to 16 per call; `generation` is the home generation they were read from). Each draft is either a routine (`homeJobId`, `title`, `instruction`, a structured `schedule`, `timezone`, `notifications`, `enableOnClear`) or an unsupported job (`homeJobId`, `title`, `unsupportedReason`: the words for why the cloud cannot represent it). No cron string crosses the boundary.

The authority inserts every supported draft as a **disabled** routine and writes a durable receipt, in one transaction. The owner turns on the ones they want from the schedule list. The result names the routine created for each `homeJobId` (`imported`) and every job that was not turned into a routine (`skipped`, with `unsupported`, `invalid` or `quota` and a note); every draft appears exactly once, so nothing is dropped silently.

Import is idempotent per agent and `homeJobId`: a repeat (a new `requestId` after a crash, or a second controller) returns the first `routineId` and creates nothing; the same `requestId` with the same bytes replays the same result. `unsupported` and `invalid` are final and recorded; `quota` is not recorded, so a later call may import that job. The call is allowed while `legacyState` is `present` because it only adds disabled rows.

After the result the controller disables the named home jobs (`imported` and the final skips) so nothing runs twice; the next inventory report is then `clear`. A draft with `enableOnClear: true` is enabled at that moment, only while its routine is still disabled and unedited; the flag is then spent. `stale_generation` refuses a call whose `generation` is older than the latest inventory report: read the home again.
