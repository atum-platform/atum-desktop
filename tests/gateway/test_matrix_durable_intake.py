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
    assert a._dispatch_sync.await_args_list[0].args[0] == dict(batch('$one'), _matrix_backlog=True)
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
    assert a._intake.db.execute('SELECT room_id FROM intake_events WHERE event_id=?', ('$one',)).fetchone()[0] == '!room:example.org'


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
async def test_inline_control_crash_keeps_typed_failure_obligation(tmp_path):
    from gateway.session_ingress_context import transport_control
    a = adapter(tmp_path)
    e = SimpleNamespace(_transport_control_state=lambda state: a._intake.mark('$control', state))
    async def crash():
        raise RuntimeError('crash at an external control effect')
    with pytest.raises(RuntimeError):
        await transport_control(e, crash)
    assert a._intake.state('$control') == 'control_pending'
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
    await MatrixAdapter._dispatch_sync(a, b)
    assert a._intake.parked()[0][0] == '$encrypted'


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


@pytest.mark.asyncio
async def test_bootstrap_parked_callback_does_not_block_connect(tmp_path):
    import sys
    from types import ModuleType
    a = adapter(tmp_path)
    a._intake.close()
    a._intake = None
    a._resolve_store_dir = lambda: tmp_path
    a._store_dir = tmp_path
    a._connect_authenticate = AsyncMock(return_value=True)
    a._acquire_platform_lock = MagicMock(return_value=True)
    a._release_platform_lock = MagicMock()
    a._encryption = False
    a._sync_loop = AsyncMock()
    a._mark_connected = MagicMock()
    a._wire_plugin_handlers = MagicMock()
    async def parked(client):
        a._intake.accept(batch('$queued-during-bootstrap'))
        raise RuntimeError('gateway startup restore queued callback before native admission')
    a._connect_initial_sync = parked
    client = MagicMock()
    client.api.session.close = AsyncMock()
    api = ModuleType('mautrix.api')
    api.HTTPAPI = lambda **kwargs: client.api
    clients = ModuleType('mautrix.client')
    clients.Client = lambda **kwargs: client
    clients.InternalEventType = SimpleNamespace(INVITE='invite')
    dispatcher = ModuleType('mautrix.client.dispatcher')
    dispatcher.MembershipEventDispatcher = object
    state = ModuleType('mautrix.client.state_store')
    state.MemoryStateStore = MagicMock
    state.MemorySyncStore = MagicMock
    with patch.dict(sys.modules, {'mautrix.api': api, 'mautrix.client': clients,
            'mautrix.client.state_store': state, 'mautrix.client.dispatcher': dispatcher}), patch(
            'plugins.platforms.matrix.adapter._create_matrix_session', return_value=MagicMock()):
        assert await a.connect() is True
    assert a._intake.get('pending') == batch('$queued-during-bootstrap')
    await a.disconnect()


@pytest.mark.skipif(__import__('os').name != 'posix', reason='SIGKILL crash boundary requires POSIX')
def test_accepted_native_turn_recovers_after_real_owner_kill(tmp_path):
    # Reuse the production-runtime recovery probe rather than invent another
    # executor: it kills a real owner with one started and one accepted/unclaimed
    # native turn, recovers twice, and checks unknown work never repeats.
    import runpy
    from pathlib import Path
    probe = runpy.run_path(str(Path(__file__).with_name('test_session_authority.py')))
    probe['test_native_queue_survives_owner_kill_without_replaying_unknown'](tmp_path)

@pytest.mark.asyncio
async def test_real_mautrix_swallowed_failure_retains_batch_and_siblings(tmp_path):
    from mautrix.client import Client
    from mautrix.types import EventType
    a = adapter(tmp_path)
    client = Client(mxid='@bot:example.org', base_url='https://matrix.example.org', token='fixture')
    a._client = client
    a._dispatch_sync = lambda data: MatrixAdapter._dispatch_sync(a, data)
    refuse, admissions = [True], []
    async def handler(e):
        if a._intake.state(str(e.event_id)) is not None:
            return
        if str(e.event_id) == '$lost' and refuse[0]:
            raise RuntimeError('gateway refused before native admission')
        a._intake.mark(str(e.event_id), 'native', 'receipt')
        admissions.append(str(e.event_id))
    client.add_event_handler(EventType.ROOM_MESSAGE, handler, wait_sync=True)
    await client.api.session.close()  # dispatcher-only test, no network
    b = batch('$ok', '$lost')
    with pytest.raises(RuntimeError, match='durable acceptance'):
        await a._absorb_sync(client, b)
    assert a._intake.get('pending') == b
    assert a._intake.state('$ok') == 'native'
    assert a._intake.state('$lost') is None
    refuse[0] = False
    await a._dispatch_sync(a._intake.get('pending'))
    a._intake.finish(b)
    assert admissions == ['$ok', '$lost']

