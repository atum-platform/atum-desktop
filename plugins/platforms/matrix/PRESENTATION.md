# Atum presentation extension

Opt in on the Matrix plugin with `plugins.entries.platforms/matrix.settings.atum_presentation: true`.
Use `display.platforms.matrix.tool_progress: off` and `display.platforms.matrix.streaming: false` for this surface;
`display.interim_assistant_messages: true` enables the native commentary callback.
The extension owns the transient activity line; native gateway text progress must
be disabled to avoid publishing a second activity surface. A global
`display.tool_progress` (the desktop's `tool.start` events need it on) is also read by
the Matrix gateway when no per-platform value is set, which posts lines such as
"📚 Reading skill …" into the chat as messages; the desktop's narration settings
(`apps/desktop/shared/matrix-turn-style.ts`, `MATRIX_NARRATION_DISPLAY`) therefore
write `display.platforms.matrix.tool_progress: off` beside it.

This is a Matrix platform extension, selected by its existing `register_platform`
factory. It adds no tools, prompts, conversation messages, or model calls.
`pre_tool_call` contributes only a fixed tool category; general argument/result bodies never enter presentation. The native todo
completion contributes its bounded list only after forced egress redaction. Native gateway interim sends pass through Hermes's
forced egress redactor. Only private DM background turns get presentation.

Wire contracts: `atum.agent-turns/1.3` progress marker and `/1.4`
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

What the owner sees during a turn matches the desktop controller. Admission posts nothing:
the native read receipt and the native typing indicator (`m.typing`, refreshed for the whole
turn by the base adapter) say the agent is working. The extension never speaks in the agent's
place and posts no words of its own, in any language. The only text it sends is the agent's:
its redacted remarks and its redacted todo items. Native interim assistant messages pass
immediately through the native Matrix sender, preserving reply/thread metadata and delivery
receipts. Each remark remains a separate ordinary message, including repeated remarks and
remarks repeated in the final answer. Content length and formatting follow native Matrix
behavior. The Stop dispatch lock suppresses later remarks from stopped or ended turns.

The transient line appears only for a real step and says it as a code, never as prose. It is the
agent-turns/1.3 progress notice with an empty `body` and the agent-turns/1.5 descriptor
`io.atum.presentation: {version: 1, code, args}`:

| Step | Marker `kind`/`phase` | Descriptor |
| --- | --- | --- |
| A started tool in a category (web, read, write, run, delegate, look, draw; any other tool adds no line) | `todo`/`working` | `tool_activity {activity}` |
| About three minutes without a new step | `heartbeat`/`working` (`heartbeat: true`) | `heartbeat {elapsed_minutes}` (since the last real step) |
| Waiting for the owner's approval card | `device`/`waiting` | `approval_wait {}` |
| A `video_generate` call refused for want of the owner's video consent (`error_type: video_consent_required`) | `device`/`waiting` | `video_consent_required {}` |
| The todo list | `todo`/`working` | none: `body` is the agent's own items |

An answered approval returns the line to the step before it (A8); nothing says "continuing".
The desktop words each code in the reader's current language (`apps/desktop/shared/matrix-status-line-copy.ts`)
and shows the line in the typing row, not as a chat bubble. A desktop that does not know a code
shows `body`, which is empty, so it shows only the typing indicator: never raw JSON and never a
fixed English line. `approval_wait`, `video_consent_required` and the empty `body` are additive to
the frozen agent-turns/1.5 shape (whose `body` has a one-character minimum); the next contract minor
should record them. The approval card itself is the gateway's existing UI and is unchanged. For
`video_consent_required` the desktop also shows its one-time consent card in the conversation
(`docs/video-generation-consent.md`); only the tool result's closed `error_type` is read, never its
error text or prompt.

The gateway's own status text (compression, retry and allowance waits) reaches
`send_or_update_status` during a turn and is dropped there: it never enters the conversation.
A fallback answer and a protected Google route switch are facts for the owner, carried as
structured notices the desktop draws in its own words: the `subscription_fallback` notice (empty
`body`, replying to the answer) comes from the `post_api_request` response metadata, and the
`google_route_switched` notice is the Atum host's. The gateway's own long-running heartbeat and
retry notices are separate native features. Keep them off for this surface with
`display.platforms.matrix.long_running_notifications: false` and
`display.platforms.matrix.suppress_warning_notifications: true`, and turn the 👀/✅ reactions off
with `platforms.matrix.reactions: false`.

The short owner notices sent when no turn can run (intake paused, unreadable message) are written
in English and Vietnamese through `agent.i18n.owner_text`; `display.language: vi` (or
`HERMES_LANGUAGE=vi`) selects Vietnamese, anything else English.

Offline tests (no homeserver or model calls):
`scripts/run_tests.sh tests/plugins/matrix_presentation`.
