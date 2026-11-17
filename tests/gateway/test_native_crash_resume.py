"""Native recovery accepts fresh owner work and ignores retired Ask state."""
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from types import SimpleNamespace

import pytest

from gateway.config import GatewayConfig, Platform
from gateway.run import GatewayRunner
from gateway.run_turn_runner import TurnRunner
from gateway.session import SessionEntry, SessionSource


def test_legacy_question_is_ignored_on_load():
    stamp = datetime.now(UTC).isoformat()
    wire = dict(session_key='route', session_id='s', created_at=stamp, updated_at=stamp,
                resume_ask={'question': 'Carry on?', 'actions': ['terminal']})
    entry = SessionEntry.from_dict(wire)
    assert entry.session_id == 's'
    assert 'resume_ask' not in entry.to_dict()


@pytest.mark.asyncio
@pytest.mark.parametrize('resume_pending', [False, True])
async def test_new_owner_message_allows_tools_and_keeps_direct_reply(tmp_path, monkeypatch, resume_pending):
    from agent import tool_executor as executor
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / 'sessions'))
    source = SessionSource(Platform.MATRIX, '!room', user_id='owner')
    entry = runner.session_store.get_or_create_session(source)
    entry.resume_pending = resume_pending
    entry.resume_reason = 'restart_interrupted'
    # Also tolerate a legacy in-memory entry during an upgrade.
    entry.resume_ask = {'question': 'Carry on?', 'actions': ['terminal']}
    history = [{'role': 'tool', 'content': 'interrupted output', 'tool_call_id': 'old'}]
    turn = object.__new__(TurnRunner)
    turn._runner = runner
    turn._ctx = SimpleNamespace(source=source, session_key=entry.session_key, history=history,
        message='Read the current status', persist_user_message=None, persist_user_timestamp=None,
        inbound_message_id='new-owner-message')
    persisted, _ = turn._prepare_turn_message(history)
    assert persisted == 'Read the current status'
    assert turn._ctx.message.endswith('Read the current status')
    assert 'Carry on?' not in turn._ctx.message
    assert 'Do not call any tools' not in turn._ctx.message

    monkeypatch.setattr(executor, '_pre_tool_block', lambda agent, ref: (None, ref.args))
    monkeypatch.setattr(executor, '_begin_tool_execution', lambda *args: None)
    monkeypatch.setattr(executor, '_run_with_activity_heartbeat', lambda agent, name, call: call())
    agent = SimpleNamespace(_tool_guardrails=SimpleNamespace(
        before_call=lambda *args: SimpleNamespace(allows_execution=True)), tool_progress_callback=None)
    state = SimpleNamespace(blocked=False)
    result = executor._dispatch_authorized_once(agent, state,
        SimpleNamespace(name='read_file', args={'path': 'status'}, call_id='fresh'),
        execute=lambda args: 'Current status is ready.', scope_block=None,
        display_index=None, begin_execution=None, authorization_gate=None)
    assert result == 'Current status is ready.'
    assert not state.blocked
    response, silent, _ = await runner._hmwa_shape_agent_response(
        {'final_response': result, 'messages': []}, source, history, entry, None,
        None, 0, entry.session_id, 'matrix', 0.0)
    assert response == 'Current status is ready.'
    assert not silent
    runner.session_store._db.close()


def test_native_startup_skips_auto_resume_after_restart_chain(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / 'sessions'))
    source = SessionSource(Platform.TELEGRAM, '123', user_id='owner')
    entry = runner.session_store.get_or_create_session(source)
    runner.session_store.mark_resume_pending(entry.session_key, reason='restart_interrupted')
    monkeypatch.setattr(runner, '_restart_loop_guard_config', lambda: (3, 60, 300))
    assert runner._resume_pending_candidates() == [entry]
    assert runner._resume_pending_candidates() == [entry]
    assert runner._resume_pending_candidates() is None
    assert entry.resume_pending
    runner.session_store._db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('age_seconds, expected_turns', [(7200, 0), (60, 1)])
async def test_unclean_boot_only_resumes_fresh_active_turns(
    tmp_path, monkeypatch, age_seconds, expected_turns,
):
    from gateway.session import SessionStore
    from tests.gateway.restart_test_helpers import RestartTestAdapter
    from tests.waiting import async_wait_until

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_AGENT_TIMEOUT', '1800')
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / 'sessions'))
    adapter = RestartTestAdapter()
    runner.adapters = {Platform.TELEGRAM: adapter}
    adapter.set_message_handler(runner._handle_message)
    monkeypatch.setattr(runner, '_is_user_authorized_for_source', lambda source: True)
    model_turn = AsyncMock(return_value='Resumed answer')
    monkeypatch.setattr(runner, '_handle_message_with_agent', model_turn)
    adapter._keep_typing = AsyncMock()
    adapter._stop_typing_refresh = AsyncMock()
    source = SessionSource(Platform.TELEGRAM, '123', user_id='owner')
    entry = runner.session_store.get_or_create_session(source)
    runner.session_store.mark_turn_active(entry.session_key)
    with runner.session_store._lock:
        runner.session_store._set_turn_marker_locked(
            entry.session_key, entry, entry.active_turn_token,
            datetime.now(UTC) - timedelta(seconds=age_seconds),
        )
    # Re-open the persisted routing state as a new process would on unclean boot.
    runner.session_store._db.close()
    runner.session_store = SessionStore(
        sessions_dir=tmp_path / 'sessions', config=runner.config,
    )
    try:
        assert await runner._recover_unclean_sessions() == (expected_turns, 0)
        entry = runner.session_store._entries[entry.session_key]
        assert entry.active_turn_token is None
        assert entry.active_turn_started_at is None
        assert entry.resume_pending == bool(expected_turns)
        assert entry.resume_reason == ('restart_interrupted' if expected_turns else None)
        assert runner._schedule_resume_pending_sessions() == expected_turns
        if expected_turns:
            await async_wait_until(
                lambda: model_turn.await_count == 1 and not runner._running_agents
                and 'Resumed answer' in adapter.sent,
                timeout=5, interval=0.01, what='the fresh interrupted turn to finish',
            )
        assert model_turn.await_count == expected_turns
        if expected_turns:
            assert 'Resumed answer' in adapter.sent
        else:
            assert adapter.sent == []  # no answer or restored notice
    finally:
        runner.session_store._db.close()