@pytest.mark.asyncio
@pytest.mark.parametrize('crash_after_accept', [False, True])
async def test_reply_crash_reuses_real_txnid_and_frozen_chunks(tmp_path, monkeypatch, crash_after_accept):
    from gateway import delivery_ledger as ledger
    monkeypatch.setattr(ledger, '_db_path', lambda: tmp_path / 'state.db')
    ledger.record_obligation(obligation_id='owed', session_key='matrix:room', platform='matrix',
                             chat_id='!room:example.org', thread_id=None, content='reply', source_event_id='$parent')
    a = adapter(tmp_path)
    a.max_message_length = 200
    accepted, calls = {}, []
    first = True
    async def server(room, kind, content, *, txn_id):
        nonlocal first
        calls.append((txn_id, content))
        if first:
            first = False
            if crash_after_accept:
                accepted.setdefault(txn_id, content)
            raise RuntimeError('process died before ledger ACK')
        accepted.setdefault(txn_id, content)
        return '$reply'
    a._client = SimpleNamespace(send_message_event=server)
    text = 'a long reply ' * 50
    assert not (await a.send('!room:example.org', text, reply_to='$parent',
                           metadata={'delivery_obligation_id': 'owed'})).success
    # New adapter/process, different input formatting/relations: the ledger's frozen plan wins.
    monkeypatch.setattr(ledger, '_MATRIX_SEND_PROCESS_PREFIX', 'a-different-process')
    b = adapter(tmp_path)
    b._client = SimpleNamespace(send_message_event=server)
    assert (await b.send('!room:example.org', 'changed retry input',
                        metadata={'delivery_obligation_id': 'owed'})).success
    assert calls[0] == calls[1]
    for i, payload in enumerate(accepted.values(), 1):
        assert payload['org.hermes.source_event_id'] == '$parent'
        assert payload['org.hermes.final_chunk'] == {'index': i, 'total': len(accepted)}
    assert len(accepted) > 1  # multi-chunk plan retained, prefix did not duplicate
    assert len(accepted) == len(calls) - 1


@pytest.mark.asyncio
async def test_late_keys_unblock_parked_without_blocking_next_sync(tmp_path):
    from mautrix.errors import SessionNotFound
    a = adapter(tmp_path)
    a._dispatch_sync = lambda data: MatrixAdapter._dispatch_sync(a, data)
    keys = False
    async def decrypt(e):
        if not keys:
            raise SessionNotFound('fixture-session', 'fixture-key')
        return SimpleNamespace(type='m.room.message', event_id=e.event_id)
    async def sync_handlers(data):
        nonlocal keys
        if data.get('to_device'):
            keys = True  # native crypto to-device handler persists the inbound session
        for d in data.get('rooms', {}).get('join', {}).values():
            for raw in d.get('timeline', {}).get('events', []):
                a._intake.mark(raw['event_id'], 'native', 'receipt')
        return []
    crypto = SimpleNamespace(decrypt_megolm_event=decrypt, request_room_key=AsyncMock())
    a._client = SimpleNamespace(handle_sync=sync_handlers, crypto=crypto)
    async def admitted(e):
        a._intake.mark(str(e.event_id), 'native', 'decrypted-receipt')
    a._on_room_message = AsyncMock(side_effect=admitted)
    encrypted = batch('$encrypted')
    raw = encrypted['rooms']['join']['!room:example.org']['timeline']['events'][0]
    raw.update(type='m.room.encrypted', content={'algorithm': 'm.megolm.v1.aes-sha2',
               'session_id': 'fixture-session', 'sender_key': 'fixture-key', 'ciphertext': 'fixture', 'device_id': 'DEVICE'})
    await a._absorb_sync(a._client, encrypted)
    assert a._intake.get('pending') is None
    assert a._intake.parked()
    crypto.request_room_key.assert_awaited()
    second = batch('$unrelated', token='later')
    second['to_device'] = {'events': []}
    await a._absorb_sync(a._client, second)
    assert a._intake.state('$unrelated') == 'native'
    assert a._intake.state('$encrypted') == 'native'
    assert not a._intake.parked()
    await a._retry_parked()
    a._on_room_message.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['text', 'photo'])
