"""Native cron progress through the real scheduler, admission FIFO and Matrix sender."""
import asyncio
import json
import threading
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import unquote

import pytest

from plugins.platforms.matrix import presentation


@pytest.mark.asyncio
async def test_running_occurrences_publish_independent_stop_targets(tmp_path, monkeypatch):
    from cron import jobs, scheduler
    from cron.execution_identity import current_cron_execution
    from cron.executions import create_execution, get_execution
    from gateway import run, session_cron
    from gateway.config import GatewayConfig, HomeChannel, Platform, PlatformConfig
    from gateway.schedule_source_control import stop_schedule
    from gateway.session import SessionStore
    from gateway.session_authority import SessionAuthority
    from hermes_cli.plugins import PluginManager
    from hermes_state_registry import acquire, release_or_close
    from hermes_state_runtime import begin_runtime_epoch
    from mautrix.types import EventType
    from mautrix.types.event.state import JoinRule, JoinRulesStateEventContent
    from plugins.platforms.matrix.adapter import MatrixAdapter

    room, owner, bot = '!private:test', '@owner:test', '@assistant:test'
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(run, '_load_gateway_config', lambda: {'model': {}, 'platform_toolsets': {'cli': []}})
    monkeypatch.setattr(scheduler, '_launch_external_cron_worker', lambda *args, **kwargs: False)
    home = HomeChannel(Platform.MATRIX, room, 'Owner', user_id=owner)
    matrix_config = PlatformConfig(enabled=True, home_channel=home, extra={'allowed_users': owner})
    adapter = presentation.adapter_class(MatrixAdapter)(matrix_config)
    adapter._presentation_box = presentation.Outbox(tmp_path / 'presentation.db')
    monkeypatch.setattr('cron.scheduler_delivery._get_config_home_channel', lambda name: home if name == 'matrix' else None)
    monkeypatch.setattr('cron.scheduler_delivery._is_known_delivery_platform', lambda name: name == 'matrix')
    emitted = asyncio.Queue()
    redactions = []

    async def send_message_event(chat_id, event_type, content, *, txn_id):
        assert chat_id == room and event_type == EventType.ROOM_MESSAGE
        wire = {'room_id': chat_id, 'type': str(event_type), 'sender': bot,
                'event_id': '$' + txn_id, 'origin_server_ts': int(datetime.now(UTC).timestamp() * 1000),
                'content': content}
        emitted.put_nowait(wire)
        return wire['event_id']

    async def redact(method, path, *, content, metrics_method):
        assert content == {'reason': 'Turn ended'}
        redactions.append(unquote(str(path)))
        return {'event_id': '$redacted'}

    async def get_state_event(_room, event_type):
        if event_type == EventType.ROOM_JOIN_RULES:
            return JoinRulesStateEventContent(join_rule=JoinRule.INVITE)
        assert event_type == EventType.ROOM_HISTORY_VISIBILITY
        return {'history_visibility': 'shared'}

    adapter._client = SimpleNamespace(
        mxid=bot, get_joined_members=AsyncMock(return_value={bot: {}, owner: {}}),
        get_state_event=get_state_event, send_message_event=send_message_event,
        api=SimpleNamespace(request=redact),
    )
    config = GatewayConfig(platforms={Platform.MATRIX: matrix_config})
    runner = SimpleNamespace(_draining=False, config=config, adapters={Platform.MATRIX: adapter},
                             session_store=SessionStore(tmp_path / 'sessions', config))
    runner._adapter_for_source = lambda source: runner.adapters.get(source.platform)
    db = acquire(tmp_path / 'state.db')
    authority = SessionAuthority(runner, profile_id=str(tmp_path), instance_id='test', db=db,
                                 epoch=begin_runtime_epoch(db, instance_id='test'))
    runner.session_authority = authority
    job = jobs.create_job(prompt='private prompt', schedule='every 1h', deliver='matrix', model='fixture')
    slot = datetime.now(UTC) - timedelta(hours=2)
    first, second = [
        create_execution(job['id'], source='builtin', scheduled_instant=(slot + timedelta(hours=offset)).isoformat())['id']
        for offset in (0, 1)
    ]
    hooks = PluginManager()
    presentation.register_hooks(SimpleNamespace(
        register_hook=lambda name, hook: hooks._hooks.setdefault(name, []).append(hook)))
    release = {execution: threading.Event() for execution in (first, second)}
    entered = {execution: asyncio.Event() for execution in release}
    begin_tools = threading.Event()
    loop = asyncio.get_running_loop()

    class InertAgent:
        def run_conversation(self, prompt, task_id):
            execution = current_cron_execution().execution_id
            self.execution = execution
            loop.call_soon_threadsafe(entered[execution].set)
            assert begin_tools.wait(12)
            hooks.invoke_hook('pre_tool_call', tool_call_id=execution, tool_name='read_file',
                              args={'path': '/private/tool-argument'})
            assert release[execution].wait(20)
            return {'final_response': scheduler.SILENT_MARKER}

        def hard_interrupt(self, *args, **kwargs):
            release[self.execution].set()

        def close(self):
            pass

    monkeypatch.setattr(scheduler, '_resolve_cron_agent_setup',
                        lambda *args, **kwargs: scheduler._CronAgentSetup(model='fixture'))
    monkeypatch.setattr(scheduler, '_construct_cron_agent', lambda *args, **kwargs: InertAgent())
    session_cron.bind_owner(authority)
    fires = [
        asyncio.create_task(asyncio.to_thread(scheduler.run_one_job, dict(job, execution_id=execution)))
        for execution in release
    ]
    try:
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in entered.values())), 8)
        roots = [await asyncio.wait_for(emitted.get(), 8) for _ in range(2)]
        assert all(wire['content']['io.atum.progress']['revision'] == 0 for wire in roots)
        assert all(not fire.done() for fire in fires)
        assert all(get_execution(execution)['status'] == 'running' for execution in release)
        begin_tools.set()
        live = roots + [await asyncio.wait_for(emitted.get(), 8) for _ in range(2)]
        assert all(not fire.done() for fire in fires)
        assert not redactions
        originals = {}
        for wire in live:
            content = wire['content']
            marker = content['io.atum.progress']
            execution = marker['schedule']['execution']
            assert marker['schedule'] == {'job': job['id'], 'execution': execution}
            assert marker['trigger'] == 'cron'
            assert content['body'] == ''
            if not marker['revision']:
                assert 'm.relates_to' not in content
                originals[execution] = wire['event_id']
            else:
                assert content['m.relates_to'] == {'rel_type': 'm.replace', 'event_id': originals[execution]}
                assert content['m.new_content']['io.atum.progress'] == marker
                assert content['io.atum.presentation']['args'] == {'activity': 'read'}
        assert originals.keys() == release.keys()
        assert len(set(originals.values())) == 2
        # The retained wire data is also usable by the desktop's decoder with no homeserver.
        (tmp_path / 'live-progress.json').write_text(json.dumps(live))

        first_root = next(wire for wire in roots if wire['event_id'] == originals[first])
        identity = first_root['content']['io.atum.progress']['schedule']
        request = {**identity, 'action': 'stop'}
        receipt = await stop_schedule(authority, request)
        if receipt['state'] == 'pending':
            await asyncio.wait_for(fires[0], 8)
            receipt = await stop_schedule(authority, {**request, 'action': 'receipt'})
        assert receipt == {'accepted': True, 'state': 'interrupted',
                           'receipt': {**identity, 'kind': 'schedule', 'state': 'interrupted'}}
        assert release[first].is_set() and not release[second].is_set()
        assert any(originals[first] in path for path in redactions)
        assert all(originals[second] not in path for path in redactions)
        assert emitted.empty()
    finally:
        begin_tools.set()
        for event in release.values():
            event.set()
        try:
            await asyncio.wait_for(asyncio.gather(*fires), 12)
            await asyncio.gather(*(live.task for live in authority.sessions.values() if live.task))
        finally:
            session_cron.unbind_owner(authority)
            adapter._presentation_box.db.close()
            release_or_close(db)


