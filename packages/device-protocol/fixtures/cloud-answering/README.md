# `atum.cloud-answering/1`: per-agent answering mode, local fences, origin assertion and request digest v2

- **Row:** S1 C0 (one agent everywhere). Authored by the launch coordinator on 2026-10-04 as part of the one contracts PR (P-1).
- **Provider(s):** DA (WS-1): answering mode, local fences, request hash v2 at the ledger.
- **Consumer(s):** Desktop (WS-3b): mode, origin signing; CX controller (WS-2, WS-3a): origin verification, digest v2.
- **Status:** unmerged v1 candidate; frozen only when merged. `contract.json` uses the checker's `frozen` enum for a pin-ready candidate, not evidence of merge or deployment. It defines wire shapes, states and rules; it builds no route, migration, service or host and changes nothing in production.
- **Canonical JSON** is the one platform function, `packages/protocol/src/host-fs.ts` `canonicalJson` (NFC, sorted keys, no whitespace, safe integers). atum-app vendors this pack's fixtures with their pinned SHA under `packages/device-protocol/fixtures/<pack>/`.
- **Checked by** `pnpm verify:s1-contracts` (both `spec/_tools/contract_pack.*` checkers). Authored and re-checked by `spec/_tools/s1/author-packs.mjs`.

This pack freezes the wire shapes for **where an agent answers** and for **proving which Mac a message was typed at**. It is part of C0 of the "one agent everywhere" plan (S1 build plan §3.1, §3.2): the shapes six workstreams build against, with no route, migration or service of its own.

An agent answers either `local` (today's behaviour: a Mac holds the lease) or `cloud` (the hosted brain). Switching to `cloud` fences the five local-only entry points so a Mac can no longer lease, claim or begin for that agent; the shared `_selected` functions are never touched, so the six live agents and the default assistant keep working. A turn also carries a signed **origin assertion** inside the owner's encrypted message, binding it to the device service's identity key and to the Matrix device fingerprint, and a **request digest v2** over the whole canonical content.

## Answering mode and the local fences (§3.1)

`answering_mode` is `local` or `cloud` per agent. The owner sets it at `POST /api/matrix/v1/agents/{agentPrincipal}/answering` with `{mode, expectedMode}`; `cloud` needs an active trusted cloud enrollment, and `local` is allowed only when no queue item is `taken`.

Guards are added to exactly the five local-only public entry points (`local_entry_points`). In `cloud` mode a lease returns the unchanged `{held:false, reason:'not_eligible'}`, and a claim or begin raises `matrix_denied` with detail `cloud_answering`. The cloud path and the shared `_selected` functions are byte-identical to 0168. `local_fence.facts` fixtures pin exactly these outcomes.

## Origin assertion and request digest v2 (§3.2)

The assertion travels inline in the owner's Megolm-encrypted `m.room.message` content under `io.atum.origin`. It is signed with the device service's identity key (ES256) over `atum.origin.v1\u0000` plus the canonical assertion without `sig`. `assertionHash` is the unpadded base64url SHA-256 of those signed bytes.

Request digest v2 covers the whole content minus its top-level `io.atum.origin` key, canonicalized with the one platform `canonicalJson`. `dg` is its base64url SHA-256; the DA `requestHash` is the same bytes as 64 lowercase hex characters, so the 0168 regex still holds. The `digest.vectors` file carries worked v2 and v1 examples; `origin.case` fixtures pin the controller's seven-step verification order and every refusal.

## Routes

```
{
  "owner": {
    "native_base": "/api/matrix/v1",
    "operations": {
      "POST /agents/{agentPrincipal}/answering": [
        "answering.request",
        "answering.response"
      ]
    }
  }
}
```

## Messages

| Message | Direction | Fixtures |
|---|---|---|
| `answering.request` | owner → DA | 2 accept, 2 reject |
| `answering.response` | DA → owner | 1 accept, 0 reject |
| `answering.error` | DA → any caller | 3 accept, 0 reject |
| `agent_projection.entry` | DA → owner | 2 accept, 1 reject |
| `local_fence.lease_refusal` | DA → local executor | 1 accept, 0 reject |
| `local_fence.denied` | DA → local executor | 1 accept, 0 reject |
| `local_fence.facts` | test vectors | 6 accept, 2 reject |
| `origin.assertion` | owner device → controller (in the encrypted message) | 1 accept, 3 reject |
| `origin.content` | owner device → controller (in the encrypted message) | 1 accept, 0 reject |
| `digest.vectors` | test vectors | 1 accept, 0 reject |
| `origin.case` | test vectors | 20 accept, 4 reject |

## State machines

- **`answering_mode`**: states `local`, `cloud`; terminal (none).

## Parameters (frozen)

```
{
  "origin_skew_ms": 300000,
  "nonce_window_days": 7,
  "request_hash_hex_length": 64
}
```

## Reserved migration numbers

- **0179** — WS-1: answering_mode column, projection field, switch function, five local wrappers (reserved as 0174 in C0; renumbered because 0174-0177 were taken by other lanes).

No SQL ships in C0; these numbers are reserved so the lanes do not collide. If another lane lands first, renumber at merge — the migrations are additive and independent.

## Conformance

A provider or consumer proves conformance in its own tests by loading this pack's fixtures: every `accept` fixture is produced or accepted, and every `reject` fixture is refused with the violation category its `contract.json` entry names. The two checkers here prove only that the pack is self-consistent; they are not a harness for any service. The `*.case.json`, `*.facts.json` and `*.vectors.json` fixtures are typed conformance evidence, not wire payloads.
