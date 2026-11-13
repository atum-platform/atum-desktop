"""Offline native cloud composition: config + trusted run, no desktop/client."""
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
import json
from types import SimpleNamespace

import pytest

from agent.agent_init import _init_memory
from agent.atum_awareness import AwarenessSessionError
from agent.memory_provider import ctx_bound
from agent.memory_run_lifecycle import MemoryRunLifecycle, bind_cloud_memory_from_config
from hermes_state import SessionDB
from tests.agent.test_atum_awareness_v2 import binding, response


@pytest.fixture
def cloud_run(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    db = SessionDB(db_path=tmp_path / 'state.db')
    b = binding()
    b['audience']['class'] = 'background_private'
    db.create_session(b['sessionId'], 'cron')
    lifecycle = MemoryRunLifecycle(db)
    calls = []
    # Synthetic process credential stays in the trusted transport closure.
    credential = ContextVar('fixture_cloud_credential', default=None)
    token = credential.set('fixture-not-a-real-credential')

    def retrieve(req, cancelled):
        assert credential.get() == 'fixture-not-a-real-credential'
        assert not cancelled.is_set()
        calls.append(req)
        return response(req, cancelled)

    try:
        yield dict(binding=b, hermes_home=str(tmp_path), lifecycle=lifecycle,
                   retrieve=retrieve, is_current=lambda: True, invalidate_run=lambda: None), calls, db
    finally:
        credential.reset(token)
        db.close()


def test_config_binds_native_provider_in_cron_worker(cloud_run):
    trusted, calls, db = cloud_run
    config = {'memory': {'provider': 'atum_awareness', 'atum_awareness': {'enabled': True},
                         'memory_enabled': True, 'user_profile_enabled': True}}

    def cron_worker():
        kwargs = bind_cloud_memory_from_config(config, agent_context='cron', **trusted)
        manager = kwargs['memory_manager']
        # Exercise the same native initialization used by cron's AIAgent.
        agent = SimpleNamespace(enabled_toolsets=['memory'], disabled_toolsets=[], tools=[])
        _init_memory(agent, config, False, 'cron', **kwargs)
        assert agent._memory_manager is manager
        assert agent._memory_enabled and agent._user_profile_enabled
        assert 'atum_recall' in agent.valid_tool_names
        prompt, schemas = manager.build_system_prompt(), manager.get_all_tool_schemas()
        result = json.loads(manager.handle_tool_call('atum_recall', {'query': 'launch'}))
        assert result['status'] == 'ok'
        assert result['items'][0]['lineage']['kind'] == 'personal'
        assert prompt == manager.build_system_prompt()
        assert schemas == manager.get_all_tool_schemas()
        manager.assert_run_authority()
        manager.shutdown_all()

    # scheduler uses this same native context propagation for its watchdog worker.
    with ThreadPoolExecutor(max_workers=1) as executor:
        executor.submit(ctx_bound(cron_worker)).result(timeout=10)
    assert len(calls) == 1
    assert calls[0]['binding']['audience']['class'] == 'background_private'
    records = db.list_meta_prefix('memory.provenance.v2.')
    assert len(records) == 1
    assert 'fixture-not-a-real-credential' not in records[0][1]
    assert 'content' not in json.loads(records[0][1])['items'][0]


@pytest.mark.parametrize('memory', [
    {}, {'provider': 'builtin'}, {'provider': 'atum_awareness'},
    {'provider': 'atum_awareness', 'atum_awareness': {'enabled': False}},
    {'provider': 'atum_awareness', 'atum_awareness': {'enabled': 'true'}},
    {'provider': 'other', 'atum_awareness': {'enabled': True}},
])
def test_config_is_explicit_opt_in(cloud_run, memory):
    trusted, calls, _ = cloud_run
    assert bind_cloud_memory_from_config({'memory': memory}, **trusted) == {'skip_memory': True}
    assert not calls


def test_config_does_not_supply_authority(cloud_run):
    trusted, calls, _ = cloud_run
    trusted['is_current'] = lambda: False
    with pytest.raises(AwarenessSessionError):
        bind_cloud_memory_from_config(
            {'memory': {'provider': 'atum_awareness', 'atum_awareness': {'enabled': True}}},
            agent_context='cron', **trusted)
    assert not calls