@pytest.mark.asyncio
@pytest.mark.parametrize('case', ['manual', 'missing', 'other-job', 'terminal', 'unprefixed'])
async def test_only_matching_running_occurrences_open_presentation(tmp_path, monkeypatch, case):
    from cron.executions import create_execution, finish_execution, mark_execution_running
    from gateway.config import Platform
    from gateway.session_cron import _run_identified
    from hermes_state_keys import CRON_PRINCIPAL_ID, cron_request_id

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    job = {'id': 'job', 'execution_id': 'fire'}
    if case != 'missing':
        create_execution('other' if case == 'other-job' else 'job', source='builtin', execution_id='fire',
                         scheduled_instant=None if case == 'manual' else '2026-10-08T09:00:00+00:00')
        mark_execution_running('fire')
        if case == 'terminal':
            finish_execution('fire', success=True)

    def unexpected_scope(*args):
        pytest.fail('an unverified occurrence opened Matrix presentation')

    adapter = SimpleNamespace(scheduled_presentation_scope=unexpected_scope)
    authority = SimpleNamespace(runner=SimpleNamespace(adapters={Platform.MATRIX: adapter}))
    row = {'status': 'started', 'principal_id': CRON_PRINCIPAL_ID,
           'request_id': 'fire' if case == 'unprefixed' else cron_request_id('job', 'fire')}

    def run_job(job, *, execution_id, extra_prompt, cancel_event):
        return execution_id

    assert await _run_identified(authority, row, run_job, job, 'fire',
                                 extra_prompt=None, cancel_event=threading.Event()) == 'fire'


@pytest.mark.asyncio
@pytest.mark.parametrize('peer,join_rule,history', [
    ('@stranger:test', 'invite', 'joined'),
    ('@owner:test', 'public', 'joined'),
    ('@owner:test', 'invite', 'world_readable'),
    ('@owner:test', 'invite', None),
    ('@owner:test', 'invite', 'joined'),
])
async def test_schedule_room_requires_private_owner_audience(peer, join_rule, history):
    from mautrix.types import EventType

    adapter = presentation.adapter_class(object)()
    bot, owner = '@assistant:test', '@owner:test'
    adapter._client = SimpleNamespace(mxid=bot, get_joined_members=AsyncMock(return_value={bot: {}, peer: {}}))
    adapter._get_room_state_value = AsyncMock(
        side_effect=lambda _, event_type, __: join_rule if event_type == EventType.ROOM_JOIN_RULES else history)
    adapter._is_authorized_user = lambda *_: True
    assert await adapter._scheduled_room_is_private('!room:test', owner) is (
        peer == owner and join_rule == 'invite' and history == 'joined')
    adapter._client.get_joined_members.return_value['@third:test'] = {}
    assert not await adapter._scheduled_room_is_private('!room:test', owner)


@pytest.mark.asyncio
async def test_recovery_redacts_acknowledged_schedule_root_without_a_reply(tmp_path):
    box = presentation.Outbox(tmp_path / 'presentation.db')
    port = AsyncMock(return_value='$observed')
    try:
        await box.effect(port, '!room:test', {'io.atum.progress': {}}, 'root-txn')
        # A crash after the send receipt and before the publisher inserts the root index.
        await box.recover(port)
        assert port.await_args.args[1] == {'reason': 'Turn ended'}
        assert port.await_args.args[3] == '$observed'
    finally:
        box.db.close()