async def test_durable_busy_burst_keeps_each_event_receipt(tmp_path, kind):
    from gateway.session_ingress_burst import dispatch_busy_burst
    from gateway.platforms.event import MessageType
    a = adapter(tmp_path)
    a._is_queue_text_debounce_candidate = lambda e: True
    events = [SimpleNamespace(message_id=eid, _matrix_durable_intake=True, internal=False,
              message_type=MessageType.TEXT if kind == 'text' else MessageType.PHOTO)
              for eid in ('$first', '$second')]
    executed = []
    async def commit(adapter, e, key):
        if adapter._intake.state(e.message_id) is None:
            adapter._intake.mark(e.message_id, 'native', 'receipt-' + e.message_id)
            executed.append(e.message_id)
        e._gateway_accepted = True
    with patch('gateway.session_ingress.dispatch_shared_busy', side_effect=commit):
        await asyncio.gather(*(dispatch_busy_burst(a, e, 'busy') for e in events))
        # Simulate crash after native commit, before Matrix batch finish; replay both.
        await asyncio.gather(*(dispatch_busy_burst(a, e, 'busy') for e in events))
    assert executed == ['$first', '$second']
    assert all(a._intake.state(e.message_id) == 'native' for e in events)


def test_compaction_preserves_pending_parked_and_ambiguous(tmp_path):
    store = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    for eid, state in [('$old', 'done'), ('$native', 'native'), ('$held', 'native'),
                       ('$encrypted', 'done'), ('$control', 'ambiguous')]:
        store.mark(eid, state)
    store.accept(batch('$held'))
    store.park(event('$encrypted'), '!room:example.org')
    store.compact(now=10**11)
    assert store.state('$old') is None
    assert store.state('$native') is None
    assert store.state('$held') == 'native'
    assert store.state('$encrypted') == 'done'
    assert store.state('$control') == 'ambiguous'
    assert store.get('pending') == batch('$held')


def test_recovery_cli_backup_preserves_frontier(tmp_path, capsys):
    from hermes_cli.matrix_intake import cmd_matrix_intake
    path = tmp_path / 'intake.sqlite3'
    store = MatrixIntakeStore(path)
    b = batch('$control')
    store.accept(b)
    store.mark('$control', 'ambiguous')
    store.close()
    args = SimpleNamespace(store=str(path), action='status', event=None, reconciled=None)
    cmd_matrix_intake(args)
    assert 'ambiguous' in capsys.readouterr().out
    args.action, args.event, args.reconciled = 'resolve', '$control', 'verified effect completed'
    cmd_matrix_intake(args)
    assert list(tmp_path.glob('*.backup-*'))
    store = MatrixIntakeStore(path)
    assert store.state('$control') == 'done'
    assert store.get('pending') == b
    assert store.get('next_batch') == b['next_batch']


def test_disk_full_receipt_failure_retains_payload(tmp_path):
    import sqlite3
    store = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    b = batch('$lost')
    store.accept(b)
    store.db.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON intake_events BEGIN SELECT RAISE(FAIL,'database or disk is full'); END")
    with pytest.raises(sqlite3.DatabaseError):
        store.mark('$lost', 'native', 'receipt')
    store.close()
    store = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    assert store.get('pending') == b
    assert store.state('$lost') is None

@pytest.mark.asyncio
async def test_bounded_decryption_giveup_notifies_owner_once(tmp_path, monkeypatch):
    from gateway import delivery_ledger as ledger
    monkeypatch.setattr(ledger, '_db_path', lambda: tmp_path / 'state.db')
    a = adapter(tmp_path)
    raw = event('$missing-key')
    a._intake.park(raw, '!room:example.org')
    with a._intake.db:
        a._intake.db.execute('UPDATE encrypted_pending SET attempts=100')
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    a._client = SimpleNamespace(send_message_event=AsyncMock(return_value='$notice'))
    a._decrypt_parked = AsyncMock()
    await a._retry_parked()
    await a._retry_parked()
    a._decrypt_parked.assert_not_awaited()
    a._client.send_message_event.assert_awaited_once()
    assert 'stopped retrying' in a._client.send_message_event.await_args.args[2]['body']
    assert a._intake.parked()[0][0] == '$missing-key'


