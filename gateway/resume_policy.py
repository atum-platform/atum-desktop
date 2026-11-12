"""Crash policy over Hermes' canonical transcript, never a second effect ledger.

RequestCheckpoint deliberately only reclaims pending idempotent provider requests;
this policy resumes a conversation, not a provider request or an effect.
"""
from dataclasses import dataclass
import json
import secrets
from datetime import datetime, UTC

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
    calls, results, latest = [], {}, {}
    malformed = False
    for row_index, row in enumerate(history[start:]):
        if row.get('role') == 'assistant':
            uids = row.get('_tool_call_uids', {})
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
                calls.append((uid, name, function.get('arguments', {})))
        elif row.get('role') == 'tool' and row.get('tool_call_id'):
            uid = row.get('_tool_call_uid') or resolve_tool_call_uid(latest, row['tool_call_id'])
            if not isinstance(uid, (str, tuple)):
                malformed = True
                continue
            results[uid] = row
    # Presence is not completion: unknown, orphan and interrupted results never prove it.
    # Only native positive read-only classification permits unattended continuation.
    completed, unfinished, unsafe = set(), [], []
    for uid, name, arguments in calls:
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


def pending_resume_policy(store, entry, policy, message, *, can_resolve, message_timestamp=None, message_admission_seq=None):
    """Persist the native session's unresolved human decision before any model/tool runs.

    Native gateway approval waiters are process-local and timed; only their once/deny
    semantics apply here, not their timeout. SessionStore owns persistence/locking.
    The original ingress timestamp fences pre-question FIFO input across restarts.
    """
    pending = getattr(entry, 'resume_ask', None)
    if pending is None and policy is not None and policy.ask:
        pending = {'token': secrets.token_hex(4), 'actions': list(policy.actions),
                   'created_at': datetime.now(UTC).isoformat()}
        db = getattr(store, '_db', None)
        if db is not None:
            fence = db._read_one('SELECT MAX(seq) AS seq FROM session_admissions')
            pending['admission_seq'] = (fence['seq'] or 0) if fence else 0
        can_resolve = False
        store._update_entry(entry.session_key, lambda current: setattr(current, 'resume_ask', pending))
    if pending is None:
        return policy
    if 'created_at' not in pending:
        # Older persisted questions acquire a conservative boundary on first use.
        pending = dict(pending, created_at=datetime.now(UTC).isoformat())
        store._update_entry(entry.session_key, lambda current: setattr(current, 'resume_ask', pending))
    try:
        received = datetime.fromisoformat(message_timestamp).timestamp()
        from hermes_constants import get_hermes_home
        from utils import load_yaml_file_readonly
        config_path = get_hermes_home() / 'config.yaml'
        config = (load_yaml_file_readonly(config_path) or {}) if config_path.exists() else {}
        tolerance = max(0, float(config.get('recovery', {}).get('clock_skew_tolerance_seconds', 300)))
        ordered = (message_admission_seq > pending['admission_seq']
                   if message_admission_seq is not None and 'admission_seq' in pending
                   else datetime.fromisoformat(pending['created_at']).timestamp() < received)
        fresh = received > 0 and ordered and received <= datetime.now(UTC).timestamp() + tolerance
    except (TypeError, ValueError, OSError):
        fresh = False
    token = pending['token']
    from tools.approval import exact_gateway_approval_choice
    decision = exact_gateway_approval_choice(str(message), token, allow_unscoped=fresh) if can_resolve else None
    if decision is not None:
        store._update_entry(entry.session_key, lambda current: setattr(current, 'resume_ask', None))
        store.clear_resume_pending(entry.session_key)
        if decision == 'once':
            return None
        # Denial is conversational only; the next independent user turn is free to run.
        return ResumePolicy(True, (), frozenset(), cancelled=True)
    return ResumePolicy(True, tuple(pending['actions']), frozenset())


def pending_ask_note(entry):
    pending = getattr(entry, 'resume_ask', None)
    if not pending:
        return ''
    from agent.i18n import get_language
    return (" Answer the owner's message conversationally without tools. Use language " +
            get_language() + " (English when unknown). Ask only ONE short line naming the "
            "interrupted action in everyday words and asking whether to continue. "
            "Do not show codes, tool names or arguments. A clear yes or no is enough. "
            "For an unrelated message, answer it and leave the pending question to the appended reminder.")


def pending_ask_reminder():
    from agent.i18n import get_language
    if get_language().split('-')[0] == 'vi':
        return 'Bạn có muốn tôi tiếp tục việc đang dở không?'
    return 'May I continue the interrupted action?'


def shape_pending_ask(store, entry, response):
    """Keep the first question short and reuse its action wording on later turns."""
    pending = entry.resume_ask
    question = pending.get('question')
    if not question:
        question = next((line.strip() for line in response.splitlines() if line.strip()), pending_ask_reminder())
        pending = dict(pending, question=question)
        store._update_entry(entry.session_key, lambda current: setattr(current, 'resume_ask', pending))
        return question
    return response if question in response else response + '\n\n' + question


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


