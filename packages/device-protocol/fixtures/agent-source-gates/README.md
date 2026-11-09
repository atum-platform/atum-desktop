# Agent source gates v1

`atum.agent-source-gates/1` is the private owner-to-platform synchronization contract for the six existing source opt-outs: `google`, `folders`, `messages`, `browser`, `location`, and `team_spaces`. It creates no per-source enrollment or permission grant. An absent platform row projects revision zero with every gate ON; an explicit false wins for every descriptor that names that gate.

The owner reads one complete snapshot and writes one complete snapshot with an exact expected revision and idempotent request ID. A stale `expectedRevision` returns HTTP 409 with the frozen `gate.write-conflict` body and current snapshot. Unknown, missing, or non-boolean gate keys are rejected rather than ignored. Revisions are safe nonnegative integers and every request/response is bounded to 4,096 encoded bytes.

Gate revision is private authority data. Runtimes continue consuming the unchanged `atum.agent-sources/1` access snapshot and `atum.agent-sweep/2` occurrence messages.

Protocol release: `@atum/protocol` 0.7.57.
