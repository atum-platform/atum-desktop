"""Offline native intake/admission presentation regressions; no external service."""
import asyncio
import hashlib
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.event import MessageEvent
from gateway.session import SessionSource
from gateway.config import Platform
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from plugins.platforms.matrix.adapter import MatrixAdapter
from plugins.platforms.matrix.intake import MatrixIntakeStore
from plugins.platforms.matrix import presentation as p


@pytest.mark.asyncio
async def test_native_connect_pending_and_downtime(tmp_path):
    token = set_hermes_home_override(str(tmp_path))
    answered, roots = [], []
    class Adapter(p.adapter_class(MatrixAdapter)):
        async def _presentation_send(self, room, content, txn, target):
            if 'io.atum.progress' in content and 'm.new_content' not in content:
                roots.append(content['m.relates_to']['m.in_reply_to']['event_id'])
            return '$effect-' + txn
    a = Adapter(PlatformConfig(enabled=True, token='fixture', extra={
        'homeserver': 'https://matrix.example.org', 'user_id': '@bot:example.org',
        'allowed_users': '@alice:example.org'}))
    def batch(*ids, token):
        return {'next_batch': token, 'rooms': {'join': {'!room:example.org': {
            'timeline': {'events': [{'event_id': i} for i in ids]}}}}}
    identity = json.dumps(['https://matrix.example.org', '@bot:example.org'])
    store = MatrixIntakeStore(tmp_path / ('intake-' + hashlib.sha256(identity.encode()).hexdigest() + '.sqlite3'))
    store.accept(batch('$pending', token='kept'))
    store.close()
    a._resolve_store_dir = lambda: tmp_path
    a._store_dir = tmp_path
    a._connect_authenticate = AsyncMock(return_value=True)
    a._acquire_platform_lock = MagicMock(return_value=True)
    a._release_platform_lock = MagicMock()
    a._encryption = False
    a._refresh_dm_cache = AsyncMock()
    a._warn_encrypted_drops = MagicMock()
    a._schedule_pending_invite_joins = MagicMock()
    a._sync_loop = AsyncMock()
    a._mark_connected = MagicMock()
    a._wire_plugin_handlers = MagicMock()
    a.gateway_runner = SimpleNamespace(session_authority=True)
    async def handler(event):
        event._on_transport_commit(SimpleNamespace(admission_id=event.message_id))
        # This is the native admission's execution seam; the initial RED must first
        # get past the real connect/intake/background-task readiness dependency.
        async with a.admission_presentation_scope(event, a._event_session_key(event), event.message_id):
            answered.append(event.message_id)
            # Admission itself posts nothing; one real step opens this turn's line.
            await p._current.get().progress('Reading…')
            await p._current.get().end()
    a._message_handler = handler
    async def dispatch(data):
        for raw in data['rooms']['join']['!room:example.org']['timeline']['events']:
            e = MessageEvent(text='hello', message_id=raw['event_id'], source=SessionSource(
                platform=Platform.MATRIX, chat_id='!room:example.org', chat_type='dm', user_id='@alice:example.org'))
            await a.handle_message(e)
            tasks = list(a._session_tasks.values())
            if tasks:
                await asyncio.gather(*tasks)
    a._dispatch_sync = dispatch
    client = MagicMock()
    client.sync = AsyncMock(return_value=batch('$down1', '$down2', token='next'))
    client.api.session.close = AsyncMock()
    api = ModuleType('mautrix.api'); api.HTTPAPI = lambda **kw: client.api
    clients = ModuleType('mautrix.client'); clients.Client = lambda **kw: client
    clients.InternalEventType = SimpleNamespace(INVITE='invite')
    dispatcher = ModuleType('mautrix.client.dispatcher'); dispatcher.MembershipEventDispatcher = object
    state = ModuleType('mautrix.client.state_store'); state.MemoryStateStore = MagicMock; state.MemorySyncStore = MagicMock
    try:
        with patch.dict(sys.modules, {'mautrix.api': api, 'mautrix.client': clients,
                'mautrix.client.state_store': state, 'mautrix.client.dispatcher': dispatcher}), patch(
                'plugins.platforms.matrix.adapter._create_matrix_session', return_value=MagicMock()):
            assert await asyncio.wait_for(a.connect(), timeout=2)
        assert answered == ['$pending', '$down1', '$down2']
        assert roots == answered
    finally:
        await a.disconnect()
        if hasattr(a, '_presentation_box'):
            a._presentation_box.db.close()
        reset_hermes_home_override(token)


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['queued_followup', 'legacy_recovery'])
async def test_each_admission_owns_progress_interim_stop_and_final(tmp_path, kind, monkeypatch):
    writes, interrupts = [], []
    class Base:
        async def send_final_ledgered(self, event, *args, **kwargs):
            from gateway.platforms.base import SendResult
            message_id = await self.send(event.source.chat_id, 'answer', reply_to=event.message_id)
            return SendResult(success=True, message_id=message_id), self
        async def send(self, room, text, **kwargs):
            return await self._send_room_message(room, {'msgtype': 'm.text', 'body': text})
        async def _send_room_message(self, room, content, **kwargs):
            writes.append(content)
            return '$final'
    a = p.adapter_class(Base)()
    a._presentation_box = p.Outbox(tmp_path / 'box.sqlite3')
    a._presentation_turns = {}
    async def port(room, content, txn, target):
        writes.append(content)
        return '$' + txn
    a._presentation_send = port
    event = MessageEvent(text='hello', message_id='$' + kind, source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room', chat_type='dm', user_id='@owner'))
    state = SimpleNamespace(turn=SimpleNamespace(event=event))
    a.gateway_runner = SimpleNamespace(_peek_session_state=lambda key: state,
        _interrupt_and_clear_session=AsyncMock(side_effect=lambda *a, **k: interrupts.append(a)))
    stale = p.Turn(a._presentation_box, port, '!room', '$old', '@owner')
    await stale.end()
    token = p._current.set(stale)  # drain inherited A's receive context
    try:
        from contextlib import nullcontext
        from gateway import session_ingress as ingress
        monkeypatch.setattr('gateway.session_completion_notes.note_if_unviewed', AsyncMock(return_value=None))
        monkeypatch.setattr('gateway.session_policy.policy_for_source', lambda *args: None)
        monkeypatch.setattr('gateway.session_managed_worker.managed_policy', lambda *args: None)
        monkeypatch.setattr(ingress, 'restore_native', lambda *args: event)
        monkeypatch.setattr(ingress, '_execution_scope', AsyncMock(return_value=nullcontext()))
        monkeypatch.setattr(ingress, '_hand_over_turn_marker', AsyncMock())
        turns = []
        async def execute(event):
            turn = p._current.get()
            turns.append(turn)
            assert turn is not stale and turn.admission_id == kind
            await a.send('!room', 'checking', metadata={'_interim_send': True})
            assert a._presentation_turns[('!room', event.message_id)][0] is turn
            return 'answer'
        a.gateway_runner._handle_message = execute
        a.gateway_runner._adapter_for_source = lambda source: a
        a.gateway_runner.session_store = SimpleNamespace(mark_resume_pending=MagicMock())
        event.metadata['turn_author'] = 'owner'
        authority = SimpleNamespace(runner=a.gateway_runner,
            sessions={'session': SimpleNamespace(source=event.source, route='route')},
            native_waiters={kind} if kind == 'queued_followup' else set(), pending_results={},
            pending_deliveries={}, physical_target=lambda ref: 'physical',
            db=SimpleNamespace(_read_one=lambda *args: None))
        row = {'seq': 1, 'admission_id': kind, 'request_id': '$' + kind, 'generation': 1, 'payload': {'native_text_v1': {}},
               'outcome': 'crash_resume' if kind == 'legacy_recovery' else None}
        assert await ingress.execute_admission(authority, SimpleNamespace(session_id='session'), row) == 'answer'
        turn = turns[0]
        if kind == 'legacy_recovery':
            assert kind in authority.pending_deliveries
            a.gateway_runner.session_store.mark_resume_pending.assert_not_called()
        # Deferred final waiter can inherit an unrelated/ended context.
        await a.send_final_ledgered(event)
        finals = [w for w in writes if w.get('io.atum.turn')]
        assert len(finals) == 1
        assert finals[0]['io.atum.turn'] == turn.marker
        # No status line at admission: typing says the agent is working, so the
        # only writes are the agent's own remark, kept, and then its answer.
        assert not any('io.atum.progress' in w for w in writes)
        assert [w['body'] for w in writes] == ['checking', 'answer']
        assert writes[0].get('io.atum.interim') is True
        assert not turn.stopped
    finally:
        p._current.reset(token)
        await turn.end()
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_stop_notification_for_b_does_not_suppress_a_final(tmp_path):
    hooks = {}
    p.register_hooks(SimpleNamespace(register_hook=lambda name, fn: hooks.update({name: fn})))
    box = p.Outbox(tmp_path / 'box.sqlite3')
    async def port(*args):
        return '$effect'
    a = p.Turn(box, port, '!room', '$a', '@owner'); a.admission_id = 'admission-a'
    p._active['route'] = a
    try:
        hooks['agent_loop_stopped'](session_key='route', platform='matrix',
            source_event_id='$b', admission_id='admission-b')
        await asyncio.sleep(0)
        assert not a.stopped
        sent = []
        class Base:
            async def send(self, *args, **kwargs):
                sent.append(args)
                return 'sent'
        token = p._current.set(a)
        try:
            result = await p.adapter_class(Base)().send('!room', 'A answer',
                metadata={'delivery_obligation_id': 'a-obligation'})
            assert result == 'sent' and sent == [('!room', 'A answer')]
        finally:
            p._current.reset(token)
    finally:
        p._active.pop('route', None)
        await a.end(); box.db.close()


@pytest.mark.asyncio
async def test_stop_a_after_b_started_never_interrupts_b(tmp_path):
    box = p.Outbox(tmp_path / 'box.sqlite3')
    async def port(*args):
        return '$effect'
    class Base:
        pass
    adapter = p.adapter_class(Base)()
    a = p.Turn(box, port, '!room', '$a', '@owner'); a.admission_id = 'admission-a'
    b = SimpleNamespace(message_id='$b', source=SimpleNamespace(chat_id='!room'),
                        _presentation_admission_id='admission-b')
    interrupt = AsyncMock()
    adapter.gateway_runner = SimpleNamespace(_peek_session_state=lambda key: SimpleNamespace(
        turn=SimpleNamespace(event=b)), _interrupt_and_clear_session=interrupt)
    adapter._presentation_turns = {('!room', '$a'): (a, 'route', a)}
    try:
        assert await adapter.stop_presentation_turn('!room', '$a', '@owner', authenticated=True)
        interrupt.assert_not_awaited()
    finally:
        await a.end(); box.db.close()


@pytest.mark.asyncio
async def test_open_snapshot_never_recovers_live_connect_root(tmp_path):
    box = p.Outbox(tmp_path / 'box.sqlite3')
    effects = []
    async def port(room, content, txn, target):
        effects.append((content, target))
        return '$' + txn
    old = p.Turn(box, port, '!room', '$old', '@owner')
    await old.progress('old')
    snapshot = box.snapshot()
    live = p.Turn(box, port, '!room', '$live', '@owner')
    try:
        await live.progress('live')
        await box.recover(port, snapshot)
        assert (('!room', '$live', live.root) in box.db.execute('SELECT * FROM roots').fetchall())
        assert not any(target == live.root for _, target in effects)
    finally:
        await old.end(); await live.end(); box.db.close()




@pytest.mark.asyncio
async def test_status_from_ended_context_uses_native_send(tmp_path):
    calls = []
    class Base:
        async def send(self, *args, **kwargs):
            calls.append(args)
            return 'native-status'
    box = p.Outbox(tmp_path / 'box.sqlite3')
    async def port(*args):
        return '$old-root'
    turn = p.Turn(box, port, '!room', '$old', '@owner')
    await turn.progress('old')
    await turn.end()
    token = p._current.set(turn)
    try:
        assert await p.adapter_class(Base)().send_or_update_status('!room', 'retry', 'Retrying') == 'native-status'
        assert calls == [('!room', 'Retrying')]
    finally:
        p._current.reset(token); box.db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('scheduled', [False, True], ids=['owner', 'routine'])
async def test_native_execution_trigger_on_progress_and_final(tmp_path, scheduled):
    from cron.execution_identity import enter_cron_execution, exit_cron_execution
    writes = []
    class Base:
        async def _send_room_message(self, room, content, **kwargs):
            writes.append(content)
            return '$final'
        async def send(self, room, text, **kwargs):
            return await self._send_room_message(room, {'msgtype': 'm.text', 'body': text})
        async def send_final_ledgered(self, event):
            from gateway.platforms.base import SendResult
            message_id = await self.send(event.source.chat_id, 'answer')
            return SendResult(success=True, message_id=message_id), self
    a = p.adapter_class(Base)()
    a._presentation_box = p.Outbox(tmp_path / 'box.sqlite3')
    a._presentation_turns = {}
    async def port(room, content, txn, target):
        writes.append(content)
        return '$effect'
    a._presentation_send = port
    event = MessageEvent(text='hello', message_id='$source', source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room', chat_type='dm', user_id='@owner'))
    # Untrusted message metadata must never turn an owner message into a routine.
    event.metadata['cron_execution_id'] = 'forged'
    token = enter_cron_execution({'id': 'routine'}, 'native-fire', {'source': 'builtin'}) if scheduled else None
    try:
        async with a.admission_presentation_scope(event, 'route', 'admission'):
            await p._current.get().progress('Reading…')
            await a.send_final_ledgered(event)
        marker = writes[0]['io.atum.progress']
        final = next(w for w in writes if w.get('body') == 'answer')
        assert marker.get('trigger') == ('cron' if scheduled else None)
        assert final.get('io.atum.trigger') == ('cron' if scheduled else None)
        assert isinstance(final['io.atum.turn'], str)  # preserve UUID wire contract
        assert 'device' not in marker
    finally:
        exit_cron_execution(token)
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_cron_delivery_without_owner_admission_has_native_trigger():
    from cron.execution_identity import enter_cron_execution, exit_cron_execution
    writes = []
    class Base:
        async def _send_room_message(self, room, content, **kwargs):
            writes.append(content)
            return '$final'
    a = p.adapter_class(Base)()
    token = enter_cron_execution({'id': 'routine'}, 'native-fire', {'source': 'builtin'})
    try:
        await a._send_room_message('!room', {'msgtype': 'm.text', 'body': 'routine result'})
    finally:
        exit_cron_execution(token)
    await a._send_room_message('!room', {'msgtype': 'm.text', 'body': 'ordinary result'})
    assert writes[0]['io.atum.trigger'] == 'cron'
    assert isinstance(writes[0]['io.atum.turn'], str)
    assert 'io.atum.trigger' not in writes[1]


def _presentation_adapter(tmp_path, writes):
    class Base:
        async def _send_room_message(self, room, content, **kwargs):
            writes.append(content)
            return '$final'
        async def send(self, room, text, **kwargs):
            return await self._send_room_message(room, {'msgtype': 'm.text', 'body': text})
        async def send_final_ledgered(self, event):
            from gateway.platforms.base import SendResult
            message_id = await self.send(event.source.chat_id, 'Here is the answer.')
            return SendResult(success=True, message_id=message_id), self
    a = p.adapter_class(Base)()
    a._presentation_box = p.Outbox(tmp_path / 'box.sqlite3')
    a._presentation_turns = {}
    async def port(room, content, txn, target):
        writes.append({'redacts': target} if target else content)
        return '$' + txn
    a._presentation_send = port
    event = MessageEvent(text='hello', message_id='$source', source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room', chat_type='dm', user_id='@owner'))
    return a, event


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


def _extension_words(writes):
    """Every body the extension sent: everything but the agent's remarks and its answer."""
    return [w['body'] for w in writes
            if 'body' in w and not w.get('io.atum.interim') and not w.get('io.atum.turn')]


def _line(write):
    return write.get('m.new_content', write)


@pytest.mark.asyncio
@pytest.mark.parametrize('language', ['en', 'vi'])
async def test_turn_speaks_only_through_the_agent_and_its_real_steps(tmp_path, monkeypatch, language):
    """No status line at admission, no opener in the agent's place, and a line only for a
    real step, as a category code with no words, the same in every owner language."""
    monkeypatch.setenv('HERMES_LANGUAGE', language)
    hooks, writes = {}, []
    p.register_hooks(SimpleNamespace(register_hook=lambda name, fn: hooks.update({name: fn})))
    a, event = _presentation_adapter(tmp_path, writes)
    try:
        async with a.admission_presentation_scope(event, 'route', 'admission'):
            turn = p._current.get()
            assert writes == []  # read receipt + native typing only
            await turn.heartbeat()  # a turn without a line has nothing to keep alive
            for tool in ('todo', 'memory', 'clarify'):  # tools outside the categories
                hooks['pre_tool_call'](tool_name=tool)
            await _settle()
            assert writes == []
            hooks['pre_tool_call'](tool_name='read_file')
            await _settle()
            assert len(writes) == 1 and writes[0]['msgtype'] == 'm.notice'
            assert writes[0]['io.atum.progress']['phase'] == 'working'
            assert writes[0]['io.atum.presentation'] == {
                'version': 1, 'code': 'tool_activity', 'args': {'activity': 'read'}}
            assert not any(w.get('io.atum.interim') for w in writes)  # no fixed opener
            await a.send('!room', 'Let me read the notes first.', metadata={'_interim_send': True})
            remarks = [w for w in writes if w.get('io.atum.interim')]
            assert [w['body'] for w in remarks] == ['Let me read the notes first.']
            await a.send_final_ledgered(event)
        assert [w['body'] for w in writes if w.get('io.atum.turn')] == ['Here is the answer.']
        assert _extension_words(writes) == ['']
        assert writes[-1] == {'redacts': turn.root}  # the line goes once the answer is out
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('language', ['en', 'vi'])
async def test_approval_wait_is_a_code_and_an_answer_returns_the_line(tmp_path, monkeypatch, language):
    """The approval card is the gateway's own UI. The line only says, as a code, that the turn
    waits for it; once answered the line is the step before it again, never "continuing"."""
    monkeypatch.setenv('HERMES_LANGUAGE', language)
    hooks, writes = {}, []
    p.register_hooks(SimpleNamespace(register_hook=lambda name, fn: hooks.update({name: fn})))
    a, event = _presentation_adapter(tmp_path, writes)
    clock = [0.0]
    try:
        async with a.admission_presentation_scope(event, 'route', 'admission'):
            turn = p._current.get()
            turn.clock = lambda: clock[0]
            hooks['pre_tool_call'](tool_name='terminal')
            await _settle()
            clock[0] = 5
            hooks['pre_approval_request'](command='rm -rf build', description='dangerous')
            await _settle()
            wait = _line(writes[-1])
            assert wait['io.atum.progress']['phase'] == 'waiting'
            assert wait['io.atum.presentation'] == {'version': 1, 'code': 'approval_wait', 'args': {}}
            clock[0] = 10
            hooks['post_approval_response'](choice='once')
            await _settle()
            back = _line(writes[-1])
            assert back['io.atum.progress']['phase'] == 'working'
            assert back['io.atum.presentation'] == {
                'version': 1, 'code': 'tool_activity', 'args': {'activity': 'run'}}
            clock[0] = 15
            hooks['post_approval_response'](choice='once')  # no wait open: nothing to return to
            await _settle()
            assert len(writes) == 3
            await a.send_final_ledgered(event)
        assert set(_extension_words(writes)) == {''}
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_approval_wait_before_any_step_returns_to_an_empty_working_line(tmp_path):
    hooks, writes = {}, []
    p.register_hooks(SimpleNamespace(register_hook=lambda name, fn: hooks.update({name: fn})))
    a, event = _presentation_adapter(tmp_path, writes)
    clock = [0.0]
    try:
        async with a.admission_presentation_scope(event, 'route', 'admission'):
            turn = p._current.get()
            turn.clock = lambda: clock[0]
            hooks['pre_approval_request']()
            await _settle()
            clock[0] = 5
            hooks['post_approval_response']()
            await _settle()
            back = _line(writes[-1])
            assert (back['body'], back['io.atum.progress']['phase']) == ('', 'working')
            assert 'io.atum.presentation' not in back
            await a.send_final_ledgered(event)
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_gateway_status_text_never_enters_the_conversation(tmp_path):
    writes = []
    a, event = _presentation_adapter(tmp_path, writes)
    try:
        async with a.admission_presentation_scope(event, 'route', 'admission'):
            turn = p._current.get()
            result = await a.send_or_update_status('!room', 'lifecycle', 'Waiting a moment before I continue…')
            assert result.success and writes == [] and not turn.ended
            await a.send_final_ledgered(event)
        assert [w.get('body') for w in writes] == ['Here is the answer.']
    finally:
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_quiet_turn_sends_only_the_answer(tmp_path):
    writes = []
    a, event = _presentation_adapter(tmp_path, writes)
    try:
        async with a.admission_presentation_scope(event, 'route', 'admission'):
            await a.send_final_ledgered(event)
        assert [w.get('body') for w in writes] == ['Here is the answer.']
    finally:
        a._presentation_box.db.close()


@pytest.mark.parametrize('tool,activity', [
    ('web_search', 'web'), ('browser_navigate', 'web'), ('read_file', 'read'), ('search_files', 'read'),
    ('session_search', 'read'), ('write_file', 'write'), ('patch', 'write'), ('terminal', 'run'),
    ('execute_code', 'run'), ('delegate_task', 'delegate'), ('vision_analyze', 'look'),
    ('image_generate', 'draw'),
    ('todo', None), ('memory', None), ('read_files', None), ('', None), (None, None),
])
def test_tool_activity_follows_desktop_categories(tool, activity):
    # Same categories as the desktop's matrixToolActivityKind (matrix-status-line-copy.ts).
    assert p.tool_activity(tool) == activity
