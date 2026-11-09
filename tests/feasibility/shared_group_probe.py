"""Opt-in acceptance probe; run explicitly (known failures block shared groups).

Only provider transport/metadata and filesystem locations are substituted. Tool
resolution, prompt building, config/plugin loading and the agent loop are real.
No shared-group product endpoint calls this harness. All data is synthetic.
"""
from __future__ import annotations

import builtins
import copy
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

FIXTURE = json.loads((Path(__file__).parents[1] / 'fixtures/shared-group-feasibility.json').read_text())


def response(content='Captured fixture reply. Steady steps.', tool_calls=None):
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=content, tool_calls=tool_calls),
        finish_reason='tool_calls' if tool_calls else 'stop',
    )], model='fixture/owned-advisor', usage=None)


@pytest.fixture
def harness(tmp_path, monkeypatch):
    assert not (Path(__file__).resolve().parents[2] / '.env').exists(), 'Use a clean worktree without .env for this diagnostic'
    # Explicitly isolate HOME too; the repository fixture redirects HERMES_HOME
    # only. Never examine the operator's real profile, environment or sessions.
    home = tmp_path / 'home'
    hermes = home / '.hermes'
    project = tmp_path / 'project'
    (hermes / 'memories').mkdir(parents=True)
    project.mkdir()
    monkeypatch.setenv('HOME', str(home))
    monkeypatch.setenv('HERMES_HOME', str(hermes))
    monkeypatch.chdir(project)
    monkeypatch.setattr('run_agent._hermes_home', hermes)
    monkeypatch.setattr('agent.model_metadata.fetch_model_metadata', lambda *a, **kw: {})
    client = MagicMock()
    captures = []
    replies = []

    def complete(**kwargs):
        captures.append(copy.deepcopy(kwargs))
        return replies.pop(0) if replies else response()

    client.chat.completions.create.side_effect = complete
    monkeypatch.setattr('run_agent.OpenAI', lambda **kw: client)
    paths = {}
    for key, relative in {
        'memory': 'memories/MEMORY.md', 'user': 'memories/USER.md',
        'private_session': 'sessions/private.json',
        'cross_profile': 'profiles/other/memories/MEMORY.md',
        'private_file': 'private-note.txt', 'plugin': 'plugin-private.txt',
    }.items():
        target = hermes / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(FIXTURE['private_canaries'][key])
        paths[key] = target
    paths['project'] = project / 'AGENTS.md'
    paths['project'].write_text(FIXTURE['private_canaries']['project'])
    (hermes / 'SOUL.md').write_text(FIXTURE['persona']['text'])
    config = {'agent': {'environment_probe': False}, 'memory': {
        'memory_enabled': True, 'user_profile_enabled': True,
    }}
    reads = []
    original_open = io.open

    def observe_open(file, mode='r', *args, **kwargs):
        if isinstance(file, (str, os.PathLike)) and 'r' in mode:
            resolved = Path(file).resolve()
            for key, target in paths.items():
                if resolved == target.resolve():
                    reads.append(key)
        return original_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(io, 'open', observe_open)
    monkeypatch.setattr(builtins, 'open', observe_open)

    def construct(*, tools=None, persist_disabled=True):
        from run_agent import AIAgent
        import yaml
        (hermes / 'config.yaml').write_text(yaml.safe_dump(config))
        agent = AIAgent(
            api_key='synthetic-fixture-key', base_url='https://fixture.invalid/v1',
            provider='openrouter', api_mode='chat_completions', platform='cli',
            model='fixture/owned-advisor', max_iterations=3, quiet_mode=True,
            skip_memory=True, skip_context_files=True, load_soul_identity=True,
            enabled_toolsets=[] if tools is None else tools,
            session_db=None, session_id='synthetic-shared-proof',
            save_trajectories=False,
        )
        # Existing background-review seam; no private DB/JSON persistence.
        agent._persist_disabled = persist_disabled
        return agent

    return SimpleNamespace(construct=construct, config=config, paths=paths,
        reads=reads, captures=captures, replies=replies, hermes=hermes,
        tmp_path=tmp_path, monkeypatch=monkeypatch)


def group_message():
    # Explicit allowlist: fixture private_canaries/authority are never serialized.
    assert len(FIXTURE['messages']) <= FIXTURE['history_limit']['messages']
    assert FIXTURE['requester_id'] == FIXTURE['assistant_owner_id'] == FIXTURE['payer_id']
    assert FIXTURE['source_message_id'] == FIXTURE['watermark']['message_id']
    projection = json.dumps({'room': FIXTURE['conversation_id'],
        'messages': FIXTURE['messages'], 'watermark': FIXTURE['watermark'],
        'truncated': FIXTURE['truncated']})
    assert len(projection) <= FIXTURE['history_limit']['characters']
    return projection


