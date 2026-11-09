# `atum.agent-home/1.8`: silent delivery for answered routine occurrences

- **Row:** Background follow-up sweep: useful routine occurrences may complete without Matrix delivery. Owner-approved on 2026-10-24.
- **Base:** `atum.agent-home/1.7` at `spec/agent-home/v1.7`, pinned `11b09a50411bf5421de6b086c47a833e4f9512050b33138bc63bd9810b05968b`. Every 1.7 fixture is carried byte-for-byte.
- **Provider:** DA agent-home transaction. **Consumer:** cloud controller after explicit profile negotiation.
- **Checked by:** the S1 author drift check, both contract-pack checkers and `packages/protocol/test/agent-home-1.8.test.ts`.

Routine work can be useful without producing a Matrix message. The run is still answered; only its delivery disposition is silent.

## 1. Strict commit union

The existing delivered commit forms are unchanged and require `outbox`. The new form requires `occurrenceId`, `outcome: "answered"` and `delivery: "silent"`, and forbids `outbox`. It is invalid for ordinary Matrix turns, follow-ups and every non-answered outcome.

## 2. Atomicity, replay and accounting

Silent commit completes the occurrence, advances the optional home pointer, records the disposition and finishes the queue item in the same transaction. It creates no outbox row and needs no `published` call. A same-disposition replay returns the original transaction and home generation; a delivered/silent mismatch conflicts.

The occurrence outcome remains `answered`, so existing answered billing and routine-history semantics are unchanged. Routine-run reads expose `deliveryDisposition` when the platform recorded one.

## 3. Controller requirement: a refused silent commit is never dropped

A silent commit can be refused after the run produced its result: a stale lease token or lease generation, a wrong `expectedGeneration`, an occurrence the watchdog already ended `uncertain`, or an owner Stop. The platform then changes nothing and the queue item stays dispatched. On `matrix_conflict` / `wrong_state` the controller MUST fall back to an ordinary delivered commit (with its outbox) or to its existing stop/uncertain handling; it MUST NOT drop the run or treat the refusal as success.

A silent completion also ends the occurrence's invocation claim window at commit time, so the unpublished completion is not counted as busy by the cloud-to-Mac move checks.

## 4. Negotiation and rollout

A controller sends the new variant only after negotiating exact profile `atum.agent-home/1.8`. Platform migration 0275 lands before controller activation. Older controllers keep sending the unchanged delivered form and remain compatible.

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
| `agent.commit.request` | controller → DA | 5 accept, 8 reject |
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
| `outbox.body` | controller → its own store | 11 accept, 6 reject |
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

No SQL ships in C0; these numbers are reserved so the lanes do not collide. If another lane lands first, renumber at merge — the migrations are additive and independent.

## Conformance

A provider or consumer proves conformance in its own tests by loading this pack's fixtures: every `accept` fixture is produced or accepted, and every `reject` fixture is refused with the violation category its `contract.json` entry names. The two checkers here prove only that the pack is self-consistent; they are not a harness for any service. The `*.case.json`, `*.facts.json` and `*.vectors.json` fixtures are typed conformance evidence, not wire payloads.
