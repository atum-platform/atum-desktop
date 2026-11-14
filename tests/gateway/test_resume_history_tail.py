"""Legacy recovery must never resurrect an ancestor's already-answered request."""
import pytest

from gateway.resume_policy import choose_resume_policy, recovery_tool_block
from tests.gateway.test_tool_aware_resume import call


@pytest.mark.parametrize('tail', [[], [{'role': 'user', 'content': 'today: read the agenda'}, call('today', 'read_file')]])
def test_legacy_resume_ignores_weeks_old_orphaned_effect_and_completed_reads(tmp_path, tail):
    from hermes_state import SessionDB
    db = SessionDB(tmp_path / 'history.db')
    try:
        db.create_session('old', 'matrix')
        db.append_message('old', 'user', 'weeks ago: send the reply')
        db.append_message('old', 'assistant', '', tool_calls=call('old-send', 'send_message')['tool_calls'])
        db.append_message('old', 'tool', '[Orphan recovery: lost result]', tool_call_id='old-send')
        db.append_message('old', 'assistant', '', tool_calls=call('old-read', 'web_search')['tool_calls'])
        db.append_message('old', 'tool', 'weeks-old result', tool_call_id='old-read')
        db.append_message('old', 'assistant', 'That earlier turn is finished.')
        db.end_session('old', 'compression')
        db.create_session('current', 'matrix', parent_session_id='old')
        for row in tail:
            db.append_message('current', row['role'], row['content'], tool_calls=row.get('tool_calls'))
        history = db.get_messages_as_conversation('current', include_ancestors=True)
        assert any(row.get('tool_call_id') == 'old-send' for row in history), 'fixture must load the old orphan'
        policy = choose_resume_policy(history)
        assert not policy.ask
        assert policy.actions == (('read_file',) if tail else ())
        assert policy.completed == frozenset()
        assert 'send_message' not in policy.note()
        assert recovery_tool_block(policy, 'web_search', {}) is None
        assert recovery_tool_block(policy, 'send_message', {})  # never rerun an old effect unattended
    finally:
        db.close()


def test_empty_legacy_tail_adds_no_recovery_instruction():
    from types import SimpleNamespace
    from gateway.run_turn_runner import TurnRunner
    history = [{'role': 'user', 'content': 'old'}, call('old', 'send_message'),
        {'role': 'tool', 'tool_call_id': 'old', 'content': '[Orphan recovery: unknown]'},
        {'role': 'assistant', 'content': 'The previous request is finished.'}]
    entry = SimpleNamespace(resume_pending=True, resume_reason='restart_interrupted', last_resume_marked_at=None)
    turn = object.__new__(TurnRunner)
    turn._runner = SimpleNamespace(session_store=SimpleNamespace(_entries={'key': entry}),
        _delivery_adapter_for=lambda source: SimpleNamespace(tool_aware_resume=True))
    turn._ctx = SimpleNamespace(source=None, session_key='key', history=history,
        message='resume checkpoint', persist_user_message=None, persist_user_timestamp=None, inbound_message_id=None)
    turn._prepare_turn_message(history)
    assert not turn._resume_policy.ask and turn._resume_policy.actions == ()
    assert turn._resume_policy.note() == ''
    assert recovery_tool_block(turn._resume_policy, 'send_message', {})
    assert turn._ctx.message == 'resume checkpoint'