def test_clean_profile_real_core_preserves_persona_and_group_followup(harness):
    agent = harness.construct()
    assert agent.valid_tool_names == set()
    first = agent.run_conversation(group_message())
    assert first['final_response'] == 'Captured fixture reply. Steady steps.'
    agent.run_conversation('What did Sam suggest?', conversation_history=first['messages'])
    assert len(harness.captures) == 2
    requests = json.dumps(harness.captures)
    assert FIXTURE['persona']['text'] in requests
    assert 'riverside room' in requests
    assert all(c['model'] == 'fixture/owned-advisor' for c in harness.captures)
    assert harness.captures[0]['messages'][0] == harness.captures[1]['messages'][0]
    assert all(not c.get('tools') for c in harness.captures)
    assert all(value not in requests for value in FIXTURE['private_canaries'].values())
    assert harness.reads == []
    assert agent._session_db is None
    assert not list((harness.hermes / 'sessions').glob('*shared*'))


def test_forged_tool_call_cannot_read_private_file(harness):
    harness.replies.extend([
        response(tool_calls=[SimpleNamespace(id='forged', type='function',
            function=SimpleNamespace(name='read_file', arguments=json.dumps({
                'path': str(harness.paths['private_file'])}))) ]),
        response(),
    ])
    agent = harness.construct()
    result = agent.run_conversation(group_message())
    assert result['final_response'] == 'Captured fixture reply. Steady steps.'
    assert harness.reads == []
    assert FIXTURE['private_canaries']['private_file'] not in json.dumps(harness.captures)
    # The real loop must carry its refusal into the follow-up provider request.
    assert len(harness.captures) == 2
    refusals = [message for message in harness.captures[1]['messages']
                if message.get('role') == 'tool' and message.get('tool_call_id') == 'forged']
    assert len(refusals) == 1
    assert 'read_file' in refusals[0]['content']
    assert 'does not exist' in refusals[0]['content']


def test_private_config_hint_does_not_enter_shared_request(harness):
    harness.config['platform_hints'] = {'cli': {'append': FIXTURE['private_canaries']['config_prompt']}}
    agent = harness.construct()
    agent.run_conversation(group_message())
    assert FIXTURE['private_canaries']['config_prompt'] not in json.dumps(harness.captures)


def test_configured_context_plugin_cannot_read_private_data(harness):
    import plugins.context_engine as engines
    import sys
    plugins = harness.tmp_path / 'context_plugins'
    plugin = plugins / 'shared_probe'
    plugin.mkdir(parents=True)
    # Exercise the real dynamic loader. Relocate only its discovery root.
    (plugin / '__init__.py').write_text(
        'from pathlib import Path\n'
        f'PRIVATE_DATA = Path({str(harness.paths["plugin"])!r}).read_text()\n'
    )
    harness.monkeypatch.setattr(engines, '_CONTEXT_ENGINE_PLUGINS_DIR', plugins)
    harness.monkeypatch.delitem(sys.modules, 'plugins.context_engine.shared_probe', raising=False)
    harness.config['context'] = {'engine': 'shared_probe'}
    agent = harness.construct()
    assert agent.valid_tool_names == set()
    assert harness.reads == [], f'Private read during construction: {harness.reads}'


def test_existing_context_local_home_can_bound_clean_execution(harness):
    """Probe the existing profile ContextVar seam, never mutate process env per turn.

    The process profile retains private config/memory; only an explicitly created
    public SOUL/config projection is selected for this invocation. This does not
    claim all child-thread/fallback paths honor that ContextVar.
    """
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    public_home = harness.tmp_path / 'shared-profile'
    public_home.mkdir()
    (public_home / 'SOUL.md').write_text(FIXTURE['persona']['text'])
    (public_home / 'config.yaml').write_text('agent:\n  environment_probe: false\n')
    harness.config['platform_hints'] = {'cli': {'append': FIXTURE['private_canaries']['config_prompt']}}
    harness.config['context'] = {'engine': 'private_engine_must_not_load'}
    token = set_hermes_home_override(public_home)
    try:
        agent = harness.construct()
        first = agent.run_conversation(group_message())
        agent.run_conversation('What did Sam suggest?', conversation_history=first['messages'])
    finally:
        reset_hermes_home_override(token)
    assert agent.valid_tool_names == set()
    assert harness.reads == []
    requests = json.dumps(harness.captures)
    assert FIXTURE['persona']['text'] in requests
    assert 'riverside room' in requests
    assert all(value not in requests for value in FIXTURE['private_canaries'].values())
    assert not (public_home / 'state.db').exists()


def test_context_local_profile_does_not_change_private_process_session(harness):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    public_home = harness.tmp_path / 'shared-profile'
    public_home.mkdir()
    (public_home / 'SOUL.md').write_text(FIXTURE['persona']['text'])
    (public_home / 'config.yaml').write_text('agent:\n  environment_probe: false\n')
    harness.monkeypatch.setenv('HERMES_SESSION_ID', 'synthetic-private-process-session')
    token = set_hermes_home_override(public_home)
    try:
        harness.construct()
    finally:
        reset_hermes_home_override(token)
    assert os.environ['HERMES_SESSION_ID'] == 'synthetic-private-process-session'
