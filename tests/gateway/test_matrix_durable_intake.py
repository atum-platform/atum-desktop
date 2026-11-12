"""Offline crash boundaries: real SQLite, fake Matrix transport, no homeserver."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.event import MessageEvent
from plugins.platforms.matrix.adapter import MatrixAdapter
from plugins.platforms.matrix.intake import MatrixIntakeStore, IntakeGapError, fill_gaps


def event(eid):
    return {'event_id': eid, 'sender': '@alice:example.org', 'type': 'm.room.message',
            'origin_server_ts': 1, 'content': {'msgtype': 'm.text', 'body': 'hello'}}


def batch(*ids, token='opaque/sync-token', limited=False):
    return {'next_batch': token, 'rooms': {'join': {'!room:example.org': {
        'timeline': {'events': [event(i) for i in ids], 'limited': limited, 'prev_batch': 'page-0'}}}}}


def adapter(tmp_path):
    a = MatrixAdapter(PlatformConfig(enabled=True, token='fixture-token', extra={
        'homeserver': 'https://matrix.example.org', 'user_id': '@bot:example.org',
        'allowed_users': '@alice:example.org'}))
    a._intake = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    a._refresh_dm_cache = AsyncMock()
    a._warn_encrypted_drops = MagicMock()
    a._schedule_pending_invite_joins = MagicMock()
    a._dispatch_sync = AsyncMock()
    return a


@pytest.mark.asyncio
async def test_cursor_never_commits_without_recoverable_payload(tmp_path):
    a = adapter(tmp_path)
    a._dispatch_sync.side_effect = RuntimeError('crash after cursor commit')
    with pytest.raises(RuntimeError):
        await a._absorb_sync(SimpleNamespace(), batch('$one'))
    a._intake.close()
    reopened = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    assert await reopened.get_next_batch() == 'opaque/sync-token'
    assert reopened.get('pending') == batch('$one')
    with pytest.raises(RuntimeError):
        await reopened.put_next_batch('unaccepted-token')
    reopened.close()


@pytest.mark.asyncio
async def test_accept_transaction_rolls_back_cursor_and_payload(tmp_path):
    store = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    original = store._put
    def fail(key, value):
        if key == 'next_batch':
            raise RuntimeError('power failure before cursor write')
        original(key, value)
    store._put = fail
    with pytest.raises(RuntimeError):
        store.accept(batch('$one'))
    assert await store.get_next_batch() is None
    assert store.get('pending') is None
    store.close()


@pytest.mark.asyncio
async def test_restart_recovers_acceptance_before_turn_start(tmp_path):
    a = adapter(tmp_path)
    a._intake.accept(batch('$one'))
    client = SimpleNamespace(sync=AsyncMock(return_value=batch('$two', token='next')))
    await a._connect_initial_sync(client)
    assert a._dispatch_sync.await_args_list[0].args[0] == batch('$one')
    assert client.sync.await_args.kwargs['since'] == 'opaque/sync-token'
    assert a._intake.get('pending') is None


@pytest.mark.asyncio
async def test_first_start_does_not_replay_old_history(tmp_path):
    a = adapter(tmp_path)
    client = SimpleNamespace(sync=AsyncMock(return_value=batch('$ancient', '$recent', limited=True)))
    await a._connect_initial_sync(client)
    dispatched = a._dispatch_sync.await_args.args[0]
    assert dispatched['rooms']['join']['!room:example.org']['timeline']['events'] == []
    assert a._intake.get('frontier') == {'!room:example.org': '$recent'}


@pytest.mark.asyncio
async def test_limited_timeline_paginated_deduplicated_oldest_first():
    b = batch('$six', '$seven', limited=True)
    client = SimpleNamespace(get_messages=AsyncMock(side_effect=[
        SimpleNamespace(events=[event('$six'), event('$five'), event('$four')], end='page-1'),
        SimpleNamespace(events=[event('$three'), event('$two'), event('$one')], end='page-2')]))
    # Stub only the enum if optional mautrix isn't installed in the test env.
    import sys
    from types import ModuleType
    types = ModuleType('mautrix.types')
    types.PaginationDirection = SimpleNamespace(BACKWARD='b')
    with patch.dict(sys.modules, {'mautrix.types': types}):
        await fill_gaps(client, b, {'!room:example.org': '$one'})
    ids = [e['event_id'] for e in b['rooms']['join']['!room:example.org']['timeline']['events']]
    assert ids == ['$two', '$three', '$four', '$five', '$six', '$seven']
    assert client.get_messages.await_count == 2


@pytest.mark.asyncio
async def test_missing_frontier_fails_closed():
    import sys
    from types import ModuleType
    types = ModuleType('mautrix.types')
    types.PaginationDirection = SimpleNamespace(BACKWARD='b')
    client = SimpleNamespace(get_messages=AsyncMock(return_value=SimpleNamespace(events=[], end=None)))
    with patch.dict(sys.modules, {'mautrix.types': types}), pytest.raises(IntakeGapError):
        await fill_gaps(client, batch('$new', limited=True), {'!room:example.org': '$lost'})


@pytest.mark.asyncio
async def test_unknown_token_recovers_from_frontier_not_time(tmp_path):
    a = adapter(tmp_path)
    old = batch('$one')
    a._intake.accept(old)
    a._intake.finish(old)
    error = RuntimeError('unknown sync token')
    error.errcode = 'M_UNKNOWN_POS'
    client = SimpleNamespace(sync=AsyncMock(side_effect=[error, batch('$one', '$two', token='new')]))
    with patch('plugins.platforms.matrix.intake.fill_gaps', new_callable=AsyncMock) as recover:
        await a._connect_initial_sync(client)
    assert recover.await_args_list[0].kwargs == {'reset': True}
    assert recover.await_args_list[0].args[2] == {'!room:example.org': '$one'}
    assert client.sync.await_args_list[0].kwargs['since'] == 'opaque/sync-token'
    assert await a._intake.get_next_batch() == 'new'


@pytest.mark.asyncio
async def test_native_handoff_survives_midturn_restart_and_duplicate(tmp_path):
    a = adapter(tmp_path)
    a._intake.mark('$one', 'native', 'native-receipt')
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    a._handle_text_message = AsyncMock()
    raw = event('$one')
    e = SimpleNamespace(room_id='!room:example.org', sender=raw['sender'],
                        event_id='$one', timestamp=1, content=raw['content'])
    await a._on_room_message(e)
    await a._on_room_message(e)
    a._handle_text_message.assert_not_awaited()
    a._intake.close()
    b = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    assert b.state('$one') == 'native'  # native queued/started/unknown state owns recovery
    b.close()


@pytest.mark.asyncio
async def test_authorized_downtime_message_bypasses_startup_age_filter(tmp_path):
    a = adapter(tmp_path)
    a._startup_ts = 9999999999
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    a._handle_text_message = AsyncMock()
    await a._on_room_message(SimpleNamespace(room_id='!room:example.org', sender='@alice:example.org',
        event_id='$one', timestamp=1, content=event('$one')['content']))
    a._handle_text_message.assert_awaited_once()


@pytest.mark.asyncio
async def test_owner_gate_remains_before_native_admission(tmp_path):
    a = adapter(tmp_path)
    a._is_authorized_user = MagicMock(return_value=False)
    e = MessageEvent(text='hello', source=a.build_source(chat_id='!room:example.org',
        chat_type='dm', user_id='@mallory:example.org'), message_id='$denied')
    await a.handle_message(e)
    assert a._intake.state('$denied') is None


@pytest.mark.asyncio
async def test_native_commit_callback_records_acceptance_separately_from_effects(tmp_path):
    from gateway.session_authority import SessionAuthority
    a = adapter(tmp_path)
    e = SimpleNamespace(_on_transport_commit=lambda receipt: a._intake.mark(
        '$one', 'native', receipt.admission_id))
    authority = SimpleNamespace(_receipt=lambda row: SimpleNamespace(admission_id=row['admission_id']),
                                _publish_pending=MagicMock())
    row = {'status': 'started', 'admission_id': 'native-one'}
    SessionAuthority._admitted(authority, None, e, row)
    assert a._intake.state('$one') == 'native'
    assert e._gateway_accepted is True
    # 'native' means the native session owns unfinished execution, not that
    # tools or the final response have completed.
    assert row['status'] == 'started'


@pytest.mark.asyncio
async def test_durable_handoff_is_not_process_local_base_acceptance(tmp_path):
    from gateway.platforms.base import BasePlatformAdapter
    a = adapter(tmp_path)
    a.gateway_runner = SimpleNamespace(session_authority=object())
    a._is_authorized_user = MagicMock(return_value=True)
    e = MessageEvent(text='hello', source=a.build_source(chat_id='!room:example.org',
        chat_type='dm', user_id='@alice:example.org'), message_id='$accepted')
    gate = asyncio.Event()
    async def fake_base(_adapter, ev):
        async def run():
            await gate.wait()
            ev._on_transport_commit(SimpleNamespace(admission_id='receipt-one'))
            await asyncio.Event().wait()  # the turn remains in flight
        a._session_tasks[a._event_session_key(ev)] = asyncio.create_task(run())
    with patch.object(BasePlatformAdapter, 'handle_message', fake_base):
        intake = asyncio.create_task(a.handle_message(e))
        await asyncio.sleep(0)
        assert not intake.done()
        assert a._intake.state('$accepted') == 'pending'
        gate.set()
        await asyncio.wait_for(intake, 2)
        assert a._intake.state('$accepted') == 'native'
        for task in a._session_tasks.values():
            task.cancel()
        await asyncio.gather(*a._session_tasks.values(), return_exceptions=True)


@pytest.mark.asyncio
async def test_inline_control_crash_stays_ambiguous(tmp_path):
    from gateway.session_ingress_context import transport_control
    a = adapter(tmp_path)
    e = SimpleNamespace(_transport_control_state=lambda state: a._intake.mark('$control', state))
    async def crash():
        raise RuntimeError('crash at an external control effect')
    with pytest.raises(RuntimeError):
        await transport_control(e, crash)
    assert a._intake.state('$control') == 'ambiguous'
    async def consumed():
        return True
    await transport_control(e, consumed)
    assert a._intake.state('$control') == 'done'


@pytest.mark.asyncio
async def test_undecrypted_event_is_retained(tmp_path):
    a = adapter(tmp_path)
    # Exercise the real dispatcher, not the fixture's dispatch mock.
    a._client = SimpleNamespace(handle_sync=lambda data: [])
    b = batch('$encrypted')
    b['rooms']['join']['!room:example.org']['timeline']['events'][0]['type'] = 'm.room.encrypted'
    with pytest.raises(RuntimeError, match='awaits decryption'):
        await MatrixAdapter._dispatch_sync(a, b)


@pytest.mark.asyncio
async def test_pagination_with_pinned_mautrix_response_type():
    types = pytest.importorskip('mautrix.types')
    b = batch('$three', limited=True)
    response = types.PaginatedMessages(start='page-0', end=None,
        events=[types.Event.deserialize({**event('$two'), 'room_id': '!room:example.org'}),
                types.Event.deserialize({**event('$one'), 'room_id': '!room:example.org'})])
    client = SimpleNamespace(get_messages=AsyncMock(return_value=response))
    await fill_gaps(client, b, {'!room:example.org': '$one'})
    assert [e['event_id'] for e in b['rooms']['join']['!room:example.org']['timeline']['events']] == ['$two', '$three']


@pytest.mark.asyncio
async def test_connect_takes_account_lock_before_any_sync(tmp_path):
    import sys
    from types import ModuleType
    a = adapter(tmp_path)
    a._resolve_store_dir = lambda: tmp_path
    a._store_dir = tmp_path
    a._connect_authenticate = AsyncMock(return_value=True)
    a._acquire_platform_lock = MagicMock(return_value=False)
    a._release_platform_lock = MagicMock()
    client = SimpleNamespace(sync=AsyncMock(), api=SimpleNamespace(session=SimpleNamespace(close=AsyncMock())))
    api = ModuleType('mautrix.api')
    api.HTTPAPI = lambda **kwargs: client.api
    clients = ModuleType('mautrix.client')
    clients.Client = lambda **kwargs: client
    state = ModuleType('mautrix.client.state_store')
    state.MemoryStateStore = MagicMock
    state.MemorySyncStore = MagicMock
    with patch.dict(sys.modules, {'mautrix.api': api, 'mautrix.client': clients,
                                 'mautrix.client.state_store': state}), patch(
            'plugins.platforms.matrix.adapter._create_matrix_session', return_value=MagicMock()):
        assert await a.connect() is False
    a._acquire_platform_lock.assert_called_once_with(
        'matrix', '["https://matrix.example.org", "@bot:example.org"]', 'Matrix account')
    client.sync.assert_not_awaited()
    a._release_platform_lock.assert_called_once()


@pytest.mark.asyncio
async def test_first_baseline_crash_cannot_replay_history(tmp_path):
    store = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    original = store._put
    def crash(key, value):
        original(key, value)
        if key == 'next_batch':
            raise RuntimeError('crash during baseline transaction')
    store._put = crash
    with pytest.raises(RuntimeError):
        store.baseline(batch('$old'))
    assert await store.get_next_batch() is None
    assert store.get('pending') is None
    store._put = original
    store.baseline(batch('$old'))
    store.close()
    reopened = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    assert reopened.get('pending') is None
    assert reopened.get('frontier') == {'!room:example.org': '$old'}
    reopened.close()
