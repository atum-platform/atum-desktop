"""Offline Matrix connect/backlog regressions through the real native admission path."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import GatewayConfig, Platform
from gateway.platforms.base import SendResult
from gateway.platforms.event import MessageEvent
from gateway.run import GatewayRunner
from gateway.session_authority import initialize_session_authority
from plugins.platforms.matrix.adapter import MatrixAdapter
from tests.gateway.test_matrix_durable_intake import adapter, batch
from tests.waiting import async_wait_until


async def native_runner(tmp_path, monkeypatch, a, instance):
    monkeypatch.setenv('MATRIX_ALLOWED_USERS', '@alice:example.org')
    runner = GatewayRunner(GatewayConfig(sessions_dir=tmp_path / 'sessions'))
    authority = await initialize_session_authority(runner, profile_id='default', instance_id=instance)
    a.gateway_runner = runner
    runner._wire_adapter_handlers(a)
    a.config.typing_indicator = False
    a.send_typing = AsyncMock()
    a.on_processing_start = AsyncMock()
    a.on_processing_complete = AsyncMock()
    return runner, authority


def message(a, text='hello', eid='$one'):
    return MessageEvent(text=text, message_id=eid, source=a.build_source(
        chat_id='!room:example.org', chat_type='dm', user_id='@alice:example.org'))


@pytest.mark.asyncio
@pytest.mark.parametrize('reset', [None, '/reset', '/new'], ids=['plain-restart', 'reset-restart', 'new-restart'])
async def test_connect_backlog_has_15_linked_finals_and_no_error_notices(tmp_path, monkeypatch, reset):
    from gateway.session_ingress import executing_admission
    from gateway.session_results import execution_result

    a = adapter(tmp_path)
    runner, authority = await native_runner(tmp_path, monkeypatch, a, 'before-restart')
    runner.adapters[Platform.MATRIX] = a
    source = message(a).source
    old = authority.register(source)
    if reset:
        # Real native command dispatch, not a manual edit to the routing store.
        a.send = AsyncMock(return_value=SendResult(success=True, message_id='$reset-notice'))
        await a.handle_message(message(a, reset, '$reset'))
        await async_wait_until(lambda: not a._session_tasks, timeout=15, what='reset completed')
    key = runner._session_key_for_source(source)
    expected_sid = runner.session_store.peek_session_id(key)
    assert (expected_sid != old.session_id) is bool(reset)
    a._intake.close()
    authority.db.close()

    # A fresh runner/authority/adapter with only persisted routing and intake state.
    a = adapter(tmp_path)
    runner, authority = await native_runner(tmp_path, monkeypatch, a, 'after-restart')
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    a._startup_ts = 9999999999
    publications = []
    async def send(chat_id, content, reply_to=None, metadata=None):
        publications.append((reply_to, content))
        return SendResult(success=True, message_id=f'$reply-{len(publications)}')
    a.send = send
    async def turn(ev, source, quick_key, run_generation):
        assert executing_admission.get()
        execution_result.get()['result'] = {'final_response': ev.text, 'messages': []}
        return ev.text
    monkeypatch.setattr(runner, '_handle_message_with_agent', turn)
    async def inbound(room, sender, eid, timestamp, content, relates):
        await a.handle_message(message(a, eid, eid))
    a._handle_text_message = inbound
    async def handle_sync(data):
        for raw in data['rooms']['join']['!room:example.org']['timeline']['events']:
            await a._on_room_message(SimpleNamespace(room_id='!room:example.org', sender=raw['sender'],
                event_id=raw['event_id'], timestamp=1, content=raw['content']))
        return []
    a._client = SimpleNamespace(handle_sync=handle_sync)
    a._dispatch_sync = lambda data: MatrixAdapter._dispatch_sync(a, data)
    ids = [f'$backlog-{i:02}' for i in range(15)]
    baseline = batch('$baseline', token='before-stop')
    a._intake.accept(baseline)
    a._intake.finish(baseline)
    backlog = batch(*ids)
    attempts = []
    async def connect(**kwargs):
        # Matrix's real connect dispatches sync BEFORE it returns to the runner.
        try:
            await a._absorb_sync(a._client, backlog)
        except RuntimeError as exc:
            attempts.append(str(exc))
        return True
    a.connect = connect
    try:
        outcomes = await runner._start_connect_pending([(Platform.MATRIX, a.config, a)])
        await runner._start_aggregate_connect_results(outcomes, [], [])
        assert attempts == [], attempts
        await async_wait_until(lambda: len(publications) >= 15, timeout=20, what='15 linked finals')
        await async_wait_until(lambda: not a._session_tasks, timeout=15, what='all adapter tasks settled')
        assert publications == [(eid, eid) for eid in ids]
        assert runner.session_store.peek_session_id(key) == expected_sid
        assert expected_sid in authority.sessions
        assert authority.db.get_session(expected_sid) is not None
        await a._dispatch_sync(backlog)  # replay owes no duplicate final or notice
        assert publications == [(eid, eid) for eid in ids]
    finally:
        await a.cancel_background_tasks()
        a._intake.close()
        authority.db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('terminal', [False, True], ids=['retained-retry', 'terminal'])
@pytest.mark.parametrize('language', ['en', 'es'])
async def test_error_notice_only_for_terminal_attempt(tmp_path, monkeypatch, terminal, language):
    from agent import i18n
    monkeypatch.setenv('HERMES_LANGUAGE', language)
    i18n.reset_language_cache()
    a = adapter(tmp_path)
    a.config.typing_indicator = False
    a.gateway_runner = SimpleNamespace(session_authority=SimpleNamespace(
        native_transport_receipt=AsyncMock(return_value=None)))
    a._is_authorized_user = MagicMock(return_value=True)
    a.send = AsyncMock(return_value=SendResult(success=True, message_id='$notice'))
    a.on_processing_start = AsyncMock()
    a.on_processing_complete = AsyncMock()
    e = message(a)
    async def fail(ev):
        if terminal:
            ev._on_transport_commit(SimpleNamespace(admission_id='committed'))
        raise RuntimeError('private transient diagnosis must not reach chat')
    a.set_message_handler(fail)
    try:
        for _ in range(2):
            if terminal:
                await a.handle_message(e)
            else:
                with pytest.raises(RuntimeError, match='retaining batch'):
                    await a.handle_message(e)
            await async_wait_until(lambda: not a._session_tasks, timeout=10, what='attempt completed')
            if terminal:
                # Native ownership prevents a transport replay from executing/notifying again.
                a.gateway_runner.session_authority.native_transport_receipt.return_value = SimpleNamespace(
                    admission_id='committed')
        if terminal:
            a.send.assert_awaited_once()
            notice = a.send.await_args.kwargs['content']
            assert notice == i18n.t('gateway.notify.turn_error')
            assert '\n' not in notice and '/reset' not in notice
            assert 'private' not in notice and 'RuntimeError' not in notice
        else:
            a.send.assert_not_awaited()
            assert a._intake.state(e.message_id) == 'pending'
    finally:
        await a.cancel_background_tasks()
        a._intake.close()
        i18n.reset_language_cache()
