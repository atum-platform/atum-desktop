"""Public-safe deterministic H4/H5/H6 process-loss fixtures (no model/network)."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from types import SimpleNamespace

import pytest

from gateway.resume_policy import choose_resume_policy, recovery_tool_block


def call(ident, name):
    return {'role': 'assistant', 'content': '', 'tool_calls': [
        {'id': ident, 'type': 'function', 'function': {'name': name, 'arguments': '{}'}}]}


def test_unfinished_only_and_unknown_conservative():
    history = [{'role': 'user', 'content': 'work'}, call('a', 'write_file'),
               {'role': 'tool', 'tool_call_id': 'a', 'content': 'written'}, call('b', 'read_file')]
    before = json.dumps(history)
    policy = choose_resume_policy(history)
    assert not policy.ask  # a durable result is completion evidence, including writes
    assert recovery_tool_block(policy, 'write_file', {})
    assert recovery_tool_block(policy, 'read_file', {}) is None
    assert json.dumps(history) == before  # cached prefix and role sequence untouched
    for name in ('terminal', 'append_test', 'connectors__execute', 'delegate_task'):
        policy = choose_resume_policy([call('x', name)])
        assert policy.ask and name in policy.note()
        assert recovery_tool_block(policy, 'read_file', {})  # even reads wait for the answer
    assert choose_resume_policy(history, force_ask=True).ask
    assert not choose_resume_policy([{'role': 'user', 'content': 'thinking'}]).ask


WORKER = r'''
import os, signal, sys
from pathlib import Path
from hermes_state import SessionDB
from hermes_state_runtime import begin_runtime_epoch, admit_session_input, claim_session_input
path, hook, tool = sys.argv[1:]
db = SessionDB(db_path=Path(path) / 'state.db')
db.create_session('s', 'matrix')
epoch = begin_runtime_epoch(db, instance_id='old')
admit_session_input(db, epoch=epoch, principal_id='messaging:test', session_id='s',
                    request_id='$source', payload={'text': 'work', 'native_text_v1': {}})
claim_session_input(db, epoch=epoch, session_id='s')
db.append_message('s', 'user', 'work')
def stage(ident, name):
    db.append_message('s', 'assistant', '', tool_calls=[{'id': ident, 'type': 'function',
                      'function': {'name': name, 'arguments': '{}'}}])
stage('done', 'web_search')
db.append_message('s', 'tool', 'found', tool_call_id='done')
if hook != 'between':
    stage('pending', tool)
    if hook == 'after':
        with open(path + '/effect', 'a') as f: f.write('once\n'); f.flush(); os.fsync(f.fileno())
os.kill(os.getpid(), signal.SIGKILL)
'''


@pytest.mark.parametrize('hook,tool,count,ask', [
    ('before', 'read_file', 0, False), ('between', 'read_file', 0, False),
    ('before', 'append_test', 0, True), ('after', 'append_test', 1, True),
])
def test_kill_and_reclaim_same_native_admission(tmp_path, hook, tool, count, ask):
    from hermes_state import SessionDB
    from hermes_state_runtime import (begin_runtime_epoch, recover_session_inputs,
        requeue_interrupted_session_input, list_session_admissions, claim_session_input,
        admit_session_input)
    env = {**os.environ, 'HERMES_HOME': str(tmp_path), 'PYTHONPATH': str(Path.cwd())}
    killed = subprocess.run([sys.executable, '-c', WORKER, str(tmp_path), hook, tool], env=env)
    assert killed.returncode == -signal.SIGKILL
    db = SessionDB(db_path=tmp_path / 'state.db')
    epoch = begin_runtime_epoch(db, instance_id='new')
    assert recover_session_inputs(db, epoch=epoch) == 1
    original = list_session_admissions(db, session_id='s')[0]
    history = db.get_messages_as_conversation('s')
    before = json.dumps(history)
    policy = choose_resume_policy(history)
    assert policy.ask == ask
    assert requeue_interrupted_session_input(db, epoch=epoch, admission_id=original['admission_id'])
    assert not requeue_interrupted_session_input(db, epoch=epoch, admission_id=original['admission_id'])
    replay = admit_session_input(db, epoch=epoch, principal_id='messaging:test', session_id='s',
                                request_id='$source', payload=original['payload'])
    assert replay['admission_id'] == original['admission_id']
    claimed = claim_session_input(db, epoch=epoch, session_id='s')
    assert claimed['outcome'] == 'crash_resume'
    assert claimed['generation'] > original['generation']
    assert claim_session_input(db, epoch=epoch, session_id='s') is None
    assert recovery_tool_block(policy, 'web_search', {})  # completed call never repeats
    if ask:
        assert 'append_test' in policy.note()
        assert recovery_tool_block(policy, 'append_test', {})
    else:
        assert recovery_tool_block(policy, 'read_file', {}) is None
    effect = tmp_path / 'effect'
    assert (len(effect.read_text().splitlines()) if effect.exists() else 0) == count
    assert json.dumps(db.get_messages_as_conversation('s')) == before
    db.close()


def test_runner_uses_policy_without_mutating_history():
    from gateway.run_turn_runner import TurnRunner
    history = [{'role': 'user', 'content': 'Đọc tài liệu'}, call('x', 'read_file')]
    entry = SimpleNamespace(resume_pending=True, resume_reason='restart_interrupted', last_resume_marked_at=None)
    runner = SimpleNamespace(_delivery_adapter_for=lambda source: SimpleNamespace(tool_aware_resume=True),
                             session_store=SimpleNamespace(_entries={'key': entry}))
    turn = object.__new__(TurnRunner)
    turn._runner = runner
    turn._ctx = SimpleNamespace(source=None, session_key='key', history=history, message='',
                                persist_user_message=None, persist_user_timestamp=None, inbound_message_id=None)
    before = json.dumps(history)
    turn._prepare_turn_message(history)
    assert not turn._resume_policy.ask
    assert 'Continue' in turn._ctx.message
    assert json.dumps(history) == before


def test_ask_survives_a_second_crash():
    history = [{'role': 'user', 'content': 'write'}, call('x', 'append_test')]
    ask = choose_resume_policy(history)
    history.append({'role': 'user', 'content': ask.note()})
    again = choose_resume_policy(history)
    assert again.ask and 'append_test' in again.note()


def test_dispatch_guard_stops_effect_before_plugin_or_tool(monkeypatch):
    from agent import tool_executor as executor
    policy = choose_resume_policy([call('x', 'append_test')])
    from functools import partial
    agent = SimpleNamespace(_crash_resume_tool_guard=partial(recovery_tool_block, policy))
    ref = SimpleNamespace(name='append_test', args={})
    state = SimpleNamespace(blocked=False)
    def forbidden(*args, **kwargs):
        pytest.fail('Ask attempted an action before the owner answered')
    monkeypatch.setattr(executor, '_pre_tool_block', forbidden)
    monkeypatch.setattr(executor, '_blocked_tool_result', lambda *a, **kw: {'blocked': True})
    result = executor._dispatch_authorized_once(
        agent, state, ref, execute=forbidden, scope_block=None, display_index=None,
        begin_execution=None, authorization_gate=None)
    assert result == {'blocked': True} and state.blocked


@pytest.mark.parametrize('already_pending', [False, True])
def test_stale_markers_become_pending_ask(tmp_path, already_pending):
    from datetime import datetime, timedelta, UTC
    from gateway.session import SessionStore, SessionSource
    from gateway.config import GatewayConfig, Platform
    store = SessionStore(sessions_dir=tmp_path, config=GatewayConfig())
    entry = store.get_or_create_session(SessionSource(platform=Platform.TELEGRAM, chat_id='test'))
    store.mark_turn_active(entry.session_key)
    entry.active_turn_started_at = datetime.now(UTC) - timedelta(hours=2)
    entry.resume_pending = already_pending
    entry.resume_reason = 'restart_timeout' if already_pending else None
    assert store.recover_interrupted_turns(stale_to_ask=True) == int(not already_pending)
    assert entry.resume_pending and entry.resume_reason == 'stale_interruption'
    assert entry.active_turn_token is None


def test_reused_provider_id_is_not_completion_evidence():
    history = [call('same', 'read_file'), {'role': 'tool', 'tool_call_id': 'same', 'content': 'read'},
               call('same', 'append_test')]
    assert choose_resume_policy(history).ask
    history[0]['_tool_call_uids'] = {'same': 'first'}
    history[1]['_tool_call_uid'] = 'first'
    history[2]['_tool_call_uids'] = {'same': 'second'}
    assert choose_resume_policy(history).ask


@pytest.mark.parametrize('hook,expected', [('read', 1), ('between', 1), ('before_effect', 0), ('after_effect', 1), ('unknown_sequential', 1), ('unknown_concurrent', 1)])
def test_real_gateway_kill_and_resume(tmp_path, hook, expected):
    """Kill actual gateway execution; restart same native admission against a loopback model."""
    home = tmp_path / 'home'
    home.mkdir()
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'TZ') if key in os.environ}
    env.update(HOME=str(home), USERPROFILE=str(home), HERMES_HOME=str(home), PYTHONPATH=str(Path.cwd()))
    peer = Path(__file__).parent / 'fixtures' / 'tool_resume_peer.py'
    crash = subprocess.run([sys.executable, str(peer), 'crash', hook], env=env,
                           capture_output=True, text=True, timeout=80)
    assert crash.returncode == -signal.SIGKILL, crash.stdout + crash.stderr
    recovered = subprocess.run([sys.executable, str(peer), 'recover', hook], env=env,
                               capture_output=True, text=True, timeout=80)
    assert recovered.returncode == 0, recovered.stdout + recovered.stderr
    assert len((home / 'done-count').read_text().splitlines()) == 1
    count = home / 'pending-count'
    assert (len(count.read_text().splitlines()) if count.exists() else 0) == expected
    initial = [json.loads(line) for line in (home / 'crash-requests.jsonl').read_text().splitlines()]
    resumed = [json.loads(line) for line in (home / 'recover-requests.jsonl').read_text().splitlines()]
    for request in initial + resumed:
        assert request.get('tools') == initial[0].get('tools')
        assert request['messages'][0] == initial[0]['messages'][0]
        assert not any(a['role'] == b['role'] == 'user'
                       for a, b in zip(request['messages'], request['messages'][1:]))
    assert '[Recovery:' in json.dumps(resumed[0])
    if 'effect' in hook or hook.startswith('unknown_'):
        assert 'write_file' in json.dumps(resumed[0])


@pytest.mark.parametrize('disposition', ['unknown', None, 'unclassified'])
@pytest.mark.parametrize('content', ['[Command interrupted]', '{"output":"timeout","exit_code":130}'])
def test_unknown_effect_result_never_authorizes_continue(disposition, content):
    history = [call('x', 'terminal'), {'role': 'tool', 'tool_call_id': 'x',
               'content': content, 'effect_disposition': disposition}]
    policy = choose_resume_policy(history)
    assert policy.ask
    assert not policy.completed
    assert recovery_tool_block(policy, 'terminal', {'command': 'send payment again'})
    assert choose_resume_policy(history + [{'role': 'user', 'content': policy.note()}]).ask


def test_folded_occurrence_ids_and_legacy_variants():
    row = call('same', 'read_file')
    row['tool_calls'] += call('same', 'write_file')['tool_calls']
    row['_tool_call_uids'] = {'same': ['u1', 'u2']}
    history = [row, {'role': 'tool', 'tool_call_id': 'same', '_tool_call_uid': 'u1', 'content': 'read'}]
    policy = choose_resume_policy(history)
    assert policy.ask and any(action.startswith('write_file') for action in policy.actions)
    assert recovery_tool_block(policy, 'read_file', {})
    assert choose_resume_policy(history + [{'role': 'user', 'content': policy.note()}]).ask


def test_pending_ask_durable_no_expiry_and_explicit_resolution(tmp_path, monkeypatch):
    from gateway.session import SessionStore, SessionSource
    from gateway.config import GatewayConfig, Platform
    from gateway.resume_policy import pending_resume_policy
    config = GatewayConfig()
    store = SessionStore(sessions_dir=tmp_path, config=config)
    entry = store.get_or_create_session(SessionSource(platform=Platform.TELEGRAM, chat_id='test'))
    policy = choose_resume_policy([call('x', 'terminal')])
    gated = pending_resume_policy(store, entry, policy, 'queued before Ask', can_resolve=True)
    token = entry.resume_ask['token']
    from datetime import datetime, timedelta, UTC
    entry.updated_at = datetime.now(UTC) - timedelta(days=365)
    assert store.prune_old_entries(max_age_days=1) == 0
    monkeypatch.setattr(store, '_is_session_ended_in_db', lambda sid: True)
    assert store.get_or_create_session(entry.origin) is entry
    assert gated.ask
    store.clear_resume_pending(entry.session_key)  # successful question must not clear the gate
    store = SessionStore(sessions_dir=tmp_path, config=config)
    entry = store.get_or_create_session(SessionSource(platform=Platform.TELEGRAM, chat_id='test'))
    assert entry.resume_ask['token'] == token
    for text in ('finish it', 'yes please maybe', 'yes wrong-token'):
        assert pending_resume_policy(store, entry, None, text, can_resolve=True).ask
    assert pending_resume_policy(store, entry, None, 'yes ' + token, can_resolve=False).ask
    assert pending_resume_policy(store, entry, None, 'không ' + token, can_resolve=True).ask
    assert entry.resume_ask is None
    assert pending_resume_policy(store, entry, None, 'new work', can_resolve=True) is None
    pending_resume_policy(store, entry, policy, '', can_resolve=False)
    assert pending_resume_policy(store, entry, None, 'có ' + entry.resume_ask['token'], can_resolve=True) is None


def test_queued_message_and_second_gateway_crash_keep_ask(tmp_path):
    home = tmp_path / 'home'
    home.mkdir()
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'TZ') if key in os.environ}
    env.update(HOME=str(home), USERPROFILE=str(home), HERMES_HOME=str(home), PYTHONPATH=str(Path.cwd()))
    peer = Path(__file__).parent / 'fixtures' / 'tool_resume_peer.py'
    for mode, expected in [('crash', -signal.SIGKILL), ('ask_crash', -signal.SIGKILL), ('pending_again', 0)]:
        result = subprocess.run([sys.executable, str(peer), mode, 'before_effect'], env=env,
                                capture_output=True, text=True, timeout=80)
        assert result.returncode == expected, result.stdout + result.stderr
        assert not (home / 'pending-count').exists(), (mode, (home / 'handler-events').read_text())
    assert not (home / 'pending-count').exists()


def test_shared_occurrence_uid_does_not_hide_an_effect():
    row = call('same', 'write_file')
    row['tool_calls'] += call('same', 'read_file')['tool_calls']
    row['_tool_call_uids'] = {'same': 'shared'}
    result = {'role': 'tool', 'tool_call_id': 'same', '_tool_call_uid': 'shared', 'content': 'read'}
    assert choose_resume_policy([row, result]).ask


@pytest.mark.parametrize('uids', [[], 'invalid', {'same': []}])
def test_malformed_identity_asks_safely(uids):
    row = call('same', 'read_file')
    row['_tool_call_uids'] = uids
    assert choose_resume_policy([row]).ask


def test_owner_can_resolve_in_one_message_with_pending_model_note(tmp_path):
    from gateway.session import SessionStore, SessionSource
    from gateway.config import GatewayConfig, Platform
    from gateway.resume_policy import pending_resume_policy
    from gateway.run_turn_runner import TurnRunner
    store = SessionStore(sessions_dir=tmp_path, config=GatewayConfig())
    source = SessionSource(platform=Platform.TELEGRAM, chat_id='test')
    entry = store.get_or_create_session(source)
    pending_resume_policy(store, entry, choose_resume_policy([call('x', 'terminal')]), '', can_resolve=False)
    reply = 'có ' + entry.resume_ask['token']
    runner = SimpleNamespace(session_store=store,
        _delivery_adapter_for=lambda source: SimpleNamespace(tool_aware_resume=True),
        _pending_model_notes={entry.session_key: '[Model changed]'})
    turn = object.__new__(TurnRunner)
    turn._runner = runner
    turn._ctx = SimpleNamespace(source=source, session_key=entry.session_key, history=[], message='[Room owner] ' + reply,
        persist_user_message=None, persist_user_timestamp=None, inbound_message_id='fresh-owner',
        persist_user_display_metadata={'crash_resume_owner_response': True, 'crash_resume_decision_text': reply})
    turn._prepare_turn_message([])
    assert entry.resume_ask is None and turn._resume_policy is None


@pytest.mark.parametrize('text,choice', [
    *[(word, 'once') for word in ('YES!', 'Yeah.', 'OK', 'Go ahead!', 'do it', 'Sure', 'CÓ!', 'Ừ.', 'Được', 'LÀM ĐI!')],
    *[(word, 'deny') for word in ('NO!', 'Nope.', "Don't!", 'Stop', 'Cancel.', 'KHÔNG!', 'Thôi', 'Đừng.')],
])
def test_bare_owner_reply_after_restart(tmp_path, text, choice):
    from datetime import datetime, UTC
    from gateway.session import SessionStore, SessionSource
    from gateway.config import GatewayConfig, Platform
    from gateway.resume_policy import pending_resume_policy, recovery_tool_block
    config = GatewayConfig()
    source = SessionSource(platform=Platform.TELEGRAM, chat_id='test')
    store = SessionStore(sessions_dir=tmp_path, config=config)
    entry = store.get_or_create_session(source)
    before = datetime.now(UTC).isoformat()
    policy = choose_resume_policy([call('x', 'terminal')])
    assert pending_resume_policy(store, entry, policy, text, can_resolve=True, message_timestamp=before).ask
    store = SessionStore(sessions_dir=tmp_path, config=config)
    entry = store.get_or_create_session(source)
    # Even a clear queued yes/no predating the question stays gated after restart.
    gated = pending_resume_policy(store, entry, None, text, can_resolve=True, message_timestamp=before)
    assert gated.ask and recovery_tool_block(gated, 'read_file', {})
    resolved = pending_resume_policy(store, entry, None, text, can_resolve=True,
                                     message_timestamp=datetime.now(UTC).isoformat())
    assert entry.resume_ask is None
    if choice == 'once':
        assert resolved is None
    else:
        assert resolved.cancelled and recovery_tool_block(resolved, 'read_file', {})


@pytest.mark.parametrize('text', ['yes or no', 'yes/no', 'maybe', 'what happened?', 'yes, but wait', 'không biết', 'not sure'])
def test_ambiguous_resume_reply_keeps_gate(tmp_path, text):
    from datetime import datetime, UTC
    from gateway.session import SessionStore, SessionSource
    from gateway.config import GatewayConfig, Platform
    from gateway.resume_policy import pending_resume_policy, recovery_tool_block
    store = SessionStore(sessions_dir=tmp_path, config=GatewayConfig())
    entry = store.get_or_create_session(SessionSource(platform=Platform.TELEGRAM, chat_id='test'))
    pending_resume_policy(store, entry, choose_resume_policy([call('x', 'terminal')]), '', can_resolve=False)
    gated = pending_resume_policy(store, entry, None, text, can_resolve=True,
                                 message_timestamp=datetime.now(UTC).isoformat())
    assert entry.resume_ask and recovery_tool_block(gated, 'terminal', {})


def test_resume_language_and_hidden_token(monkeypatch):
    from gateway.resume_policy import pending_ask_note, pending_ask_reminder
    from tools.approval import exact_gateway_approval_choice
    import agent.i18n
    entry = SimpleNamespace(resume_ask={'token': 'secret-code', 'actions': ['write_file']})
    assert "language the owner writes in" in pending_ask_note(entry)
    assert 'secret-code' not in pending_ask_note(entry)
    # The reminder is one short question in the owner's language that a bare yes/no answers.
    monkeypatch.setenv('HERMES_LANGUAGE', 'en')
    english = pending_ask_reminder()
    monkeypatch.setenv('HERMES_LANGUAGE', 'vi')
    vietnamese = pending_ask_reminder()
    agent.i18n.reset_language_cache()
    for question in (english, vietnamese):
        assert question.endswith('?') and '\n' not in question and len(question) <= 60
    assert english != vietnamese and english.isascii() and not vietnamese.isascii()
    assert exact_gateway_approval_choice('yes', 'tok', allow_unscoped=True) == 'once'
    assert exact_gateway_approval_choice('ừ', 'tok', allow_unscoped=True) == 'once'


def test_ask_is_one_line_and_followup_names_original_action(tmp_path):
    from gateway.session import SessionStore, SessionSource
    from gateway.config import GatewayConfig, Platform
    from gateway.resume_policy import pending_resume_policy, shape_pending_ask
    store = SessionStore(sessions_dir=tmp_path, config=GatewayConfig())
    entry = store.get_or_create_session(SessionSource(platform=Platform.TELEGRAM, chat_id='test'))
    pending_resume_policy(store, entry, choose_resume_policy([call('x', 'terminal')]), '', can_resolve=False)
    question = 'May I finish writing your document?'
    assert shape_pending_ask(store, entry, question + '\nExtra detail') == question
    store = SessionStore(sessions_dir=tmp_path, config=GatewayConfig())
    entry = store.get_or_create_session(entry.origin)
    assert shape_pending_ask(store, entry, 'I can explain what happened.') == 'I can explain what happened.\n\n' + question


def test_native_naive_ingress_timestamp_resolves(tmp_path):
    from datetime import datetime
    from gateway.session import SessionStore, SessionSource
    from gateway.config import GatewayConfig, Platform
    from gateway.resume_policy import pending_resume_policy
    store = SessionStore(sessions_dir=tmp_path, config=GatewayConfig())
    entry = store.get_or_create_session(SessionSource(platform=Platform.TELEGRAM, chat_id='test'))
    pending_resume_policy(store, entry, choose_resume_policy([call('x', 'terminal')]), '', can_resolve=False)
    assert pending_resume_policy(store, entry, None, 'Yes!', can_resolve=True,
                                 message_timestamp=datetime.now().isoformat()) is None


@pytest.mark.parametrize('reply,choice', [('YES abcd!', 'once'), ('CÓ abcd.', 'once'), ('NO abcd!', 'deny'), ('KHÔNG abcd.', 'deny'),
                                          ('Làm tiếp đi abcd', 'once'), ('Yes please abcd', 'once'), ('Thôi abcd', 'deny'), ('Skip it abcd', 'deny')])
def test_token_reply_alternative(reply, choice):
    from tools.approval import exact_gateway_approval_choice
    assert exact_gateway_approval_choice(reply, 'abcd') == choice


def test_legacy_pending_ask_accepts_next_fresh_reply_after_load(tmp_path):
    from datetime import datetime, UTC
    from gateway.session import SessionStore, SessionSource
    from gateway.config import GatewayConfig, Platform
    from gateway.resume_policy import pending_resume_policy
    config = GatewayConfig()
    source = SessionSource(platform=Platform.TELEGRAM, chat_id='test')
    store = SessionStore(sessions_dir=tmp_path, config=config)
    entry = store.get_or_create_session(source)
    store._update_entry(entry.session_key, lambda current: setattr(current, 'resume_ask',
                        {'token': 'legacy', 'actions': ['write_file']}))
    before = datetime.now(UTC).isoformat()
    store = SessionStore(sessions_dir=tmp_path, config=config)
    entry = store.get_or_create_session(source)
    assert pending_resume_policy(store, entry, None, 'yes', can_resolve=True, message_timestamp=before).ask
    assert pending_resume_policy(store, entry, None, 'yes', can_resolve=True,
                                 message_timestamp=datetime.now(UTC).isoformat()) is None


@pytest.mark.parametrize('cause,native,later,eligible', [
    ('session_persistence_failed:unknown', True, False, True),
    ('session_persistence_failed:locked', True, False, True),
    ('provider_error', True, False, False),
    ('session_persistence_failed:unknown', False, False, False),
    ('session_persistence_failed:unknown', True, 'queued', True),
    ('session_persistence_failed:unknown', True, 'completed', False),
])
def test_failed_reclaim_keeps_native_identity_and_fences(cause, native, later, eligible, tmp_path):
    from hermes_state import SessionDB
    from hermes_state_runtime import (begin_runtime_epoch, admit_session_input, claim_session_input,
        settle_session_input, requeue_interrupted_session_input, list_session_admissions)
    db = SessionDB(db_path=tmp_path / 'state.db')
    db.create_session('s', 'matrix')
    old = begin_runtime_epoch(db, instance_id='old')
    payload = {'text': 'work'}
    if native:
        payload['native_text_v1'] = {}
    row = admit_session_input(db, epoch=old, principal_id='messaging:test', session_id='s',
                             request_id='source', payload=payload)
    claim = claim_session_input(db, epoch=old, session_id='s')
    settle_session_input(db, epoch=old, admission_id=row['admission_id'], generation=claim['generation'],
                         outcome='failed', result={'result': {'failed': True, 'failure_reason': cause}})
    assert not requeue_interrupted_session_input(db, epoch=old, admission_id=row['admission_id'])
    if later:
        admit_session_input(db, epoch=old, principal_id='messaging:test', session_id='s',
                            request_id='later', payload=payload)
        if later == 'completed':
            follower = claim_session_input(db, epoch=old, session_id='s')
            settle_session_input(db, epoch=old, admission_id=follower['admission_id'],
                                 generation=follower['generation'], outcome='completed')
    new = begin_runtime_epoch(db, instance_id='new')
    assert requeue_interrupted_session_input(db, epoch=new, admission_id=row['admission_id']) == eligible
    recovered = list_session_admissions(db, session_id='s', pending_only=False)[0]
    for key in ('admission_id', 'request_id', 'principal_id', 'target_session_id', 'seq', 'payload'):
        assert recovered[key] == row[key]
    db.close()


@pytest.mark.parametrize('durable', [False, True])
@pytest.mark.parametrize('tool,ask', [('web_search', False), ('terminal', True)])
def test_recovery_uses_source_identity_not_previous_completed_turn(tmp_path, durable, tool, ask):
    from hermes_state import SessionDB
    db = SessionDB(db_path=tmp_path / 'state.db')
    db.create_session('s', 'matrix')
    db.append_message('s', 'user', 'file and reminder', platform_message_id='$old')
    db.append_message('s', 'assistant', '', tool_calls=call('old', 'cron')['tool_calls'])
    db.append_message('s', 'tool', 'scheduled', tool_call_id='old')
    db.append_message('s', 'assistant', 'Delivered and scheduled')
    if durable:
        db.append_message('s', 'user', 'new request', platform_message_id='$new')
        db.append_message('s', 'assistant', '', tool_calls=call('new', tool)['tool_calls'])
    history = db.get_messages_as_conversation('s')
    policy = choose_resume_policy(history, source_message_id='$new')
    assert policy.ask == (durable and ask)
    assert 'cron' not in policy.note()
    assert 'file and reminder' not in policy.note()
    if durable and ask:
        assert 'terminal' in policy.note()
    else:
        assert recovery_tool_block(policy, 'web_search', {}) is None
        assert recovery_tool_block(policy, 'cron', {})  # old effect cannot run unattended
    db.close()


def test_runner_targets_admission_source_before_first_user_write(tmp_path):
    from hermes_state import SessionDB
    from gateway.run_turn_runner import TurnRunner
    db = SessionDB(db_path=tmp_path / 'state.db')
    db.create_session('s', 'matrix')
    db.append_message('s', 'user', 'file and reminder', platform_message_id='$old')
    db.append_message('s', 'assistant', '', tool_calls=call('old', 'cron')['tool_calls'])
    db.append_message('s', 'tool', 'scheduled', tool_call_id='old')
    db.append_message('s', 'assistant', 'Done')
    history = db.get_messages_as_conversation('s')
    entry = SimpleNamespace(resume_pending=True, resume_reason='restart_interrupted', last_resume_marked_at=None)
    runner = SimpleNamespace(_delivery_adapter_for=lambda source: SimpleNamespace(tool_aware_resume=True),
        session_store=SimpleNamespace(_entries={'key': entry}, _db_for_session_id=lambda sid: db))
    turn = object.__new__(TurnRunner)
    turn._runner = runner
    turn._ctx = SimpleNamespace(source=None, session_key='key', session_id='s', history=history,
        message='Search Fansipan height', persist_user_message=None, persist_user_timestamp=None,
        inbound_message_id='$new', persist_user_display_metadata={'crash_resume_source_id': '$new'})
    turn._prepare_turn_message(history)
    assert not turn._resume_policy.ask
    assert 'Search Fansipan height' in turn._ctx.message
    assert 'cron' not in turn._ctx.message
    db.close()


def test_real_h4_exits_before_new_user_row_and_recovers_only_new_source(tmp_path):
    from hermes_state import SessionDB
    worker = r'''
import os, sys
from pathlib import Path
from gateway.config import GatewayConfig, Platform
from gateway.session import SessionStore, SessionSource
from hermes_state import SessionDB
home = Path(sys.argv[1])
db = SessionDB(db_path=home / 'transcript.db')
db.create_session('s', 'matrix')
db.append_message('s', 'user', 'file and reminder', platform_message_id='$old')
db.append_message('s', 'assistant', '', tool_calls=[{'id':'old', 'type':'function',
    'function': {'name':'cron', 'arguments':'{}'}}])
db.append_message('s', 'tool', 'scheduled', tool_call_id='old')
db.append_message('s', 'assistant', 'Done')
store = SessionStore(sessions_dir=home / 'sessions', config=GatewayConfig())
store._db = None
entry = store.get_or_create_session(SessionSource(platform=Platform.MATRIX, chat_id='!offline', user_id='@owner'))
store.mark_turn_active(entry.session_key)  # real H4: durable marker, before _persist_turn_start
raise AssertionError('H4 did not fire')
'''
    killed = subprocess.run([sys.executable, '-c', worker, str(tmp_path)], env={**os.environ,
        'HERMES_HOME': str(tmp_path), 'PYTHONPATH': str(Path.cwd()), 'ATUM_FAULT_TEST': '1',
        'ATUM_FAULT_POINT': 'H4', 'ATUM_FAULT_ONCE': str(tmp_path / 'fault')})
    assert killed.returncode == 86
    assert (tmp_path / 'fault').exists()
    db = SessionDB(db_path=tmp_path / 'transcript.db')
    history = db.get_messages_as_conversation('s')
    assert not choose_resume_policy(history).ask  # the completed prior effect is excluded
    policy = choose_resume_policy(history, source_message_id='$new')
    assert not policy.ask
    assert 'cron' not in policy.note()
    assert recovery_tool_block(policy, 'cron', {})
    db.close()


def test_source_bounded_policy_keeps_completed_reads_and_excludes_later_turn():
    history = [
        {'role': 'user', 'content': 'old', 'message_id': '$old'}, call('old', 'cron'),
        {'role': 'tool', 'tool_call_id': 'old', 'content': 'scheduled'},
        {'role': 'assistant', 'content': 'Done'},
        {'role': 'user', 'content': 'new', 'message_id': '$new'}, call('done', 'web_search'),
        {'role': 'tool', 'tool_call_id': 'done', 'content': 'found'}, call('pending', 'read_file'),
        {'role': 'user', 'content': 'later', 'message_id': '$later'}, call('later', 'terminal')]
    policy = choose_resume_policy(history, source_message_id='$new')
    assert not policy.ask
    assert policy.actions == ('read_file',)
    assert recovery_tool_block(policy, 'web_search', {})
    assert recovery_tool_block(policy, 'read_file', {}) is None
    assert recovery_tool_block(policy, 'cron', {})


@pytest.mark.parametrize('source', [None, '$done'])
def test_completed_effect_is_never_offered_as_half_happened(source):
    history = [{'role': 'user', 'content': 'send', 'platform_message_id': '$done'},
               call('sent', 'send_message'),
               {'role': 'tool', 'tool_call_id': 'sent', 'content': 'sent'},
               {'role': 'assistant', 'content': 'Done'}]
    policy = choose_resume_policy(history, source_message_id=source)
    assert not policy.ask
    assert policy.actions == ()
    assert recovery_tool_block(policy, 'send_message', {})


def test_bare_please_does_not_authorize_resume():
    from tools.approval import exact_gateway_approval_choice
    assert exact_gateway_approval_choice('please', 'token', allow_unscoped=True) is None


def test_new_message_after_discard_gets_no_recovery_instruction():
    from gateway.run_turn_runner import TurnRunner
    history = [{'role': 'user', 'content': 'old'}, call('unsafe', 'send_message')]
    entry = SimpleNamespace(resume_pending=True, resume_reason='restart_interrupted', last_resume_marked_at=None)
    turn = object.__new__(TurnRunner)
    turn._runner = SimpleNamespace(session_store=SimpleNamespace(_entries={'key': entry}),
        _delivery_adapter_for=lambda source: SimpleNamespace(tool_aware_resume=True))
    turn._ctx = SimpleNamespace(source=None, session_key='key', history=history,
        message='unrelated new request', persist_user_message=None, persist_user_timestamp=None,
        inbound_message_id='$fresh')
    turn._prepare_turn_message(history)
    assert turn._resume_policy is None
    assert 'Continue the interrupted' not in turn._ctx.message


def test_legacy_resume_scans_unfinished_calls_without_last_user_fallback():
    history = [{'role': 'user', 'content': 'read'}, call('unfinished', 'read_file'),
        {'role': 'user', 'content': 'send'}, call('sent', 'send_message'),
        {'role': 'tool', 'tool_call_id': 'sent', 'content': 'sent'},
        {'role': 'assistant', 'content': 'Done'}]
    policy = choose_resume_policy(history)
    assert not policy.ask
    assert policy.actions == ('read_file',)
    assert recovery_tool_block(policy, 'send_message', {})


@pytest.mark.parametrize('inbound_id', ['$new', None])
def test_recovery_metadata_must_match_running_source(inbound_id):
    from gateway.run_turn_runner import TurnRunner
    history = [{'role': 'user', 'content': 'old', 'platform_message_id': '$old'}, call('unsafe', 'send_message')]
    entry = SimpleNamespace(resume_pending=True, resume_reason='restart_interrupted', last_resume_marked_at=None)
    turn = object.__new__(TurnRunner)
    turn._runner = SimpleNamespace(session_store=SimpleNamespace(_entries={'key': entry}),
        _delivery_adapter_for=lambda source: SimpleNamespace(tool_aware_resume=True))
    turn._ctx = SimpleNamespace(source=None, session_key='key', history=history,
        message='new request', persist_user_message=None, persist_user_timestamp=None,
        inbound_message_id=inbound_id, persist_user_display_metadata={'crash_resume_source_id': '$old'})
    turn._prepare_turn_message(history)
    assert turn._resume_policy is None
