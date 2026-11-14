# Native turn admission and source control

This contract extends the existing `pre_turn_admission` plugin hook and local
gateway control socket. It adds no model tool, network listener, or prompt data.

## Admission execution binding

The bounded hook still runs on its isolated worker. An allowing callback may
return a **lazy**, zero-argument synchronous context-manager factory:

```python
def admit(**payload):
    if payload['stage'] != 'turn':
        return True  # preparation validates only; allocate no execution resources
    return {'allow': True, 'enter': lambda: execution_binding(payload)}
```

The factory must defer acquisition, ContextVar writes and resource ownership to
its context manager's `__enter__`. Do not enter a binding on the admission worker.
`check_turn_admission` returns `None` for plain allowance, a native refusal dict
for denial, or an in-process `AdmissionBindings` for allowance with factories.
The native turn calls `admission_context(decision)` in the **turn's own context**;
it enters factories in registration order, exits in reverse order on every exit,
and never stores these objects in history, a journal, a tool schema or a response.

Only `stage='turn'` accepts factories. Preparation stages are decision-only.
Every callback must allow before any factory enters. An invalid factory or entry
failure refuses the turn with `turn_exit_reason='admission_denied'`; no tool runs.
An entry failure unwinds prior entries. Body exceptions/Stop still unwind bindings.
Bindings must not suppress body exceptions. Plain `True`/`{'allow': True}` remains
backward compatible. Timed-out or denied decisions never enter a factory.

## Native source identity in the hook payload

Alongside existing `stage`, `turn_id`, `platform`, `session_id`, `task_id`,
`parent_session_id`, `user_message` and `turn_author`, native checks carry:

```python
# Native incoming Matrix message (including journal recovery):
source = {'kind': 'owner_turn', 'room': '!room:example.org', 'event': '$event'}
source_sender = '@owner:example.org'
cron_execution_id = None

# Native scheduled occurrence, from cron.execution_identity, never job extras:
source = {'kind': 'schedule', 'job': 'native-job-id', 'scheduledAt': 1794550000000}
source_sender = None
cron_execution_id = 'native-execution-id'
```

`scheduledAt` is integer Unix milliseconds derived from the native execution
ledger's timezone-aware `scheduled_instant`. Off-schedule/manual or unidentifiable
work carries `source=None`; never infer authority from the prompt, delivery
destination, `next_run_at`, a job-supplied extra field or a parent's source.
Delegated children do not inherit their parent's source identity. Source is
metadata for independent host authorization, not an authorization grant itself.
The Matrix identity is the **raw inbound message ID**, not a reply anchor.

Matrix media preparation and its turn carry the same source. Cron preparation
and the eventual native agent turn carry the selected native occurrence and
execution ID. A plugin must validate preparation without opening an operation,
then return its binding factory for the actual turn.

## Host-to-gateway targeted Matrix Stop

Reuse `gateway.control_socket.query_gateway_control` and the existing private
control handler authentication. A host can call it in the container with the
gateway user's identity (for example through its existing exec mechanism):

```python
query_gateway_control(home, 'stop-source', timeout=8, params={
    'profile_id': str(home.resolve()),
    'room': '!room:example.org', 'event': '$event',
    'sender': '@owner:example.org', 'action': 'stop',
})
# {'accepted': True,
#  'receipt': {'room': '!room:example.org', 'event': '$event',
#              'sender': '@owner:example.org'}}
```

The private envelope requires protocol 1 and a verified same-user local peer,
not a caller-supplied `authenticated` flag. `profile_id` must be a canonical,
currently served home; the Matrix adapter must authorize the sender/room.
The host separately authenticates the owner and current runtime generation.

`action='stop'` persists the existing presentation `stops(room,source,sender)`
receipt, then uses native cancellation/interruption for only that source's
admission/claimed generation. A pre-presentation Stop suppresses later execution;
a stale Stop never interrupts another source or generation. This has native
`/stop` hard-interrupt semantics for the targeted work, not a gateway shutdown or
cancellation of the whole chat's newer queued work.

`action='receipt'` confirms the same durable tuple and idempotently finishes any
matching native cancellation still pending. `accepted=False, receipt=None`, a
control error or no answer is **not** cancellation acknowledgement. Keep host
Stop intent and retry. The receipt acknowledges cancellation acceptance, not
physical worker termination or completed external effects. Native cron work
retains its existing `cron.cancel` admission/occurrence cancellation surface;
`stop-source` is the Matrix source control path, not a new cron scheduler.
