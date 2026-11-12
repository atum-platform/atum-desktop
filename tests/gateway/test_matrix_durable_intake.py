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
    client = SimpleNamespace(sync=AsyncMock(return_value=batch('$ancient', '$recent')))
    await a._connect_initial_sync(client)
    dispatched = a._dispatch_sync.await_args.args[0]
    assert dispatched['rooms']['join']['!room:example.org']['timeline']['events'] == []
    assert a._intake.get('frontier') == {'!room:example.org': '$recent'}


@pytest.mark.asyncio
async def test_limited_timeline_paginated_deduplicated_oldest_first():
    b = batch('$six', '$seven', limited=True)
    client = SimpleNamespace(get_messages=AsyncMock(side_effect=[
        SimpleNamespace(chunk=[event('$six'), event('$five'), event('$four')], end='page-1'),
        SimpleNamespace(chunk=[event('$three'), event('$two'), event('$one')], end='page-2')]))
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
    client = SimpleNamespace(get_messages=AsyncMock(return_value=SimpleNamespace(chunk=[], end=None)))
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
