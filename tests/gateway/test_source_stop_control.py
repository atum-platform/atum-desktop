"""Same-user native control transport -> durable source Stop -> native cancellation."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest

pytestmark = pytest.mark.platforms('posix')  # existing private control peer credentials are POSIX-only


@pytest.mark.asyncio
@pytest.mark.parametrize('claimed', [False, True])
async def test_private_stop_targets_native_source_and_survives_receipt_reopen(tmp_path, monkeypatch, claimed):
    from gateway.control_socket import GatewayControlServer, query_gateway_control
    from gateway.source_control import register_source_stop
    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from gateway.platforms.event import MessageEvent
    from gateway.run import GatewayRunner
    from gateway.session import SessionSource
    from gateway.session_authority import SessionAuthority, initialize_session_authority
    from hermes_constants import get_hermes_home
    from hermes_state_runtime import claim_session_input, get_session_admission, settle_session_input
    from plugins.platforms.matrix.adapter import MatrixAdapter
    from plugins.platforms.matrix.presentation import adapter_class, Outbox
    monkeypatch.setenv('MATRIX_ALLOWED_USERS', '@owner:example.org')
    monkeypatch.setattr(SessionAuthority, '_schedule', lambda self, ref: None)
    home = get_hermes_home().resolve()
    home.chmod(0o700)
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / 'sessions'))
    authority = await initialize_session_authority(runner, profile_id=str(home), instance_id='source-stop')
    from gateway.session_authorities import SessionAuthorities
    runner.session_authorities = SessionAuthorities(home)
    runner.session_authorities.add(home, authority)
    adapter = adapter_class(MatrixAdapter)(PlatformConfig(enabled=True, token='fixture', extra={
        'homeserver': 'https://matrix.example.org', 'user_id': '@bot:example.org',
        'allowed_users': '@owner:example.org'}))
    adapter.gateway_runner = runner
    adapter._presentation_turns = {}
    path = home / 'matrix' / 'presentation.sqlite3'
    adapter._presentation_box = Outbox(path)
    adapter._interrupt_and_clear_session = AsyncMock()
    runner.adapters[Platform.MATRIX] = adapter
    source = SessionSource(platform=Platform.MATRIX, chat_id='!room:example.org',
                           user_id='@owner:example.org', chat_type='dm')
    receipt = await authority.admit_native(MessageEvent(text='queued', source=source, message_id='$target'))
    later = await authority.admit_native(MessageEvent(text='later', source=source, message_id='$later'))
    if claimed:
        row = claim_session_input(authority.db, epoch=authority.epoch, session_id=receipt.ref.session_id)
    server = GatewayControlServer(home)
    register_source_stop(server, runner, asyncio.get_running_loop())
    params = dict(profile_id=str(home), room=source.chat_id, event='$target', sender=source.user_id, action='stop')
    raw = json.dumps({'protocol': 1, 'verb': 'stop-source', 'params': params}).encode()
    assert json.loads(server.handle_request_line(raw))['ok'] is False
    assert not adapter._presentation_box.cancelled(source.chat_id, '$target', source.user_id)
    assert await server.start()
    try:
        result = await asyncio.to_thread(query_gateway_control, home, 'stop-source', params=params, timeout=8)
        assert result == {'accepted': True, 'receipt': {k: params[k] for k in ('room', 'event', 'sender')}}
        assert get_session_admission(authority.db, admission_id=later.admission_id)['status'] == 'queued'
        if claimed:
            assert authority.pending_stops[receipt.ref.session_id] == row['generation']
            from types import SimpleNamespace
            from unittest.mock import Mock
            stopped_agent = SimpleNamespace(interrupt=Mock(), clear_interrupt=Mock())
            authority.adopt_agent(receipt.ref.session_id, row['generation'], stopped_agent)
            assert stopped_agent.interrupt.called
            settle_session_input(authority.db, epoch=authority.epoch, admission_id=receipt.admission_id,
                                 generation=row['generation'], outcome='interrupted')
        else:
            saved = get_session_admission(authority.db, admission_id=receipt.admission_id)
            assert (saved['status'], saved['outcome']) == ('terminal', 'cancelled')
        successor = claim_session_input(authority.db, epoch=authority.epoch, session_id=later.ref.session_id)
        adapter._presentation_box.db.close()
        adapter._presentation_box = Outbox(path)
        params['action'] = 'receipt'
        assert (await asyncio.to_thread(query_gateway_control, home, 'stop-source', params=params, timeout=8))['accepted']
        assert authority.pending_stops.get(later.ref.session_id) != successor['generation']
        params['sender'] = '@other:example.org'
        assert not (await asyncio.to_thread(query_gateway_control, home, 'stop-source', params=params, timeout=8))['accepted']
    finally:
        await server.stop()
        adapter._presentation_box.db.close()
        authority.db.close()
