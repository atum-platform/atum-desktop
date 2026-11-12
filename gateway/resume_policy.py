"""Crash policy over Hermes' canonical transcript, never a second effect ledger.

RequestCheckpoint deliberately only reclaims pending idempotent provider requests;
this policy resumes a conversation, not a provider request or an effect.
"""
from dataclasses import dataclass
import json
import secrets

from agent.message_metadata import resolve_tool_call_uid
from agent.message_sanitization import coalesce_tool_call_id, tool_call_id_variants
from agent.replay_cleanup import is_interrupted_tool_result

from agent.tool_result_classification import tool_may_have_side_effect


@dataclass(frozen=True)
class ResumePolicy:
    ask: bool
    actions: tuple[str, ...]
    completed: frozenset[str]
    cancelled: bool = False

    def note(self):
        if self.cancelled:
            return '[Recovery: The owner cancelled the interrupted action. Acknowledge conversationally; do not call tools this turn.]'
        if self.ask:
            actions = json.dumps(self.actions or ('the interrupted request',), ensure_ascii=False)
            return ("[Recovery: Before ANY new action, ask ONE short question in the owner's "
                    "language naming the action that may have half-happened: " + actions +
                    ". Ask whether to continue it. Do not say 'check again'. Do not call any tools.]")
        return ("[Recovery: Continue the interrupted task without asking. Calls with no durable "
                "result: " + json.dumps(self.actions, ensure_ascii=False) +
                ". Retry those calls once; any synthetic interruption result in replay is not "
                "completion evidence. NEVER repeat completed tool calls.]")


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
    calls, results, latest = {}, {}, {}
    malformed = False
    for row_index, row in enumerate(history[start:]):
        if row.get('role') == 'assistant':
            uids = row.get('_tool_call_uids') or {}
            if not isinstance(uids, dict):
                uids, malformed = {}, True
            occurrences = {}
            for call in row.get('tool_calls') or []:
                function = call.get('function') or {}
                ident, name = coalesce_tool_call_id(call), function.get('name')
                if not ident or not isinstance(name, str) or not name:
                    malformed = True
                    continue
                nth = occurrences.get(ident, 0)
                occurrences[ident] = nth + 1
                uid = uids.get(ident)
                if isinstance(uid, list):
                    uid = uid[nth] if nth < len(uid) else None
                    if uid is None:
                        malformed = True
                if uid is not None and (not isinstance(uid, str) or not uid):
                    uid, malformed = None, True
                uid = uid or (row_index, ident, nth)
                for variant in tool_call_id_variants(call):
                    latest[variant] = uid
                calls[uid] = (name, function.get('arguments', {}))
        elif row.get('role') == 'tool' and row.get('tool_call_id'):
            uid = row.get('_tool_call_uid') or resolve_tool_call_uid(latest, row['tool_call_id'])
            if not isinstance(uid, (str, tuple)):
                malformed = True
                continue
            results[uid] = row
    # Presence is not completion: unknown, orphan and interrupted results never prove it.
    # Only native positive read-only classification permits unattended continuation.
    completed, unfinished, unsafe = set(), [], []
    for uid, (name, arguments) in calls.items():
        result = results.get(uid)
        uncertain = (result is None or result.get('effect_disposition') not in (None, 'none')
                     or is_interrupted_tool_result(result.get('content'))
                     or str(result.get('content', '')).startswith('[Orphan recovery:'))
        if tool_may_have_side_effect(name) or (result is not None and result.get('effect_disposition') not in (None, 'none')):
            unsafe.append(name + ' ' + json.dumps(arguments, ensure_ascii=False)[:500])
        elif uncertain:
            unfinished.append(name)
        else:
            completed.add(call_key(name, arguments))
    return ResumePolicy(force_ask or malformed or bool(unsafe),
                        tuple(dict.fromkeys(unsafe or unfinished)), frozenset(completed))


def pending_resume_policy(store, entry, policy, message, *, can_resolve):
    """Persist the native session's unresolved human decision before any model/tool runs.

    Native gateway approval waiters are process-local and timed; only their once/deny
    semantics apply here, not their timeout. SessionStore owns persistence/locking.
    A fresh random prompt identity prevents pre-question FIFO input from resolving it.
    """
    pending = getattr(entry, 'resume_ask', None)
    if pending is None and policy is not None and policy.ask:
        pending = {'token': secrets.token_hex(4), 'actions': list(policy.actions)}
        store._update_entry(entry.session_key, lambda current: setattr(current, 'resume_ask', pending))
    if pending is None:
        return policy
    token = pending['token']
    decision = str(message).strip().casefold()
    if can_resolve and decision in {word + ' ' + token for word in ('yes', 'có', 'continue', 'tiếp tục', 'no', 'không', 'cancel', 'hủy')}:
        store._update_entry(entry.session_key, lambda current: setattr(current, 'resume_ask', None))
        store.clear_resume_pending(entry.session_key)
        if decision in {word + ' ' + token for word in ('yes', 'có', 'continue', 'tiếp tục')}:
            return None
        # Denial is conversational only; the next independent user turn is free to run.
        return ResumePolicy(True, (), frozenset(), cancelled=True)
    return ResumePolicy(True, tuple(pending['actions']), frozenset())


def pending_ask_note(entry):
    pending = getattr(entry, 'resume_ask', None)
    if not pending:
        return ''
    return (" Answer conversationally without tools until this decision is resolved. "
            "In the owner's language, include these literal one-message choices: "
            "yes " + pending['token'] + " / no " + pending['token'] +
            " (Vietnamese: có " + pending['token'] + " / không " + pending['token'] + ").")


def recovery_tool_block(policy, name, arguments):
    if policy is None:
        return None
    if policy.ask:
        return "Recovery requires the owner's answer before any new action. " + policy.note()
    if tool_may_have_side_effect(name):
        return 'Unattended crash recovery permits only positively classified read-only calls. Ask the owner before this action.'
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
