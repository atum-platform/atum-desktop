"""The native Matrix gateway reuses an agent across SOUL edits and turn boundaries."""

from hashlib import sha256
from threading import Lock

import pytest


class TurnObserved(BaseException):
    """Stop after turn setup, before any model call."""


@pytest.mark.parametrize('scenario', ['owner', 'owner-missing-prompt', 'unmanaged', 'group', 'bot', 'non-matrix'])
@pytest.mark.asyncio
async def test_warm_agent_refreshes_only_changed_managed_owner_identity(tmp_path, monkeypatch, caplog, scenario):
    from agent.agent_runtime_helpers import note_turn_persisted
    from gateway.config import Platform
    from gateway.platform_registry import platform_registry
    from gateway.run import GatewayRunner
    from gateway.run_turn_runner import TurnRunner
    from gateway.session import SessionSource
    from gateway.turn_context import TurnContext
    from hermes_state import AsyncSessionDB, SessionDB
    from hermes_cli.plugins import discover_plugins
    from run_agent import AIAgent

    managed = scenario != 'unmanaged'
    platform = Platform.TELEGRAM if scenario == 'non-matrix' else Platform.MATRIX
    refreshes = scenario in ('owner', 'owner-missing-prompt')
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr('model_tools.get_tool_definitions', lambda *args, **kwargs: [])
    monkeypatch.setattr('model_tools.check_toolset_requirements', lambda *args, **kwargs: {})
    monkeypatch.setattr(AIAgent, '_create_openai_client', lambda *args, **kwargs: None)
    (tmp_path / 'config.yaml').write_text(
        f'agent:\n  atum_instructions: {str(managed).lower()}\n  environment_probe: false\n'
        'memory:\n  memory_enabled: false\n  user_profile_enabled: false\n'
        'model:\n  context_length: 256000\n'
    )
    # Real gateway startup resolves its enabled adapter before hashing the
    # tool registry for the first cached agent.
    discover_plugins()
    assert platform_registry.get('matrix') is not None
    soul = tmp_path / 'SOUL.md'

    def write_soul(revision, text):
        body = f'{text}\n'.encode()
        fields = f'{revision} seed_bytes=1'
        digest = sha256(fields.encode() + b'\n' + body).hexdigest()
        soul.write_bytes(f'<!-- atum:instructions revision={fields} sha256={digest} -->\n'.encode() + body)

    write_soul(1, 'Original owner persona')
    db = SessionDB(tmp_path / 'state.db')
    session = 'managed-soul'
    db.create_session(session, platform.value)
    runner = GatewayRunner.__new__(GatewayRunner)
    runner._session_db = AsyncSessionDB(db)
    runner._agent_cache = {}
    runner._agent_cache_lock = Lock()
    runner._service_tier = None
    runner._prefill_messages = None
    runner._refresh_fallback_model = lambda: None
    runner._consume_pending_native_image_paths = lambda key: []
    runner.session_authority = None
    source = SessionSource(platform=platform, chat_id='!room:example.org',
                           chat_type='group' if scenario == 'group' else 'dm',
                           user_id='@guest:example.org' if scenario == 'group' else '@owner:example.org',
                           is_bot=scenario == 'bot')
    ctx = TurnContext(source=source, session_id=session, session_key='matrix:owner',
                      AIAgent=AIAgent, user_config={'gateway': {'platforms': {platform.value: {
                          'skip_context_files': True}}}}, message='Hello', enabled_toolsets=[])
    route = dict(model='test-model', runtime=dict(api_key='test-key', base_url='http://127.0.0.1:1/v1'))
    builds = []
    build = AIAgent._build_system_prompt

    def counted(agent, system_message=None):
        builds.append(agent)
        return build(agent, system_message)

    monkeypatch.setattr(AIAgent, '_build_system_prompt', counted)

    edit_during_turn = None

    def observe(*args, **kwargs):
        if edit_during_turn is not None:
            write_soul(*edit_during_turn)
        raise TurnObserved

    monkeypatch.setattr('agent.turn_context._collect_pre_llm_call_context', observe)
    agent = None

    async def turn():
        nonlocal agent
        worker = TurnRunner(runner, ctx)
        current, reused = worker._resolve_turn_agent(route, platform.value, '', 8, None, {})
        assert reused == (agent is not None)
        if reused:
            assert current is agent
        agent = current
        with pytest.raises(TurnObserved):
            worker._run_conversation_with_approval(
                agent, [{'role': 'user', 'content': 'Earlier message'}] if reused else [],
                None, None, None,
            )
        note_turn_persisted(agent)
        await runner._refresh_agent_cache_message_count(ctx.session_key, session)
        prompt = agent._cached_system_prompt
        assert db.get_session(session)['system_prompt'] == prompt
        return prompt

    try:
        original = await turn()
        assert 'Original owner persona' in original
        assert 'seed_bytes=' not in original
        write_soul(2, 'Original owner persona')
        edit_during_turn = (3, 'Updated owner persona')
        assert await turn() == original
        edit_during_turn = None
        ctx.persist_user_display_kind = 'internal_notification'
        assert await turn() == original
        ctx.persist_user_display_kind = None
        if scenario == 'owner-missing-prompt':
            db.update_system_prompt(session, None)
            assert db.get_session(session)['system_prompt'] is None
        caplog.set_level('INFO', logger='agent.conversation_loop')
        updated = await turn()
        assert ('Updated owner persona' in updated) is refreshes
        assert (updated != original) is refreshes
        if scenario == 'owner-missing-prompt':
            assert 'was built from earlier instructions' in caplog.text
        assert await turn() == updated
        assert builds == ([agent, agent] if refreshes else [agent])
    finally:
        db.close()
