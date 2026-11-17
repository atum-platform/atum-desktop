"""Offline regression contracts for bounded recovery and durable Matrix intake."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest




@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['gap', 'ambiguous', 'journal'])
async def test_persistent_intake_wedge_backs_off_and_ledgers_once(tmp_path, monkeypatch, kind):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from tests.gateway.test_matrix_durable_intake import adapter
    a = adapter(tmp_path)
    a.config.extra['control_room'] = '!owner:example.org'
    a._joined_rooms = {'!room:example.org'}
    if kind == 'gap':
        a._joined_rooms.clear()
        with a._intake.db:
            a._intake._put('frontier', {'!room:example.org': '$frontier'})
    a.send = AsyncMock(return_value=SimpleNamespace(success=True))
    from gateway.status import write_runtime_status
    write_runtime_status(gateway_state='running')
    from plugins.platforms.matrix.intake import IntakeGapError, IntakeAmbiguousError, IntakeJournalError
    error = {'gap': IntakeGapError('frontier missing'), 'ambiguous': IntakeAmbiguousError('ambiguous control'),
             'journal': IntakeJournalError('journal unavailable')}[kind]
    delays = [await a._intake_failure(error) for _ in range(8)]
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
@pytest.mark.parametrize('storage_error', ['os', 'sqlite'])
async def test_h12_runtime_retry_delivers_without_restart(tmp_path, monkeypatch, storage_error):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('ATUM_FAULT_TEST', '1')
    monkeypatch.setenv('ATUM_FAULT_POINT', 'H12')
    monkeypatch.setenv('ATUM_FAULT_ONCE', str(tmp_path/'once'))
    if storage_error == 'sqlite':
        from gateway import fault_injection
        import sqlite3
        original = fault_injection.hit
        def hit(point):
            try:
                original(point)
            except OSError as exc:
                raise sqlite3.OperationalError('database or disk is full') from exc
        monkeypatch.setattr(fault_injection, 'hit', hit)
    from tests.gateway.test_matrix_durable_intake import adapter
    from gateway.platforms.event import MessageEvent
    from gateway.session import SessionSource
    from gateway.config import Platform
    a = adapter(tmp_path)
    sent = []
    class Wire:
        async def send_message_event(self, room, kind, content, txn_id):
            sent.append(content)
            return '$reply'
    a._client = Wire()
    a._final_delivery_adapter = lambda source: a
    a._release_turn_marker = AsyncMock()
    a._finalize_delivery_obligation = AsyncMock()
    event = MessageEvent(text='work', message_id='$source', source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room:example.org'))
    result, _ = await a.send_final_ledgered(event, 's', 'answer', {}, reply_to=None)
    assert result.success
    assert len(sent) == 1
    assert sent[0]['org.hermes.source_event_id'] == '$source'
    a._release_turn_marker.assert_awaited_once()
    a._intake.close()


@pytest.mark.asyncio
async def test_sync_batch_admits_in_server_order(tmp_path):
    from tests.gateway.test_matrix_durable_intake import adapter, batch
    from plugins.platforms.matrix.adapter import MatrixAdapter
    a = adapter(tmp_path)
    a._dispatch_sync = MatrixAdapter._dispatch_sync.__get__(a)
    seen = []
    async def receive(raw):
        if raw['event_id'] == '$first':
            await asyncio.sleep(.02)
        seen.append(raw['event_id'])
        a._intake.mark(raw['event_id'], 'native', room_id='!room:example.org')
    class Wire:
        def handle_sync(self, data):
            return [asyncio.create_task(receive(raw)) for room in data.get('rooms', {}).get('join', {}).values()
                    for raw in room.get('timeline', {}).get('events', [])]
    a._client = Wire()
    await a._dispatch_sync(batch('$first', '$second'))
    assert seen == ['$first', '$second']
    a._intake.close()


@pytest.mark.asyncio
async def test_clean_restart_adopts_held_reply_and_delivers(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from tests.gateway.test_active_turn_recovery import _db_runner
    from gateway.session import SessionSource
    from gateway.config import Platform
    from gateway.delivery_ledger import sweep_recoverable
    runner, store = _db_runner(tmp_path)
    source = SessionSource(platform=Platform.MATRIX, chat_id='!room:example.org')
    entry = store.get_or_create_session(source)
    store.mark_turn_active(entry.session_key)
    store.append_to_transcript(entry.session_id, {'role': 'user', 'content': 'work', 'platform_message_id': '$source'})
    store.append_to_transcript(entry.session_id, {'role': 'assistant', 'content': 'answer'})
    marker = tmp_path/'.clean_shutdown'
    marker.write_text('clean')
    await runner._consume_clean_shutdown_marker(marker)
    rows = sweep_recoverable()
    assert len(rows) == 1
    a = SimpleNamespace(send=AsyncMock(return_value=SimpleNamespace(success=True)))
    runner._obligation_adapter = AsyncMock(return_value=a)
    runner._arm_flood_timers_for_waiting_rows = AsyncMock()
    assert await runner._redeliver_claimed_obligations(rows) == 1
    assert a.send.call_args.kwargs['content'] == 'answer'
    from gateway.delivery_ledger import matrix_send_plan
    plan = matrix_send_plan(rows[0]['obligation_id'], '!room:example.org', [{'body':'answer'}], sender_id='test')
    assert plan[0]['content']['org.hermes.source_event_id'] == '$source'
    store._db.close()





def test_fault_boot_warning_is_loud(monkeypatch, caplog):
    monkeypatch.setenv('ATUM_FAULT_TEST', '1')
    from gateway.fault_injection import warn_at_boot
    warn_at_boot()
    assert any(row.levelname == 'CRITICAL' and 'FAULT INJECTION ENABLED' in row.message
               for row in caplog.records)


def test_h3a_hook_precedes_intake_mark():
    import inspect
    from plugins.platforms.matrix.adapter import MatrixAdapter
    source = inspect.getsource(MatrixAdapter.handle_message)
    assert source.index('hit("H3a")') < source.index('store.mark(event.message_id, "native"')
