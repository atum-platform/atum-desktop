# Atum presentation extension

Opt in on the Matrix plugin with `plugins.entries.matrix.settings.atum_presentation: true`.
Use `display.tool_progress: off` and `display.streaming: false` for this surface;
`display.interim_assistant_messages: true` enables the native commentary callback.
The extension owns the transient activity line; native gateway text progress must
be disabled to avoid publishing a second activity surface.

This is a Matrix platform extension, selected by its existing `register_platform`
factory. It adds no tools, prompts, conversation messages, or model calls.
`pre_tool_call` contributes only a fixed tool category; argument/result bodies
never enter presentation. Native gateway interim sends pass through Hermes's
forced egress redactor. Only private DM background turns get presentation.

Wire contracts: `atum.agent-turns/1.3` progress marker, `/1.4` interim and
transient removal; `io.atum.turn` is a lowercase UUID v4 string. The final answer
uses native Matrix delivery; the durable-intake lane's `txn_id` and delivery
obligation remain authoritative. This module neither ingests nor acknowledges
owner messages. Its separate profile-local SQLite outbox stores presentation
intents before each network call. Reconnect resolves ambiguous sends with the
same transaction and removes old progress roots before recovery is complete.
Recovery requires a working homeserver connection, as does any Matrix redaction.

Native `/stop` uses Hermes's own gateway interrupt. The `agent_loop_stopped`
observer cancels presentation timers and removes progress. For a source-targeted
Stop integration, `stop_presentation_turn(room, source_event, authenticated_sender)`
checks the active source and original owner, calls the same native interrupt,
and removes the line. The authenticated Shell/host integration must also close
the G14 operation context. Today's app `cloud-stop` HTTP call does not itself
emit a Matrix Stop event; that wiring remains the S2 host/client integration.
Do not expose this Python entry point directly as an unauthenticated endpoint.

Offline tests (no homeserver or model calls):
`python3 -m unittest discover -s tests/plugins/matrix_presentation -v`.
