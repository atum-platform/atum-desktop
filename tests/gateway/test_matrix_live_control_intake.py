"""Live controls must release Matrix's serial intake, not await the owner turn."""
import asyncio
from datetime import datetime, UTC
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize('control', ['approval', 'steer', 'redirect', 'clarify'])
async def test_adapter_consumed_control_keeps_other_rooms_and_stop_readable(tmp_path, monkeypatch, control):
    from gateway.config import GatewayConfig, Platform
    from gateway.platforms.base import SendResult
    from gateway.platforms.event import MessageEvent
    from gateway.run import GatewayRunner
    from gateway.session_authority import SessionAuthority, initialize_session_authority
    from tools.approval import _gateway_queues
    from tools.approval_gateway_wait import _ApprovalEntry
    from tools import clarify_gateway
    from tests.gateway.test_matrix_durable_intake import adapter

    monkeypatch.setenv('MATRIX_ALLOWED_USERS', '@alice:example.org')
    monkeypatch.setattr(SessionAuthority, '_schedule', lambda self, ref: None)
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / 'sessions'))
    a = adapter(tmp_path)
    runner.adapters[Platform.MATRIX] = a
    a.gateway_runner = runner
    authority = await initialize_session_authority(runner, profile_id='default', instance_id='adapter-controls')
    runner._wire_adapter_handlers(a)
    a.send = AsyncMock(return_value=SendResult(success=True, message_id='$notice'))
    a.send_typing = AsyncMock()
    a.on_processing_start = AsyncMock()
    a.on_processing_complete = AsyncMock()
    monkeypatch.setattr(runner, '_effective_busy_input_mode', lambda source: 'steer' if control == 'steer' else 'interrupt')
    source = a.build_source(chat_id='!room:example.org', user_id='@alice:example.org', chat_type='dm')
    key = runner._session_key_for_source(source)
    running = SimpleNamespace(interrupt=MagicMock(), steer=MagicMock(return_value=True),
        redirect=MagicMock(return_value=True), _supports_active_turn_redirect=control == 'redirect',
        get_activity_summary=lambda: {})
    turn = runner._session_state(key).turn
    turn.agent = running
    turn.event = MessageEvent(text='long task', source=source, message_id='$long')
    owner = asyncio.create_task(asyncio.Event().wait())
    a._session_tasks[key] = owner
    a._active_sessions[key] = asyncio.Event()
    approval = _ApprovalEntry({'command': 'rm -rf build'})
    if control == 'approval':
        _gateway_queues.setdefault(key, []).append(approval)
    if control == 'clarify':
        clarify = clarify_gateway.register('fixture-clarify', key, 'Which file?', None)

    async def serial_reader():
        e = MessageEvent(text='yes' if control == 'approval' else 'use the other file', source=source,
            message_id='$control', timestamp=datetime.now(UTC))
        await a.handle_message(e)
        assert a._intake.state('$control') == 'done'
        assert not owner.done(), 'consuming a reply must not finish the long turn'
        if control == 'approval':
            assert approval.event.is_set() and approval.result == 'once'
        elif control == 'clarify':
            assert clarify.event.is_set() and clarify.response == 'use the other file'
        else:
            getattr(running, control).assert_called_once()
        other = a.build_source(chat_id='!other:example.org', user_id='@alice:example.org', chat_type='dm')
        await a.handle_message(MessageEvent(text='hello from another room', source=other,
            message_id='$other', timestamp=datetime.now(UTC)))
        assert a._intake.state('$other') == 'native'
        await a.handle_message(MessageEvent(text='/stop', source=source,
            message_id='$stop', timestamp=datetime.now(UTC)))
        assert a._intake.state('$stop') == 'done'
        running.interrupt.assert_called()

    try:
        await asyncio.wait_for(serial_reader(), 5)
    finally:
        tasks = set(a._session_tasks.values()) | {owner}
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        _gateway_queues.pop(key, None)
        if control == 'clarify':
            clarify_gateway.wait_for_response('fixture-clarify', 0.01)
        a._intake.close()
        authority.db.close()
