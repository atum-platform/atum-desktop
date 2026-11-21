# Native admitted-turn continuation

A provider plugin can lease a profile-local continuation adapter through
`PluginContext.register_native_turn_recovery(provider, adapter)`.

`bind_turn(agent, row)` is a context manager around the ordinary admitted gateway
turn. It installs `RequestCheckpoint` and, on recovery, `_request_resume` using
`agent.turn_checkpoint.validate_turn`. Capture occurs at the native prepared
request boundary. Consumption is committed before response hooks, streaming
consumers or tool effects. The adapter must fail closed if its mandatory snapshot
cannot be captured. It must restore cached-agent attributes on exit. A read-only saved response can
be supplied through `_request_recovery_response(request_id, semantic_request)`.
This runs inside `checkpointed_call` before transport dispatch and consumption.
Returning None selects normal transport. A recovered request must raise if its
saved reply cannot be authenticated, and must never use None as a failure fallback.

`recover(db, row)` authenticates an existing invocation using read-only retrieval.
It returns `checkpoint_key` and the exact `checkpoint_raw` it validated, or None.
It must never submit inference. Startup checks the current native transport route
and sender before invoking this adapter. A transaction compares the admission,
owner epoch, generation and checkpoint bytes before requeuing the same admission.
Ordinary FIFO preclaim authorization still runs. A consuming checkpoint cannot be
requeued. Existing unknown admissions without such proof keep their current fence.

Provider snapshot errors cross gateway error-to-text handlers as
`NativeContinuationPending`. The authority persists unknown execution and stops
the FIFO. It creates no terminal model answer. Successful continuation returns
through normal result persistence, settlement and the delivery ledger. Matrix
publication retains the ledger's stable transaction identifiers.

The provider owns authenticated result lookup, invocation identity and binding.
Native adapters can opt into repeated pending-request reclaim with
`RequestCheckpoint(..., recovery_limit=None)`. The default managed-surface limit
remains one. Each reclaim changes the writer owner using compare-and-swap. Death
after consumption and before a new pending checkpoint or terminal settlement
remains uncertain and requires resolution.

## Quiet failures for embedded agents (2026-11-21)

- `agent/turn_recovery_autorecover.py`: the automatic recovery ladder now also covers
  `upstream_rate_limit` (a provider saying it is briefly rate-limited upstream), so the
  turn waits and retries (15/30/60/60/60 s, `Retry-After` honoured) instead of ending after
  three quick attempts. Account and plan rate limits stay out: they can outlast the ladder.
- With the embedder flag `agent.atum_instructions: true`, the chat-facing copy for retries
  exhausted and for the failed-turn boundary reads as first-person sentences, with no slash
  commands, CLI hints, provider dumps or links. The boundary row keeps the upstream notice in
  `api_content`, so what providers replay is unchanged. Without the flag every surface keeps
  the upstream copy byte for byte.
- Busy acknowledgements stay native: embedders silence them with `display.busy_ack_enabled:
  false` in `config.yaml`.
- Verified: `scripts/run_tests.sh` on the failed-turn copy, auto-recovery, ACP closure,
  gateway failed-turn writer and duplicate/incomplete/restart tests (8 files, 75 passed,
  6 platform skips).
