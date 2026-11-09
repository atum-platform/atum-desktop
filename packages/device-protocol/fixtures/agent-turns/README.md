# `atum.agent-turns/1.4`: acknowledge, keep working, transient progress

- **Row:** Owner direction 2026-10-20: agent chat should feel like Grok-bot / Dot (acknowledge, keep working, transient progress).
- **Base:** `atum.agent-turns/1.3` at `spec/agent-turns/v1.3`, pinned `65f298794a2a42208ac692c9c8ace8785df6554c864b86bbe1f8757a37f17369`. Every execution, requeue, authority, outcome and presentation rule from 1 through 1.3 remains unchanged unless a numbered amendment below says it supersedes one.
- **Scope:** presentation only. The durable turn ledger, claim, lease, fence, Stop and final `io.atum.result` remain authoritative.
- **Providers:** the Mac executor; the cloud controller.
- **Consumers:** atum-app desktop; atum-mobile; web and other Matrix clients.
- **Checked by:** `pnpm verify:s1-contracts` and the `@atum/protocol` agent-turns 1.4 tests.

The shape is Hermes's own gateway: `display.interim_assistant_messages` (interim remarks are real messages), a typing indicator kept alive for the whole turn, and `tool_progress` edited in place then removed (`cleanup_progress`).

## 1. Acknowledge: interim agent messages (A9)

The agent's first interim remark of a turn (Hermes `message.interim`) is posted as an ordinary `m.text` in the agent's private chat with the owner and carries `io.atum.interim: true`. It notifies like any message and stays in history. Later interim remarks that say something to the person are also real messages.

- redacted text only, produced by Hermes's own redaction; a publisher that did not receive redacted text publishes nothing (fail closed);
- at most one interim message per 20000 ms; a remark that arrives sooner is held (the newest held remark may publish when the gap opens) and a remark held when the turn ends is dropped;
- never a duplicate of the answer: a remark whose words repeat, or are contained in, the answer is dropped;
- body at most 1000 characters; private owner chat only (a group gets receipt and typing only);
- an interim message never carries `io.atum.result` or `io.atum.progress`, is never the answer for the 180000 ms no-reply banner, and a client may use the marker to tell it from the answer.

## 2. Typing (A10)

Typing is on from the moment the agent takes a message until its answer or a terminal status. It is renewed every 20000 ms inside the 30000 ms Matrix timeout. A Mac doing a step, slow or not, keeps typing on; it pauses only while the agent waits for the person (an approval, Touch ID, a clarifying question), the v1.1 `waiting` state. No status line exists merely to say "working".

## 3. One transient working line (A7, A8)

Tool activity (by category, never arguments or results), the todo checklist and every wait ("Waiting for the MacBook…", Touch ID, uploading) share the one `io.atum.progress` notice of 1.3 §2, edited in place and shown under the typing indicator as a light, muted row. An answered wait returns the line to its previous text; it never says "waited".

When the turn ends the line disappears:

- **publisher:** after the final answer text is known and queued edits are drained, the publisher redacts the progress root (a standard redaction of its own event) before it publishes the answer; later edits are dropped. This supersedes 1.3 A6, which kept the root collapsed to its last line.
- **client:** a client hides a progress line whose turn has ended even before the redaction lands. A turn has ended for a line once any later message from the same agent is neither a progress line nor an interim message (the answer, an outcome notice, a terminal status), or the line's marker says `phase: settled`. This also hides the settled lines of 1.3 and the retired fixed "waiting/waited for you on your Mac" status lines already in history. A hidden line stays hidden (`transient_line`: `hidden` is never followed by `visible`).
- **removed lines leave no trace:** a redacted message sent by an agent renders nothing (no "message deleted" tombstone): an agent removes only its own working lines and a duplicated interim remark. A redacted message from a person still renders as deleted.
- it never notifies, never reads "(edited)", never becomes the roster preview and never counts as an answer.

## 4. Answers and real outcomes (A11)

The answer is a new message and notifies. Only a real outcome persists as a notice: an unreachable Mac with the way out, out of Protons, trial ended, a routine that could not run, and the interrupted-work verification. Those are ordinary notices without `io.atum.progress`, so clients never hide them as transient.

## 5. Compatibility and security

Older clients render an interim message as a normal agent message, render a progress notice as the 1.3 notice and ignore `io.atum.interim`; a redaction removes a progress line for them too. Nothing here confers execution authority. As in 1.3, publishers apply Hermes redaction before publication; interim messages and the progress line carry no tool arguments, results, credentials or text from other rooms.
