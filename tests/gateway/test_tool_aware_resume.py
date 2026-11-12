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
from hermes_state import SessionDB
from hermes_state_runtime import begin_runtime_epoch, admit_session_input, claim_session_input
path, hook, tool = sys.argv[1:]
db = SessionDB(db_path=path + '/state.db')
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
