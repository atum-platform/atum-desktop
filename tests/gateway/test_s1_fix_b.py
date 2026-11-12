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
    a._resolve_message_context = AsyncMock(return_value=('yes', True, 'dm', None, 'Alice',
        SessionSource(platform=Platform.MATRIX, chat_id='!room:example.org', user_id='@alice:example.org')))
    a._extract_reply_context = AsyncMock(return_value=('yes', None, None, None, None))
    a.handle_message = AsyncMock()
    store = SessionStore(sessions_dir=tmp_path/'sessions', config=GatewayConfig())
    source = a._resolve_message_context.return_value[-1]
    entry = store.get_or_create_session(source)
    pending_resume_policy(store, entry, ResumePolicy(True, ('write',), frozenset()), '', can_resolve=False)
    await a._handle_text_message('!room:example.org', '@alice:example.org', '$old', 1.0,
                                 {'body': 'yes'}, {})
    event = a.handle_message.call_args.args[0]
    assert pending_resume_policy(store, entry, None, 'yes', can_resolve=True,
                                 message_timestamp=event.timestamp.isoformat()).ask
    a._intake.close()


@pytest.mark.asyncio
async def test_h12_runtime_retry_delivers_without_restart(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('ATUM_FAULT_TEST', '1')
    monkeypatch.setenv('ATUM_FAULT_POINT', 'H12')
    monkeypatch.setenv('ATUM_FAULT_ONCE', str(tmp_path/'once'))
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


@pytest.mark.asyncio
async def test_poison_reclaim_path_stops_before_fourth_model_turn(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from hermes_state import SessionDB
    from hermes_state_runtime import (begin_runtime_epoch, admit_session_input, claim_session_input,
        recover_session_inputs, list_session_admissions)
    from gateway.resume_policy import recover_unknown_admission
    db = SessionDB(db_path=tmp_path/'state.db')
    db.create_session('s', 'matrix')
    epoch = begin_runtime_epoch(db, instance_id='first')
    row = admit_session_input(db, epoch=epoch, principal_id='messaging:test', session_id='s',
                             request_id='$poison', payload={'native_text_v1': {}, 'text':'safe read'})
    claim_session_input(db, epoch=epoch, session_id='s')
    authority = SimpleNamespace(db=db, runner=SimpleNamespace(
        _delivery_adapter_for=lambda source: SimpleNamespace(tool_aware_resume=True)))
    resumed = 0
    for boot in range(6):
        authority.epoch = begin_runtime_epoch(db, instance_id=str(boot))
        recover_session_inputs(db, epoch=authority.epoch)
        rows = list_session_admissions(db, session_id='s', pending_only=False)
        allowed = await recover_unknown_admission(authority, None, SimpleNamespace(source=None), rows)
        if allowed:
            resumed += 1
            assert claim_session_input(db, epoch=authority.epoch, session_id='s')
        else:
            assert rows[0]['status'] == 'unknown'
    assert resumed == 3
    db.close()
