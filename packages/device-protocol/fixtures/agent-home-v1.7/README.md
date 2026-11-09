# `atum.agent-home/1.7`: daily-cap warning and refusal statuses

- **Row:** Reliability-first program item 23 (D25/S18): daily-cap status codes. Authored on 2026-10-21.
- **Base:** `atum.agent-home/1.5` at `spec/agent-home/v1.5`, pinned `b38a219ed32f30038b2dfce363d3a8e62ac62e156ca48e750f262549948f9b1b`. Every 1.5 fixture is carried byte-for-byte; only the status-code enum widens.
- **Provider:** DA status/outbox authority. **Consumers:** cloud controller and desktop local executor.
- **Overlay:** 1.7 follows the 1.4 status line through 1.5 (2 GiB homes and claim liveness). It does not replace 1.6, the independent 1.3-line requeue overlay; a consumer needing both vendors both pins.
- **Checked by:** the S1 author drift check, both contract-pack checkers and `packages/protocol/test/agent-home-1.7.test.ts`.

The daily-cap slice posts one quiet line at 80% of an agent's day and refuses later work at 100%. Both are status rows in the existing outbox wire, so the only contract change is two new values of the closed status-code enum.

## 1. The two codes

`daily_cap_warning` is the one-time 80% notice. It is an ordinary status body: the agent's main conversation, `v: 1`, `kind: status`, a room id and this code. It closes nothing, so the turn that crossed 80% continues to its normal end.

`daily_cap` is the 100% refusal. The call that crossed the cap finishes; this status is then terminal for that message and later calls and turns are refused for the rest of the `Asia/Ho_Chi_Minh` day. Its body has the same shape as every other status; the copy and the cap numbers are rendered by the active runtime, not carried as raw ids.

Neither code is `couldnt_confirm` and neither changes the queue or outbox machines. A cap of `0` means uncapped and emits neither code.

## 2. Routines and delivery

A scheduled occurrence refused by the cap is not dispatched; it records `skipReason: daily_cap` and contributes one summary line, not one line per occurrence.

Exactly one runtime posts the 80% line: the cloud controller's outbox for a cloud turn, or the desktop's status sender for a Mac turn. The platform's notice claim is keyed `daily-cap-notice:<agent>:<YYYY-MM-DD>:eighty_percent`; a runtime posts only a claimed notice and records the key, so a replay does not duplicate it. The 100% refusal status belongs to its message and needs no separate key.

## 3. Rollout

The codes are additive: an older consumer that does not know them must keep the message pending rather than fail the turn, and a platform may emit them only after its consumer list includes this pack. Cap enforcement and the notice claim are platform behavior and land separately; this pack changes no SQL, route, parameter or flag.

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
