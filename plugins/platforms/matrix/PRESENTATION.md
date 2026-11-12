# Atum presentation extension

Opt in on the Matrix plugin with `plugins.entries.platforms/matrix.settings.atum_presentation: true`.
Use `display.platforms.matrix.tool_progress: off` and `display.platforms.matrix.streaming: false` for this surface;
`display.interim_assistant_messages: true` enables the native commentary callback.
The extension owns the transient activity line; native gateway text progress must
be disabled to avoid publishing a second activity surface.

This is a Matrix platform extension, selected by its existing `register_platform`
factory. It adds no tools, prompts, conversation messages, or model calls.
`pre_tool_call` contributes only a fixed tool category; general argument/result bodies never enter presentation. The native todo
completion contributes its bounded list only after forced egress redaction. Native gateway interim sends pass through Hermes's
forced egress redactor. Only private DM background turns get presentation.

Wire contracts: `atum.agent-turns/1.3` progress marker, `/1.4` interim and
transient removal; `io.atum.turn` is a lowercase UUID v4 string. The final answer
uses native Matrix delivery; the durable-intake lane's `txn_id` and delivery
obligation remain authoritative. This module neither ingests nor acknowledges
owner messages. Its separate profile-local SQLite outbox stores presentation
intents before each network call. Reconnect resolves ambiguous sends with the
same transaction and removes old progress roots. Network failures defer recovery
until reconnect while releasing the startup barrier. Re-admitting the same source
creates a fresh presentation attempt, keeping the source and answer marker stable.
Pending writes keep their original transaction across retries. Completed outbox
receipts expire after seven days at turn cleanup and reconnect. Unresolved writes
and live progress roots are retained until reconciled.

Before the G1 native stable-transaction send seam is assembled, enable this extension
only for unencrypted DMs. Its compatibility transport sends short plaintext
presentation events directly and cannot perform native E2EE key-sharing recovery.
Final answers continue through native Matrix delivery.

Activity revisions stop at 47, reserving revision 48 as in the progress kernel.
The 1.4 transient lifecycle redacts the root directly at completion. It has no
settled edit. Only the native final-ledger bracket (or G1 delivery-obligation
metadata) ends presentation before dispatch. Approval and other mid-turn sends
keep the line active. Stop and final dispatch share a lock, so a Stop accepted
before dispatch suppresses the answer. An already-dispatched transport write may
finish before Stop acquires that lock.

Native `/stop` uses Hermes's own gateway interrupt. The `agent_loop_stopped`
observer cancels presentation timers and removes progress. For a source-targeted
Stop integration, `stop_presentation_turn(room, source_event, authenticated_sender, authenticated=True)`
checks the active source and original owner, calls the same native interrupt,
and removes the line. The authenticated Shell/host integration must also close
the G14 operation context. Today's app `cloud-stop` HTTP call does not itself
emit a Matrix Stop event; that wiring remains the S2 host/client integration.
The default `authenticated=False` rejects calls. Pass `True` only after validating
the transport principal, and derive the sender from that principal. Do not map a
caller-supplied authentication flag into this argument. Do not expose this Python
entry point directly as an unauthenticated endpoint.

Offline tests (no homeserver or model calls):
`python3 -m unittest discover -s tests/plugins/matrix_presentation -v`.
