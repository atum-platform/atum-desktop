# `atum.workspace-transactions/1`: the workspace grant, broker operations and transaction manifest

- **Row:** S1 C0 (one agent everywhere). Authored by the launch coordinator on 2026-10-04 as part of the one contracts PR (P-1).
- **Provider(s):** DA SQL and the Drive broker (WS-5p): cloud_workspace_grants, cloud_workspace_tasks, the ws_* operations.
- **Consumer(s):** CX controller (WS-5a): WorkspaceSession; Desktop device (WS-5a): WorkspaceCopies.
- **Status:** unmerged v1 candidate; frozen only when merged. `contract.json` uses the checker's `frozen` enum for a pin-ready candidate, not evidence of merge or deployment. It defines wire shapes, states and rules; it builds no route, migration, service or host and changes nothing in production.
- **Canonical JSON** is the one platform function, `packages/protocol/src/host-fs.ts` `canonicalJson` (NFC, sorted keys, no whitespace, safe integers). atum-app vendors this pack's fixtures with their pinned SHA under `packages/device-protocol/fixtures/<pack>/`.
- **Checked by** `pnpm verify:s1-contracts` (both `spec/_tools/contract_pack.*` checkers). Authored and re-checked by `spec/_tools/s1/author-packs.mjs`.

This pack freezes how a cloud turn publishes files to Atum Drive (S1 build plan §3.6): the owner's workspace grant, the controller's `ws_*` broker operations, and the transaction manifest. DA SQL and the Drive broker (WS-5p) provide it; the controller and the device (WS-5a) consume it. C0 data only.

A task is a transaction, not a blind write. Every hydrated input is a read dependency; outputs are staged, dependencies re-checked, then placed conditionally. If any input changed, outputs are written as **siblings**, never overwrites. There is never a retry — `unknown` is terminal — and deletions and renames are proposed and reported, not applied.

## The grant and the broker operations

The owner creates a grant at `POST /api/matrix/v1/cloud/workspaces {agentPrincipal}`; the broker runs CS3 `CreateContainer` in the owner's personal space under a label such as `/Agents/T`. Each use binds to the agent's live cloud lease, not a time window. `ws_manifest` is a bounded recursive list (5,000 entries, depth 16) that applies the engine exclusion list; `ws_read` is ETag-pinned; `ws_stage` is `if_not_exist`; `ws_commit` re-Stats every dependency and then places files or siblings. Writes to an excluded name are refused.

## Placement and the transaction manifest

The `placement.vectors` file is the worked decision table: `create` with no server file places; a server conflict or any changed input becomes a sibling named `"<name> (T <yyyy-mm-dd> <task8>)<.ext>"`; `replace` needs a matching base ETag. The `transaction.manifest` records the inputs (with their local dirty state and device revision), `inputManifestHash`, the outputs and their placement, proposed deletions, the dependency check and the result. The engine excludes `.atum/` from sync, so the manifest can be kept at `<ws>/.atum/tasks/<taskId>.json` as well as a controller artifact.

## Routes

```
{
  "owner": {
    "native_base": "/api/matrix/v1",
    "operations": {
      "POST /cloud/workspaces": [
        "grant.request",
        "grant.response"
      ]
    }
  },
  "controller": {
    "base": "/api/matrix/v1/cloud/controller",
    "operations": {
      "POST /executors/{executorId}/files": [
        "ws_manifest",
        "ws_read",
        "ws_stage",
        "ws_commit",
        "ws_place"
      ]
    }
  }
}
```

## Messages

| Message | Direction | Fixtures |
|---|---|---|
| `grant.request` | owner → DA | 1 accept, 1 reject |
| `grant.response` | DA → owner | 1 accept, 0 reject |
| `ws_manifest.request` | controller → DA | 1 accept, 0 reject |
| `ws_manifest.response` | DA → controller | 1 accept, 0 reject |
| `ws_read.request` | controller → DA | 1 accept, 0 reject |
| `ws_stage.request` | controller → DA | 1 accept, 0 reject |
| `ws_stage.response` | DA → controller | 1 accept, 0 reject |
| `ws_commit.request` | controller → DA | 1 accept, 2 reject |
| `ws_commit.response` | DA → controller | 4 accept, 0 reject |
| `ws.error` | DA → any caller | 3 accept, 0 reject |
| `transaction.manifest` | controller → its own store | 2 accept, 1 reject |
| `placement.vectors` | test vectors | 1 accept, 0 reject |

## State machines

- **`transaction`**: states `open`, `staged`, `checking`, `committed`, `committed_with_siblings`, `stale_inputs`, `unknown`; terminal `committed`, `committed_with_siblings`, `stale_inputs`, `unknown`.

## Parameters (frozen)

```
{
  "manifest_max_entries": 5000,
  "manifest_max_depth": 16,
  "outputs_max": 16,
  "output_max_bytes": 33554432,
  "total_max_bytes": 67108864,
  "put_timeout_ms": 120000,
  "hydrate_max_bytes": 67108864,
  "hydrate_max_files": 2000
}
```

## Reserved migration numbers

- **0178** — WS-5p: cloud_workspace_grants, cloud_workspace_tasks, the ws_* SQL operations gated by the live lease.

No SQL ships in C0; these numbers are reserved so the lanes do not collide. If another lane lands first, renumber at merge — the migrations are additive and independent.

## Conformance

A provider or consumer proves conformance in its own tests by loading this pack's fixtures: every `accept` fixture is produced or accepted, and every `reject` fixture is refused with the violation category its `contract.json` entry names. The two checkers here prove only that the pack is self-consistent; they are not a harness for any service. The `*.case.json`, `*.facts.json` and `*.vectors.json` fixtures are typed conformance evidence, not wire payloads.