def test_matrix_obligation_rerecord_preserves_frozen_plan(tmp_path, monkeypatch):
    from gateway import delivery_ledger as ledger
    monkeypatch.setattr(ledger, '_db_path', lambda: tmp_path / 'state.db')
    args = dict(obligation_id='owed', session_key='matrix:r', platform='matrix', chat_id='r',
                thread_id=None, content='reply')
    ledger.record_obligation(**args)
    original = ledger.matrix_send_plan('owed', 'r', [{'body': 'original'}])
    ledger.record_obligation(**args)
    assert ledger.matrix_send_plan('owed', 'r', [{'body': 'different'}]) == original

@pytest.mark.asyncio
async def test_history_recovery_budget_fails_without_advancing_cursor(tmp_path):
    store = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    store.baseline(batch('$boundary', token='saved-token'))
    b = batch('$new', token='unaccepted-token', limited=True)
    page = [event(f'$older-{i}') for i in range(10000)]
    client = SimpleNamespace(get_messages=AsyncMock(return_value=SimpleNamespace(events=page, end='next')))
    with pytest.raises(IntakeGapError, match='exceeds'):
        await fill_gaps(client, b, store.get('frontier'))
    assert store.get('next_batch') == 'saved-token'
    assert store.get('frontier') == {'!room:example.org': '$boundary'}


def test_corrupt_journal_status_does_not_reset_or_replace(tmp_path):
    import sqlite3
    from hermes_cli.matrix_intake import cmd_matrix_intake
    path = tmp_path / 'intake.sqlite3'
    original = b'corrupt fixture, never a real account'
    path.write_bytes(original)
    with pytest.raises(sqlite3.DatabaseError):
        cmd_matrix_intake(SimpleNamespace(store=str(path), action='status'))
    assert path.read_bytes() == original


def test_process_namespaces_do_not_collide_for_same_account_reply(tmp_path, monkeypatch):
    from gateway import delivery_ledger as ledger
    plans = []
    for process in ('owner-process', 'future-audience-process'):
        monkeypatch.setattr(ledger, '_db_path', lambda: tmp_path / f'{process}.db')
        monkeypatch.setattr(ledger, '_MATRIX_SEND_PROCESS_PREFIX', process)
        ledger.record_obligation(obligation_id='same-turn', session_key='matrix:r', platform='matrix',
                                 chat_id='r', thread_id=None, content='same reply')
        plan = ledger.matrix_send_plan('same-turn', 'r', [{'body': 'same reply'}])
        assert plan[0]['txn_id'].startswith(f'hermes_{process}_')
        plans.append(plan)
    assert plans[0][0]['txn_id'] != plans[1][0]['txn_id']


@pytest.mark.asyncio
async def test_real_mautrix_malformed_encrypted_reviewer_reproduction(tmp_path):
    # Exact review trigger: untrusted sender, Megolm algorithm, missing ciphertext.
    # Real mautrix deserialization must not retain the global pending batch.
    a = adapter(tmp_path)
    a._dispatch_sync = lambda data: MatrixAdapter._dispatch_sync(a, data)
    crypto = SimpleNamespace(decrypt_megolm_event=AsyncMock(), request_room_key=AsyncMock())
    a._client = SimpleNamespace(handle_sync=lambda data: [], crypto=crypto)
    bad = batch('$bad')
    raw = bad['rooms']['join']['!room:example.org']['timeline']['events'][0]
    raw.update(type='m.room.encrypted', sender='@mallory:example.org',
               content={'algorithm': 'm.megolm.v1.aes-sha2'})
    await a._absorb_sync(a._client, bad)
    assert a._intake.get('pending') is None
    assert a._intake.state('$bad') == 'undecryptable'
    failure = a._intake.status()['encrypted'][0]
    assert 'ciphertext' in failure['failure_reason']
    assert failure['owner_action_required']
    assert a._intake.parked()[0][2] == raw
    crypto.decrypt_megolm_event.assert_not_awaited()
    crypto.request_room_key.assert_not_awaited()
    a._intake.close()


