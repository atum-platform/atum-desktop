"""Offline regression contracts for bounded recovery and durable Matrix intake."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_poison_admission_has_three_resume_boots_then_alert(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from gateway.resume_policy import resume_boot_allowed
    authority = SimpleNamespace(runner=SimpleNamespace(), epoch='boot')
    row = {'admission_id': 'poison'}
    assert [await resume_boot_allowed(authority, row) for _ in range(6)] == [True]*3 + [False]*3
    from gateway.status import read_runtime_status
    assert read_runtime_status()['platforms']['matrix']['error_code'] == 'restart_loop'


@pytest.mark.asyncio
async def test_persistent_intake_wedge_backs_off_and_ledgers_once(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from tests.gateway.test_matrix_durable_intake import adapter
    a = adapter(tmp_path)
    a._joined_rooms = {'!room:example.org'}
    a.send = AsyncMock(return_value=SimpleNamespace(success=True))
    from plugins.platforms.matrix.intake import IntakeGapError
    delays = [await a._intake_failure(IntakeGapError('frontier missing')) for _ in range(8)]
    assert delays == [5, 10, 20, 40, 80, 160, 300, 300]
    assert a.send.await_count == 1
    assert a.send.call_args.kwargs['metadata']['delivery_obligation_id']
    assert a.get_diagnostics()['intake']['last_error']
    from gateway.status import read_runtime_status
    from gateway.readiness import _probe_gateway
    assert _probe_gateway(read_runtime_status())['status'] == 'degraded'
    a._intake.close()


def test_h14_fails_closed_without_process_exit(tmp_path, monkeypatch):
    monkeypatch.setenv('ATUM_FAULT_TEST', '1')
    monkeypatch.setenv('ATUM_FAULT_POINT', 'H14')
    monkeypatch.setenv('ATUM_FAULT_ONCE', str(tmp_path/'once'))
    monkeypatch.setattr('os._exit', lambda code: pytest.fail('gap hook exited'))
    from gateway.fault_injection import hit
    hit('H14')


def test_fault_without_once_is_inert(monkeypatch):
    monkeypatch.setenv('ATUM_FAULT_TEST', '1')
    monkeypatch.setenv('ATUM_FAULT_POINT', 'H4')
    monkeypatch.delenv('ATUM_FAULT_ONCE', raising=False)
    from gateway.fault_injection import hit
    hit('H4')


@pytest.mark.asyncio
async def test_matrix_downtime_ok_uses_server_time(tmp_path):
    from tests.gateway.test_matrix_durable_intake import adapter
    from gateway.resume_policy import pending_resume_policy, ResumePolicy
    from gateway.session import SessionStore, SessionSource
    from gateway.config import Platform, GatewayConfig
    a = adapter(tmp_path)
    a._resolve_message_context = AsyncMock(return_value=('ok', True, 'dm', None, 'Alice',
        SessionSource(platform=Platform.MATRIX, chat_id='!room:example.org', user_id='@alice:example.org')))
    a._extract_reply_context = AsyncMock(return_value=('ok', None, None, None, None))
    a.handle_message = AsyncMock()
    await a._handle_text_message('!room:example.org', '@alice:example.org', '$old', 1.0,
                                 {'body': 'ok'}, {})
    event = a.handle_message.call_args.args[0]
    store = SessionStore(sessions_dir=tmp_path/'sessions', config=GatewayConfig())
    entry = store.get_or_create_session(event.source)
    pending_resume_policy(store, entry, ResumePolicy(True, ('write',), frozenset()), '', can_resolve=False)
    assert pending_resume_policy(store, entry, None, 'ok', can_resolve=True,
                                 message_timestamp=event.timestamp.isoformat()).ask
    a._intake.close()
