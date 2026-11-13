"""Pet completion metadata travels through native hooks and frozen send plans."""
import asyncio
import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agent.turn_finalizer import _apply_output_hooks
from gateway.config import Platform, PlatformConfig
from gateway.delivery_ledger import matrix_send_plan, record_obligation
from gateway.platforms.event import MessageEvent
from gateway.session import SessionSource
from plugins.platforms.matrix.adapter import MatrixAdapter
from plugins.platforms.matrix import presentation as p
from tools.pet_tool import pet_tool


@pytest.fixture
def hooks(monkeypatch):
    from hermes_cli import plugins
    manager = plugins.PluginManager()
    p.register_hooks(SimpleNamespace(register_hook=lambda name, fn: manager._hooks.setdefault(name, []).append(fn)))
    monkeypatch.setattr(plugins, '_delivery_manager', lambda: manager)
    monkeypatch.setenv('ATUM_PET_INTENTS', 'reply')
    return manager


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['ordinary', 'compressed', 'failed', 'incomplete', 'cron', 'group', 'stopped', 'off', 'unset', 'subagent', 'synthetic', 'malformed'])
async def test_native_hooks_last_final_part_only(tmp_path, monkeypatch, hooks, kind):
    a = p.adapter_class(MatrixAdapter)(PlatformConfig(enabled=True, token='fixture', extra={}))
    a.max_message_length = 20
    a._presentation_box = p.Outbox(tmp_path / 'box.sqlite3')
    a._presentation_turns = {}
    a._presentation_send = AsyncMock(return_value='$progress')
    a._client = SimpleNamespace(send_message_event=AsyncMock(return_value='$final'))
    event = MessageEvent(text='wave', message_id='$source', internal=kind == 'synthetic', source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room', chat_type='group' if kind == 'group' else 'dm', user_id='@owner'))
    if kind == 'off':
        monkeypatch.setenv('ATUM_PET_INTENTS', 'off')
    if kind == 'unset':
        monkeypatch.delenv('ATUM_PET_INTENTS')
    metadata = {'delivery_obligation_id': 'answer'}
    record_obligation(obligation_id='answer', session_key='session', platform='matrix', chat_id='!room',
        thread_id=None, content='One answer. ' * 8, source_event_id='$source')
    try:
        async with a.admission_presentation_scope(event, 'session', 'admission'):
            turn = p._current.get()
            def execute():
                hooks.invoke_hook('pre_llm_call', platform='cron' if kind == 'cron' else 'matrix',
                    turn_id='native-turn', session_id='session', parent_session_id='parent' if kind == 'subagent' else '')
                result = json.loads(pet_tool('wave'))
                assert result['ok'] is (kind not in ('cron', 'group', 'off', 'unset', 'subagent', 'synthetic'))
                if kind == 'ordinary':
                    from agent.delegation_context import delegated_child_context
                    with delegated_child_context('child'):
                        assert json.loads(pet_tool('jump'))['ok'] is False
                        hooks.invoke_hook('post_llm_call', session_id='child', completed=True)
                _apply_output_hooks(SimpleNamespace(session_id='rotated' if kind == 'compressed' else 'session', model='fixture'), 'One answer. ' * 8,
                    logging.getLogger(__name__), platform='matrix', effective_task_id='task', turn_id='native-turn',
                    original_user_message='wave', messages=[], completed=kind != 'incomplete', failed=kind == 'failed')
            await asyncio.to_thread(execute)
            if turn and kind == 'malformed':
                turn.pet_intents = [{'action': 'fly'}]
            # An interim/status send cannot carry pet intents even after completion.
            await a.send('!room', 'Checking', metadata={'_interim_send': True})
            if turn and kind == 'stopped':
                turn.stopped = True
            token = p._final_delivery.set(True)
            try:
                await a.send('!room', 'One answer. ' * 8, metadata=metadata)
            finally:
                p._final_delivery.reset(token)
        sent = [call.args[2] for call in a._client.send_message_event.await_args_list]
        if kind == 'stopped':
            assert not sent
        else:
            assert len(sent) > 1
            assert all('io.atum.pet' not in part for part in sent[:-1])
            assert ('io.atum.pet' in sent[-1]) is (kind in ('ordinary', 'compressed'))
            if kind == 'ordinary':
                assert sent[-1]['io.atum.pet'] == {'v': 1, 'intents': [{'action': 'wave'}]}
                # Reopen/replay with no turn object: metadata was frozen before send.
                plan = matrix_send_plan('answer', '!room', [{'body': 'changed'}])
                assert plan[-1]['content'] == sent[-1]
                assert all('io.atum.pet' not in part['content'] for part in plan[:-1])
                assert all('io.atum.pet' not in call.args[1] for call in a._presentation_send.await_args_list)
                # A readmitted presentation context cannot rewrite a frozen wire marker.
                turn.marker = p.turn_id('!room', '$different-context')
                current = p._current.set(turn)
                final = p._final_delivery.set(True)
                try:
                    await a.send('!room', 'One answer. ' * 8, metadata=metadata)
                finally:
                    p._final_delivery.reset(final)
                    p._current.reset(current)
                replay = [call.args[2] for call in a._client.send_message_event.await_args_list[len(sent):]]
                assert replay == sent
    finally:
        for turn, *_ in list(a._presentation_turns.values()):
            await turn.end()
        a._presentation_box.db.close()


@pytest.mark.asyncio
async def test_exception_invalid_command_and_late_callback_cannot_leak(tmp_path, hooks):
    a = p.adapter_class(MatrixAdapter)(PlatformConfig(enabled=True, token='fixture', extra={}))
    a._presentation_box = p.Outbox(tmp_path / 'box.sqlite3')
    a._presentation_turns = {}
    a._presentation_send = AsyncMock(return_value='$progress')
    event = MessageEvent(text='wave', message_id='$source', source=SessionSource(
        platform=Platform.MATRIX, chat_id='!room', chat_type='dm', user_id='@owner'))
    try:
        with pytest.raises(RuntimeError):
            async with a.admission_presentation_scope(event, 'session', 'admission'):
                def execute():
                    hooks.invoke_hook('pre_llm_call', platform='matrix', turn_id='failed')
                    turn = p._current.get()
                    assert turn.pet_callback({'action': 'wave', 'extra': True})['ok'] is False
                    assert json.loads(pet_tool('sit'))['ok']
                    return turn.pet_callback
                callback = await asyncio.to_thread(execute)
                raise RuntimeError('turn failed before post hook')
        assert callback({'action': 'jump'})['ok'] is False
        assert not a._presentation_turns[('!room', '$source')][0].pet_intents
    finally:
        for turn, *_ in list(a._presentation_turns.values()):
            await turn.end()
        a._presentation_box.db.close()