def test_recovery_retry_unknown_event_fails(tmp_path, capsys):
    from hermes_cli.matrix_intake import cmd_matrix_intake
    store = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    store.accept(batch('$retained'))
    store.close()
    args = SimpleNamespace(store=str(tmp_path / 'intake.sqlite3'), action='retry',
                           event='$typo', reconciled='owner checked')
    with pytest.raises(SystemExit) as exc:
        cmd_matrix_intake(args)
    assert exc.value.code != 0
    output = capsys.readouterr()
    assert 'not found' in output.err.lower()
    assert 'Reconciled' not in output.out
    store = MatrixIntakeStore(args.store)
    assert store.get('pending') == batch('$retained')
    assert store.get('next_batch') == 'opaque/sync-token'
    store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['wire', 'decoded', 'ciphertext'])
async def test_malformed_encryption_preserves_later_delivery_and_notice_after_restart(tmp_path, monkeypatch, failure):
    from mautrix.client import Client
    from mautrix.types import EventType
    from mautrix.errors import DecryptedPayloadError, DecryptionError
    from gateway import delivery_ledger as ledger
    monkeypatch.setattr(ledger, '_db_path', lambda: tmp_path / 'state.db')
    a = adapter(tmp_path)
    a._dispatch_sync = lambda data: MatrixAdapter._dispatch_sync(a, data)
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    client = Client(mxid='@bot:example.org', base_url='https://matrix.example.org', token='fixture')
    await client.api.session.close()  # real dispatcher/serializer, no network
    admissions = []
    async def admitted(e):
        eid = str(e.event_id)
        if a._intake.state(eid) != 'native':
            a._intake.mark(eid, 'native', 'receipt')
            admissions.append(eid)
    client.add_event_handler(EventType.ROOM_MESSAGE, admitted, wait_sync=True)
    error = DecryptedPayloadError('Failed to parse megolm payload') if failure == 'decoded' else DecryptionError('Failed to decrypt megolm event')
    crypto = SimpleNamespace(decrypt_megolm_event=AsyncMock(side_effect=error), request_room_key=AsyncMock())
    send = AsyncMock(return_value='$notice')
    a._client = SimpleNamespace(handle_sync=client.handle_sync, crypto=crypto, send_message_event=send)
    b = batch('$poison', '$same-sync')
    raw = b['rooms']['join']['!room:example.org']['timeline']['events'][0]
    raw.update(type='m.room.encrypted', content={'algorithm': 'm.megolm.v1.aes-sha2',
               'session_id': 'fixture-session', 'sender_key': 'fixture-key', 'device_id': 'DEVICE'})
    if failure != 'wire':
        raw['content']['ciphertext'] = 'invalid-fixture'
    # Simulate restart with the poison batch already accepted before dispatch.
    a._intake.accept(b)
    a._intake.close()
    a._intake = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    await a._dispatch_sync(a._intake.get('pending'))
    a._intake.finish(b)
    await a._retry_parked()
    second = batch('$following-sync', token='following')
    second['to_device'] = {'events': []}
    await a._absorb_sync(a._client, second)
    # Replay both syncs and restart again: no duplicate admission or notice.
    a._intake.close()
    a._intake = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    await a._absorb_sync(a._client, b)
    await a._absorb_sync(a._client, second)
    assert admissions == ['$same-sync', '$following-sync']
    assert a._intake.get('pending') is None
    assert a._intake.get('next_batch') == 'following'
    assert a._intake.state('$poison') == 'undecryptable'
    assert a._intake.parked()[0][2] == raw
    assert a._intake.parked()[0][3] == 0
    send.assert_awaited_once()
    body = send.await_args.args[2]['body']
    # The owner is asked to resend; raw event ids stay out of the chat.
    assert 'send it again' in body and '$' not in body
    crypto.request_room_key.assert_not_awaited()
    assert crypto.decrypt_megolm_event.await_count == (0 if failure == 'wire' else 1)
    a._intake.close()


