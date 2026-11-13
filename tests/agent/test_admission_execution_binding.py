"""Real bounded admission -> native agent loop -> host tool, no external service."""
from contextlib import contextmanager
from contextvars import copy_context
import json
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest, LoadedPlugin
from tests.agent.test_run_agent import _mock_response


@pytest.fixture
def policy(monkeypatch, tmp_path):
    from hermes_cli import plugins
    manager = PluginManager(scope_key=str(tmp_path))
    manager._discovered = True
    manifest = PluginManifest(name='binding-policy', key='binding-policy')
    manager._plugins[manifest.key] = LoadedPlugin(manifest=manifest, enabled=True)
    monkeypatch.setattr(plugins, '_delivery_manager', lambda: manager)
    monkeypatch.setattr(plugins, 'load_config_readonly', lambda: {
        'plugins': {'required_admission': ['binding-policy'], 'admission_timeout': 1}})
    return manager, PluginContext(manifest, manager)


def agent():
    from run_agent import AIAgent
    from tools.atum_chats_tool import ATUM_CHATS_SCHEMA
    with (patch('model_tools.get_tool_definitions', return_value=[{'type': 'function', 'function': ATUM_CHATS_SCHEMA}]),
          patch('model_tools.check_toolset_requirements', return_value={}),
          patch('agent.process_bootstrap.OpenAI')):
        result = AIAgent(api_key='offline-fixture', model='fixture', session_id='binding-session',
            base_url='https://api.example.org/v1', quiet_mode=True, skip_memory=True, skip_context_files=True)
    result._disable_streaming = True
    result._cached_system_prompt = 'Stable fixture prompt.'
    result._use_prompt_caching = False
    result.compression_enabled = False
    result.tool_delay = 0
    result.save_trajectories = False
    return result


@pytest.mark.parametrize('stop', [False, True])
@pytest.mark.parametrize('scheduled', [False, True], ids=['owner-turn', 'native-cron'])
def test_bounded_policy_binding_reaches_real_tool_and_unwinds_in_turn_context(policy, monkeypatch, stop, scheduled):
    from gateway.session_context import scoped_session_key
    from tools import atum_source_transport as port
    from tools.atum_chats_tool import atum_chats
    monkeypatch.setattr(port, '_host_transport_enabled', True)
    a = agent()
    owner = threading.get_ident()
    entered, exited, workers, requests, inherited = [], [], [], [], []

    def host(tool, payload):
        requests.append((tool, payload))
        inherited.append(copy_context())
        if stop:
            a.interrupt('fixture Stop')
        return {'rooms': [], 'truncated': False}

    @contextmanager
    def binding():
        entered.append(threading.get_ident())
        try:
            with port.bind_source_transport(host):
                yield
        finally:
            exited.append(threading.get_ident())

    def admit(**payload):
        workers.append(threading.get_ident())
        if scheduled:
            assert payload['source'] == {'kind': 'schedule', 'job': 'selected', 'scheduledAt': 1794531723000}
            assert payload['cron_execution_id'] == 'native-execution'
        return {'allow': True, 'enter': binding}

    policy[1].register_hook('pre_turn_admission', admit, fail_closed=True)
    call = SimpleNamespace(id='read-chats', type='function', function=SimpleNamespace(
        name='atum_chats', arguments=json.dumps({'op': 'list'})))
    replies = [_mock_response(content=None, finish_reason='tool_calls', tool_calls=[call]),
               _mock_response(content='Done', finish_reason='stop')]
    from cron.execution_identity import enter_cron_execution, exit_cron_execution
    token = enter_cron_execution({'id': 'selected'}, 'native-execution', {
        'source': 'builtin', 'scheduled_instant': '2026-11-13T01:02:03+00:00'}) if scheduled else None
    try:
        with scoped_session_key('owner-dm'), patch.object(a, '_interruptible_api_call', side_effect=replies):
            result = a.run_conversation('Read my chats')
    finally:
        exit_cron_execution(token)
    assert requests and requests[0][0] == 'chats'
    assert entered == exited == [owner]
    assert workers and all(worker != owner for worker in workers)
    assert result.get('interrupted') if stop else result['completed']
    assert port.source_transport() is None
    assert 'unavailable for this run' in json.loads(inherited[0].run(atum_chats, 'list'))['error']


def test_factory_entry_failure_refuses_before_model_and_unwinds_previous_binding(policy, monkeypatch):
    a = agent()
    entered, exited = [], []
    @contextmanager
    def first():
        entered.append(True)
        try:
            yield
        finally:
            exited.append(True)
    def broken():
        raise RuntimeError('private binding details')
    policy[1].register_hook('pre_turn_admission', lambda **kw: {'allow': True, 'enter': first}, fail_closed=True)
    policy[1].register_hook('pre_turn_admission', lambda **kw: {'allow': True, 'enter': broken}, fail_closed=True)
    model = MagicMock(side_effect=AssertionError('model must not run'))
    monkeypatch.setattr(a, '_interruptible_api_call', model)
    result = a.run_conversation('do not run')
    assert entered == exited == [True]
    assert result['turn_exit_reason'] == 'admission_denied'
    assert result['admission']['code'] == 'binding_error'
    assert 'private binding details' not in result['final_response']
    model.assert_not_called()


def test_later_denial_never_enters_allowed_factory(policy):
    from hermes_cli.turn_admission import check_turn_admission
    factory = MagicMock()
    policy[1].register_hook('pre_turn_admission', lambda **kw: {'allow': True, 'enter': factory}, fail_closed=True)
    policy[1].register_hook('pre_turn_admission', lambda **kw: False, fail_closed=True)
    result = check_turn_admission(stage='turn')
    assert result['admission']['code'] == 'denied'
    factory.assert_not_called()
