# `atum.agent-home/1.5`: 2 GiB homes and live dispatched claims

- **Row:** Limits release slice 6: 2 GiB agent homes and live dispatched claims. Authored on 2026-10-20.
- **Base:** `atum.agent-home/1.4` at `spec/agent-home/v1.4`, pinned `a0c58df53cea1e667a3035afbe2c790eb4b0b2faf74e28d685bed4a574fa7915`. Every v1.4 fixture is carried byte-for-byte.
- **Provider:** DA home and invocation authority. **Consumers:** cloud controller and desktop local executor.
- **Checked by:** the S1 author drift check, both contract-pack checkers, protocol mirror tests and migration 0255's service-role pgTAP.

Agent homes may now contain up to 2 GiB while keeping the existing 20,000-file and 512-byte-path bounds. A dispatched local turn may also send the optional heartbeat operation; each accepted heartbeat re-arms the same fence for the existing 120-second claim lifetime.

## 1. Widened home bound

`home_max_bytes`, the hydration byte cap, `home_ref.sizeBytes`, each manifest file's size and the home response ceiling widen from 536,870,912 to 2,147,483,648 bytes. Smaller homes and every previous manifest remain valid.

The file-count, path, allowlist, sealing, generation and ownership rules do not change.

## 2. Optional claim heartbeat

`POST /api/matrix/v1/local-hermes/invocations` accepts `operation: heartbeat` only with the existing room, event, request hash, sender device, executor and invocation fence. It is accepted only while that same fence is dispatched. DA returns the usual grant with the same fence and sets `expiresAt` to the lesser of the executor session end and 120 seconds from now.

A current client sends a heartbeat every 30 seconds while a long automatic turn is running. A failed heartbeat is retried only until the last acknowledged claim expires; then the run is stopped and follows normal settlement. A silent holder becomes recoverable no later than 120 seconds after its last accepted heartbeat. Older clients send no heartbeat and keep the previous behavior unchanged.

## 3. Rollout and rollback floor

Apply migration 0255 before deploying a controller or desktop that can persist a home above 512 MiB. The heartbeat itself is capability-compatible: a new client that meets an older platform keeps the prior static claim deadline when its first heartbeat is refused.

Rollback first stops new clients from writing larger homes, proves no stored home exceeds 512 MiB, then restores the prior bounds and invocation body.

## Routes

```
{
  "controller": {
    "base": "/api/matrix/v1/cloud/controller",
    "operations": {
      "POST /agent": [
        "agent.abandon.request",
        "agent.commit.request",
        "agent.dispatched.request",
        "agent.enqueue.request",
        "agent.home.request",
        "agent.learn.request",
        "agent.outbox.request",
        "agent.published.request",
        "agent.receipt.request",
        "agent.release.request",
        "agent.take.request",
        "agent.wake.request"
      ]
    }
  }
}
```

## Messages

| Message | Direction | Fixtures |
|---|---|---|
| `agent.enqueue.request` | controller → DA | 4 accept, 2 reject |
| `agent.enqueue.response` | DA → controller | 2 accept, 0 reject |
| `agent.receipt.request` | controller → DA | 1 accept, 0 reject |
| `agent.wake.request` | controller → DA | 1 accept, 0 reject |
| `agent.wake.response` | DA → controller | 1 accept, 0 reject |
| `agent.take.request` | controller → DA | 1 accept, 0 reject |
| `agent.take.response` | DA → controller | 4 accept, 2 reject |
| `agent.dispatched.request` | controller → DA | 1 accept, 0 reject |
| `agent.release.request` | controller → DA | 1 accept, 0 reject |
| `agent.commit.request` | controller → DA | 4 accept, 4 reject |
| `agent.commit.response` | DA → controller | 1 accept, 0 reject |
| `agent.learn.request` | controller → DA | 1 accept, 1 reject |
| `agent.learn.response` | DA → controller | 1 accept, 0 reject |
| `agent.abandon.request` | controller → DA | 2 accept, 0 reject |
| `agent.abandon.response` | DA → controller | 2 accept, 0 reject |
| `agent.outbox.request` | controller → DA | 1 accept, 0 reject |
| `agent.outbox.response` | DA → controller | 2 accept, 0 reject |
| `agent.published.request` | controller → DA | 1 accept, 0 reject |
| `agent.home.request` | controller → DA | 1 accept, 0 reject |
| `agent.home.response` | DA → controller | 3 accept, 1 reject |
| `agent.ok.response` | DA → controller | 1 accept, 0 reject |
| `agent.error` | DA → any caller | 3 accept, 0 reject |
| `home.manifest` | controller → its own store | 3 accept, 4 reject |
| `outbox.body` | controller → its own store | 9 accept, 6 reject |
| `hydration.vectors` | test vectors | 1 accept, 0 reject |
| `stop.vectors` | test vectors | 1 accept, 0 reject |
| `access.status.vectors` | test vectors | 1 accept, 0 reject |
| `claim.heartbeat.request` | local executor → DA | 2 accept, 2 reject |
| `claim.liveness.vectors` | test vectors | 1 accept, 0 reject |

## State machines

- **`queue_item`**: states `queued`, `waiting_device`, `taken`, `done`, `dropped`; terminal `done`, `dropped`.
- **`outbox_row`**: states `committed`, `published`; terminal `published`.

## Parameters (frozen)

```
{
  "live_items_per_agent": 100,
  "live_items_per_owner": 200,
  "claim_ms": 120000,
  "home_max_bytes": 2147483648,
  "home_max_files": 20000,
  "home_path_max_bytes": 512,
  "quiesce_max_ms": 60000,
  "outbox_body_max_bytes": 2097152,
  "claim_heartbeat_ms": 30000
}
```

## Reserved migration numbers

- **0181** — WS-1: occurrences per atum.cloud-execution/1 §9 (claim/dispatch/complete/published at /cloud/controller/occurrences), which enqueue into this pack's queue (reserved as 0177 in C0).
- **0182** — WS-1: cloud_agent_queue, cloud_agent_home, cloud_agent_home_history, cloud_agent_outbox, atum.cloud_controller_agent (reserved as 0175 in C0; after 0180 and 0181, which it references).

Migration 0255 widens the two home table constraints and home-reference validator, and adds heartbeat re-arming to the existing invocation authority. It performs no data rewrite.

## Conformance

A provider or consumer proves conformance in its own tests by loading this pack's fixtures: every `accept` fixture is produced or accepted, and every `reject` fixture is refused with the violation category its `contract.json` entry names. The two checkers here prove only that the pack is self-consistent; they are not a harness for any service. The `*.case.json`, `*.facts.json` and `*.vectors.json` fixtures are typed conformance evidence, not wire payloads.