async def resume_boot_allowed(authority, row, *, ref=None, live=None):
    """Native breaker scoped to a canonical admission, allowing three automatic retries."""
    import asyncio
    import logging
    from gateway.restart_loop_guard import check_and_record
    try:
        tripped = await asyncio.to_thread(check_and_record, max_restarts=4,
            max_gap_seconds=float('inf'), scope=row['admission_id'])
    except (OSError, ValueError, TypeError):
        tripped = True  # An unreadable budget must never authorize more model spend.
    if tripped:
        logging.getLogger(__name__).error('Automatic crash recovery paused: restart_loop; use /discard')
        from gateway.status import write_runtime_status
        await asyncio.to_thread(write_runtime_status, platform='matrix', platform_state='degraded',
            error_code='restart_loop', needs_attention=True,
            error_message='Automatic recovery paused after three attempts. Use /discard.')
        await asyncio.to_thread(write_runtime_status, platform='recovery:' + row['admission_id'],
            platform_state='paused', error_code='restart_loop', needs_attention=True,
            retrying_since=datetime.now(UTC).isoformat(),
            platform_metrics={'conversation': row.get('target_session_id'), 'admission_id': row['admission_id']})
        if ref is not None and live is not None:
            from gateway.session_ingress import pause_notice
            from gateway.delivery_ledger import record_obligation, compute_obligation_id, mark_delivered, get_delivery_state
            notice = pause_notice(authority, ref, 'unknown_execution')
            if notice:
                try:
                    adapter = authority.runner._delivery_adapter_for(live.source)
                    oid = compute_obligation_id(live.route, row['admission_id'], notice)
                    await asyncio.to_thread(record_obligation, obligation_id=oid, session_key=live.route,
                        platform=str(getattr(live.source.platform, 'value', live.source.platform)),
                        chat_id=live.source.chat_id, thread_id=live.source.thread_id, content=notice,
                        adapter_profile=getattr(adapter, '_owner_profile', None))
                    if await asyncio.to_thread(get_delivery_state, oid) == 'delivered':
                        return False
                    sent = await adapter.send(chat_id=live.source.chat_id, content=notice,
                        metadata={'delivery_obligation_id': oid, 'thread_id': live.source.thread_id})
                    if sent.success:
                        await asyncio.to_thread(mark_delivered, oid)
                except Exception:
                    logging.getLogger(__name__).exception('Recovery pause notice retained for delivery')
    return not tripped


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
    if not await resume_boot_allowed(authority, unknown[0], ref=ref, live=live):
        return False
    from hermes_state_runtime import requeue_interrupted_session_input
    return await asyncio.to_thread(requeue_interrupted_session_input, authority.db,
                                   epoch=authority.epoch, admission_id=unknown[0]['admission_id'])


async def recover_failed_native_admission(authority, ref, live, rows):
    """Recover a persistence-failed native turn on a later boot, behind its normal Ask gate.

    Only the latest executed admission is eligible. Queued followers keep their FIFO place,
    and the current epoch never retries itself in a loop. The retained native result
    carries proposed calls even when the canonical call-row write failed.
    """
    import asyncio
    adapter = authority.runner._delivery_adapter_for(live.source)
    if not getattr(adapter, 'tool_aware_resume', False) or not rows:
        return False
    row = next((row for row in reversed(rows) if row['status'] != 'queued'), None)
    if row is None:
        return False
    if (row['status'] != 'terminal' or row['outcome'] != 'failed'
            or row['owner_epoch'] == authority.epoch or 'native_text_v1' not in row['payload']):
        return False
    from gateway.session_results import admission_result
    saved = await asyncio.to_thread(admission_result, authority.db, row['admission_id'])
    result = (saved or {}).get('result', {})
    if not str(result.get('failure_reason', '')).startswith('session_persistence_failed:'):
        return False
    messages = result.get('messages')
    policy = choose_resume_policy(messages or [], force_ask=not messages)
    entry = authority.runner.session_store.lookup_by_session_key(live.route)
    if entry is None:
        return False
    if not await resume_boot_allowed(authority, row, ref=ref, live=live):
        # Reuse canonical uncertainty and its /discard notice on the next drain.
        from hermes_state_runtime import requeue_interrupted_session_input
        await asyncio.to_thread(requeue_interrupted_session_input, authority.db,
                               epoch=authority.epoch, admission_id=row['admission_id'], pause=True)
        return False
    # Save the decision before reclaiming. A second crash cannot lose the action names.
    await asyncio.to_thread(pending_resume_policy, authority.runner.session_store, entry,
                            policy, '', can_resolve=False)
    from hermes_state_runtime import requeue_interrupted_session_input
    return await asyncio.to_thread(requeue_interrupted_session_input, authority.db,
                                   epoch=authority.epoch, admission_id=row['admission_id'])
