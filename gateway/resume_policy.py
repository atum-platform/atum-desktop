"""Crash policy over Hermes' canonical transcript, never a second effect ledger.

RequestCheckpoint deliberately only reclaims pending idempotent provider requests;
this policy resumes a conversation, not a provider request or an effect.
"""
from dataclasses import dataclass
import json

from agent.tool_result_classification import tool_may_have_side_effect


@dataclass(frozen=True)
class ResumePolicy:
    ask: bool
    actions: tuple[str, ...]
    completed: frozenset[str]

    def note(self):
        if self.ask:
            actions = json.dumps(self.actions or ('the interrupted request',), ensure_ascii=False)
            return ("[Recovery: Before ANY new action, ask ONE short question in the owner's "
                    "language naming the action that may have half-happened: " + actions +
                    ". Ask whether to continue it. Do not say 'check again'. Do not call any tools.]")
        return ("[Recovery: Continue the interrupted task without asking. Resume only steps with "
                "no recorded result. NEVER repeat completed tool calls.]")


def call_key(name, arguments):
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except ValueError:
            pass
    return json.dumps([name, arguments], sort_keys=True, ensure_ascii=False)


def choose_resume_policy(history, *, force_ask=False):
    # Limit to the interrupted turn, so an earlier unresolved call cannot poison a later turn.
    start = next((i for i in range(len(history)-1, -1, -1)
                  if history[i].get('role') == 'user'
                  and not str(history[i].get('content', '')).startswith('[Recovery:')), 0)
    calls, results = {}, set()
    malformed = False
    for row in history[start:]:
        if row.get('role') == 'assistant':
            for call in row.get('tool_calls') or []:
                function = call.get('function') or {}
                ident, name = call.get('id'), function.get('name')
                if not ident or not name:
                    malformed = True
                    continue
                calls[ident] = (name, function.get('arguments', {}))
        elif row.get('role') == 'tool' and row.get('tool_call_id'):
            results.add(row['tool_call_id'])
    unfinished = [name for ident, (name, _) in calls.items() if ident not in results]
    unsafe = tuple(dict.fromkeys(name for name in unfinished if tool_may_have_side_effect(name)))
    return ResumePolicy(force_ask or malformed or bool(unsafe), unsafe or tuple(unfinished),
                        frozenset(call_key(*value) for ident, value in calls.items() if ident in results))


def recovery_tool_block(policy, name, arguments):
    if policy is None:
        return None
    if policy.ask:
        return "Recovery requires the owner's answer before any new action. " + policy.note()
    if call_key(name, arguments) in policy.completed:
        return "This call already has a durable result. Use that result; do not repeat it."
    return None


async def recover_unknown_admission(authority, ref, live, rows):
    """Reclaim the SAME native admission; keep its identity, payload and transport receipt.

    Only a lost in-process messaging turn is eligible. Managed worker uncertainty still
    pauses: its independent execution must be resolved by the native worker owner.
    """
    import asyncio
    adapter = authority.runner._delivery_adapter_for(live.source)
    if not getattr(adapter, 'tool_aware_resume', False):
        return False
    unknown = [row for row in rows if row['status'] == 'unknown']
    if len(unknown) != 1 or 'native_text_v1' not in unknown[0]['payload']:
        return False
    from hermes_state_runtime import requeue_interrupted_session_input
    return await asyncio.to_thread(requeue_interrupted_session_input, authority.db,
                                   epoch=authority.epoch, admission_id=unknown[0]['admission_id'])