@pytest.mark.asyncio
async def test_poison_parked_row_does_not_block_missing_key_sibling(tmp_path):
    from mautrix.errors import SessionNotFound
    a = adapter(tmp_path)
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    a._notify_decryption_giveup = AsyncMock()
    poison = event('$poison')
    poison.update(type='m.room.encrypted', content={'algorithm': 'm.megolm.v1.aes-sha2'})
    waiting = event('$waiting')
    waiting.update(type='m.room.encrypted', content={'algorithm': 'm.megolm.v1.aes-sha2',
                   'session_id': 's', 'sender_key': 'k', 'ciphertext': 'fixture', 'device_id': 'DEVICE'})
    a._intake.park(poison, '!room:example.org')
    a._intake.park(waiting, '!room:example.org')
    crypto = SimpleNamespace(decrypt_megolm_event=AsyncMock(side_effect=SessionNotFound('s', 'k')),
                             request_room_key=AsyncMock())
    a._client = SimpleNamespace(crypto=crypto)
    await a._retry_parked()
    assert a._intake.state('$poison') == 'undecryptable'
    assert a._intake.state('$waiting') is None
    crypto.request_room_key.assert_awaited_once()
    a._notify_decryption_giveup.assert_awaited_once()
    a._intake.close()


def test_retry_quarantined_event_retains_payload_and_cursor(tmp_path, capsys):
    from hermes_cli.matrix_intake import cmd_matrix_intake
    store = MatrixIntakeStore(tmp_path / 'intake.sqlite3')
    store.accept(batch('$poison'))
    raw = event('$poison')
    store.park(raw, '!room:example.org')
    store.undecryptable('$poison', 'SerializerError: missing ciphertext')
    store.close()
    args = SimpleNamespace(store=str(tmp_path / 'intake.sqlite3'), action='status')
    cmd_matrix_intake(args)
    assert 'missing ciphertext' in capsys.readouterr().out
    args.action, args.event, args.reconciled = 'retry', '$poison', 'operator inspected retained payload'
    cmd_matrix_intake(args)
    store = MatrixIntakeStore(args.store)
    assert store.state('$poison') is None
    assert store.status()['encrypted'][0]['failure_reason'] is None
    assert store.parked()[0][2] == raw
    assert store.get('pending') == batch('$poison')
    assert store.get('next_batch') == 'opaque/sync-token'
    assert list(tmp_path.glob('*.backup-*'))
    store.close()


