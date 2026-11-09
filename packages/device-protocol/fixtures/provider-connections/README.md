# `atum.provider-connections/1`: account-wide subscription connections (R1: OpenCode Go)

- **Row:** Owner 2026-10-27 account-wide subscriptions, R1: OpenCode Go custody, model offer and subscription edge. Authored 2026-10-28 on `feat/subscriptions-r1`.
- **Providers:** Platform Shell POST /api/matrix/v1/provider-connections/connect (sealed custody); Platform Shell POST /api/provider-connections/opencode-go/v1/chat/completions (subscription edge); atum.provider_connection_connect/status/revoke/resolve/erase (migration 0335, service_role only).
- **Consumers:** desktop Settings and model picker; cloud controller and sandbox; model-choice/1.4; cloud-execution/1.13.
- **Status:** frozen when merged; never edited after. An amendment is a new version directory.
- **Boundary:** contract and synthetic fixtures only. It contains no real key, route activation or production row.
- **Checked by** `pnpm verify:s1-contracts` (both `spec/_tools/contract_pack.*` checkers).

## One key, every agent

The owner connects OpenCode Go once. The platform stores the key only as an AES-256-GCM envelope
sealed with a Shell-held key that never enters the database, the sandbox, the renderer, a log or
an error. The Shell opens it in memory for exactly one provider call. Every agent on the account
may then select a model from the server-owned catalogue (0 Protons).

The connect route carries the key once over TLS. After that the renderer reads only
`connection.status.response`, which has no credential-shaped field. A subscription turn reaches
the sandbox as `ATUM_MODEL_BASE_URL` (the platform subscription edge), `ATUM_MODEL_KEY` (an opaque,
turn-scoped grant token whose digest is stored) and `ATUM_MODEL_ALIAS` (the selected model). The
controller never sees the provider key.

## Revoke and failure

Revoke is owner-only, revision-fenced and immediate: it clears the sealed key in the same
transaction, aborts in-flight edge calls, and makes every live turn grant resolve `revoked`. A
revoked, disconnected or unavailable subscription is a clear failure. There is no silent Atum
fallback, and the managed Proton gateway refuses a subscription grant before any hold.

In-flight abort is per Shell process. The platform runs several Shell instances, so a call already
admitted by another instance finishes or is cut by the 120 s upstream timeout;
it can never start a new call, because every new call re-runs the grant and connection checks and
fails closed. This bound is accepted for R1; a shared abort channel is a later change.

## Replay bound

The sandbox presents only the opaque turn token, never a controller credential, so the edge cannot
bind a call to a controller. The token is instead counted: one turn may spend no more subscription
calls than its model-iteration budget, and the owner has an hourly edge budget shared by their
agents. The token is scoped to one owner, agent, invocation and model, and it dies with the grant;
a new turn never reuses it.

## R1 transport

The edge is OpenAI-compatible chat completions at `https://opencode.ai/zen/go/v1/chat/completions`,
non-streaming, at most 400000 request bytes and 16384
output tokens. MiniMax and Qwen models are intentionally absent: OpenCode Go serves them over
Anthropic Messages, which R1 does not implement. Adding them is a later contract version together
with that transport.

## Custody vectors

The conformance fixtures pin the never-defer controls: sealed at rest, absent from the renderer,
sandbox, logs and errors, absent from the controller except as an opaque turn token, zero Protons,
and no fallback. They are synthetic; no real credential is in this pack.
