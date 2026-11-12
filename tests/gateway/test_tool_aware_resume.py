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
    assert not policy.ask
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


@pytest.mark.parametrize('hook,expected', [('read', 1), ('between', 1), ('before_effect', 0), ('after_effect', 1)])
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
    if 'effect' in hook:
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
    assert policy.ask and 'write_file' in policy.actions
    assert recovery_tool_block(policy, 'read_file', {})
    assert choose_resume_policy(history + [{'role': 'user', 'content': policy.note()}]).ask


def test_pending_ask_durable_no_expiry_and_explicit_resolution(tmp_path):
    from gateway.session import SessionStore, SessionSource
    from gateway.config import GatewayConfig, Platform
    from gateway.resume_policy import pending_resume_policy
    config = GatewayConfig()
    store = SessionStore(sessions_dir=tmp_path, config=config)
    entry = store.get_or_create_session(SessionSource(platform=Platform.TELEGRAM, chat_id='test'))
    policy = choose_resume_policy([call('x', 'terminal')])
    gated = pending_resume_policy(store, entry, policy, 'queued before Ask', can_resolve=True)
    token = entry.resume_ask['token']
    assert gated.ask
    store.clear_resume_pending(entry.session_key)  # successful question must not clear the gate
    store = SessionStore(sessions_dir=tmp_path, config=config)
    entry = store.get_or_create_session(SessionSource(platform=Platform.TELEGRAM, chat_id='test'))
    assert entry.resume_ask['token'] == token
    for text in ('finish it', 'yes', 'no', 'yes wrong-token'):
        assert pending_resume_policy(store, entry, None, text, can_resolve=True).ask
    assert pending_resume_policy(store, entry, None, 'yes ' + token, can_resolve=False).ask
    assert pending_resume_policy(store, entry, None, 'không ' + token, can_resolve=True).ask
    assert entry.resume_ask is None
    assert pending_resume_policy(store, entry, None, 'new work', can_resolve=True) is None
    pending_resume_policy(store, entry, policy, '', can_resolve=False)
    assert pending_resume_policy(store, entry, None, 'có ' + entry.resume_ask['token'], can_resolve=True) is None