def test_stable_sender_and_transactions_across_real_process_restart(tmp_path):
    import json
    import os
    import subprocess
    import sys
    code = '''
import json, sys
from pathlib import Path
from gateway import delivery_ledger as d
d._db_path = lambda: Path(sys.argv[1])
sender = d.matrix_sender_id()
d.record_obligation(obligation_id='same-turn', session_key='matrix:room', platform='matrix',
                    chat_id='!room', thread_id=None, content='final', source_event_id='$source')
print(json.dumps([sender, d.matrix_transaction_id('recomputed'),
                  d.matrix_send_plan('same-turn', '!room', [{'body':'one'}, {'body':'two'}])]))
'''
    def start(path):
        return subprocess.Popen([sys.executable, '-c', code, str(path)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=os.environ.copy())
    def result(child):
        out, err = child.communicate(timeout=30)
        assert child.returncode == 0, err
        return json.loads(out)
    # Same account/obligation, separate private agent/audience homes, concurrent OS processes.
    one = start(tmp_path / 'owner.db')
    two = start(tmp_path / 'audience.db')
    first, other = result(one), result(two)
    restarted = result(start(tmp_path / 'owner.db'))
    assert restarted == first
    assert first[0] != other[0]
    assert first[1] != other[1]
    assert first[2][0]['txn_id'] != other[2][0]['txn_id']
    for i, item in enumerate(first[2], 1):
        assert item['content']['org.hermes.source_event_id'] == '$source'
        assert item['content']['org.hermes.final_chunk'] == {'index': i, 'total': 2}


def test_configured_sender_persisted_and_identity_change_refused(tmp_path, monkeypatch):
    from gateway import delivery_ledger as d
    monkeypatch.setattr(d, '_db_path', lambda: tmp_path / 'state.db')
    assert d.matrix_sender_id('agent-owner') == 'agent-owner'
    assert d.matrix_sender_id() == 'agent-owner'
    with pytest.raises(ValueError, match='persisted'):
        d.matrix_sender_id('different-audience')
    with pytest.raises(ValueError, match='letters'):
        d.matrix_sender_id('../unsafe')


def test_versioned_previous_journal_upgrade_preserves_replay(tmp_path):
    import json
    import sqlite3
    path = tmp_path / 'intake.sqlite3'
    pending = batch('$pending', '$control')
    with sqlite3.connect(path) as db:
        db.executescript('''
            CREATE TABLE sync_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE intake_events (event_id TEXT PRIMARY KEY,state TEXT NOT NULL,receipt TEXT,updated_at REAL NOT NULL DEFAULT 0);
            CREATE TABLE encrypted_pending (event_id TEXT PRIMARY KEY,room TEXT NOT NULL,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL,notified INTEGER NOT NULL DEFAULT 0,failure_reason TEXT);
        ''')
        db.executemany('INSERT INTO sync_state VALUES (?,?)', [(k, json.dumps(v)) for k,v in
                       {'pending': pending, 'next_batch':'opaque', 'frontier': {'!room:example.org':'$frontier'}}.items()])
        db.executemany('INSERT INTO intake_events VALUES (?,?,?,?)',
                       [('$pending','native','admission',42), ('$control','ambiguous',None,43),
                        ('$parked','undecryptable','bad payload',44), ('$legacy','done',None,45)])
        db.execute('INSERT INTO encrypted_pending VALUES (?,?,?,0,1,0,?)',
                   ('$parked','!encrypted',json.dumps(event('$parked')),'bad payload'))
    for _ in range(2):  # idempotent migration/restart
        store = MatrixIntakeStore(path)
        assert store.db.execute('PRAGMA user_version').fetchone()[0] == 1
        assert store.get('pending') == pending
        assert store.get('next_batch') == 'opaque'
        assert store.get('frontier') == {'!room:example.org':'$frontier'}
        rows = {r[0]: r[1:] for r in store.db.execute('SELECT event_id,state,receipt,updated_at,room_id FROM intake_events')}
        assert rows['$pending'] == ('native','admission',42,'!room:example.org')
        assert rows['$parked'] == ('undecryptable','bad payload',44,'!encrypted')
        assert rows['$control'][-1] == '!room:example.org'
        assert rows['$legacy'] == ('done',None,45,None)
        store.mark('$pending', 'done')  # CLI/reconciliation preserves room
        assert store.db.execute('SELECT room_id FROM intake_events WHERE event_id=?', ('$pending',)).fetchone()[0] == '!room:example.org'
        # Restore state only for repeated migration assertions.
        store.mark('$pending', 'native', 'admission')
        store.db.execute('UPDATE intake_events SET updated_at=42 WHERE event_id=?', ('$pending',))
        store.db.commit()
        store.close()


def test_old_frozen_wire_plan_is_never_rewritten(tmp_path, monkeypatch):
    import json
    from gateway import delivery_ledger as d
    monkeypatch.setattr(d, '_db_path', lambda: tmp_path / 'state.db')
    d.record_obligation(obligation_id='old', session_key='matrix:r', platform='matrix', chat_id='r',
                        thread_id=None, content='original')
    original = [{'txn_id':'hermes_oldboot_exact', 'content':{'body':'old content'}}]
    with d._transaction() as db:
        db.execute('UPDATE delivery_obligations SET matrix_send_plan=? WHERE obligation_id=?', (json.dumps(original), 'old'))
    assert d.matrix_send_plan('old','r',[{'body':'changed'}]) == original


def test_journal_room_migration_failure_rolls_back_schema_and_version(tmp_path):
    import json
    import sqlite3
    path = tmp_path / 'previous.sqlite3'
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE sync_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE intake_events (event_id TEXT PRIMARY KEY,state TEXT NOT NULL,receipt TEXT,updated_at REAL NOT NULL DEFAULT 0);
            INSERT INTO intake_events VALUES ('$one','native','admitted',42);
            CREATE TRIGGER fail_upgrade BEFORE UPDATE ON intake_events BEGIN SELECT RAISE(FAIL,'migration fault'); END;
        """)
        db.execute('INSERT INTO sync_state VALUES (?,?)', ('pending', json.dumps(batch('$one'))))
    with pytest.raises(sqlite3.DatabaseError, match='migration fault'):
        MatrixIntakeStore(path)
    with sqlite3.connect(path) as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 0
        assert 'room_id' not in {r[1] for r in db.execute('PRAGMA table_info(intake_events)')}
        assert db.execute('SELECT * FROM intake_events').fetchone() == ('$one','native','admitted',42)
        assert json.loads(db.execute("SELECT value FROM sync_state WHERE key='pending'").fetchone()[0]) == batch('$one')
        db.execute('DROP TRIGGER fail_upgrade')
    store = MatrixIntakeStore(path)
    assert store.db.execute('SELECT room_id FROM intake_events').fetchone()[0] == '!room:example.org'
    store.close()


@pytest.mark.asyncio
async def test_native_final_source_is_independent_of_reply_relation(tmp_path, monkeypatch):
    from gateway import delivery_ledger as d
    monkeypatch.setattr(d, '_db_path', lambda: tmp_path / 'state.db')
    monkeypatch.setattr(d, 'ledger_enabled', lambda: True)
    a = adapter(tmp_path)
    e = MessageEvent(text='question', source=a.build_source(chat_id='!room:example.org',
        chat_type='dm', user_id='@alice:example.org'), message_id='$source')
    oid = await a._record_delivery_obligation(e, 'matrix:r', 'answer', a, False)
    assert oid
    # Recovery need not reconstruct reply_to, thread relations or the original event.
    plan = d.matrix_send_plan(oid, '!room:example.org', [{'body':'answer'}])
    assert plan[0]['content']['org.hermes.source_event_id'] == '$source'
    assert plan[0]['content']['org.hermes.final_chunk'] == {'index':1, 'total':1}


@pytest.mark.asyncio
async def test_ledgered_notice_reply_relation_is_not_final_evidence(tmp_path, monkeypatch):
    from gateway import delivery_ledger as d
    monkeypatch.setattr(d, '_db_path', lambda: tmp_path / 'state.db')
    d.record_obligation(obligation_id='notice', session_key='matrix:r', platform='matrix',
                        chat_id='!room:example.org', thread_id=None, content='notice')
    a = adapter(tmp_path)
    a._client = SimpleNamespace(send_message_event=AsyncMock(return_value='$notice'))
    assert (await a.send('!room:example.org', 'notice', reply_to='$unanswered',
                        metadata={'delivery_obligation_id':'notice'})).success
    payload = a._client.send_message_event.await_args.args[2]
    assert 'org.hermes.source_event_id' not in payload
    assert 'org.hermes.final_chunk' not in payload


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['control_pending', 'ambiguous'])
async def test_interrupted_pre_admission_control_settles_once_and_unblocks(tmp_path, state):
    a = adapter(tmp_path)
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    a._intake.mark('$control', state)
    a._send_room_message = AsyncMock(return_value='$notice')
    raw = SimpleNamespace(room_id='!room:example.org', sender='@alice:example.org',
        event_id='$control', timestamp=1, content={'msgtype': 'm.text', 'body': 'yes'})
    a._handle_text_message = AsyncMock()
    await a._on_room_message(raw)
    await a._on_room_message(raw)
    assert a._intake.state('$control') == 'done'
    a._send_room_message.assert_awaited_once()
    a._handle_text_message.assert_not_awaited()
    a._intake.close()


@pytest.mark.asyncio
async def test_control_failure_notice_outage_does_not_wedge_intake(tmp_path):
    from gateway.delivery_ledger import _connect
    a = adapter(tmp_path)
    a._is_allowed_matrix_room_event = AsyncMock(return_value=True)
    a._intake.mark('$failed-control', 'control_pending')
    a._send_room_message = AsyncMock(side_effect=ConnectionError('offline notice'))
    raw = SimpleNamespace(room_id='!room:example.org', sender='@alice:example.org',
        event_id='$failed-control', timestamp=1, content={'msgtype': 'm.text', 'body': 'yes'})
    await a._on_room_message(raw)
    assert a._intake.state('$failed-control') == 'done'
    db = _connect()
    try:
        owed = db.execute('SELECT state FROM delivery_obligations WHERE source_event_id=?',
            ('$failed-control',)).fetchall()
        assert [row[0] for row in owed] == ['failed']
    finally:
        db.close()
    await a._on_room_message(raw)
    assert a._send_room_message.await_count == 1
    a._intake.close()
