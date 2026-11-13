"""Whole-turn admission contract at the shared native facade."""
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from agent.turn_facade import TurnFacadeMixin
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest, LoadedPlugin


@pytest.fixture
def admission(monkeypatch, tmp_path):
    import hermes_cli.plugins as plugins
    manager = PluginManager(scope_key=str(tmp_path))
    manager._discovered = True
    manifest = PluginManifest(name="authority", key="authority")
    manager._plugins["authority"] = LoadedPlugin(manifest=manifest, enabled=True)
    context = PluginContext(manifest, manager)
    config = {"plugins": {"required_admission": ["authority"], "admission_timeout": 0.02}}
    monkeypatch.setattr(plugins, "_delivery_manager", lambda: manager)
    monkeypatch.setattr(plugins, "load_config_readonly", lambda: config)
    return manager, context, config


@pytest.mark.parametrize("platform", ["matrix", "cron", "api", "background", "subagent", "cli", "tui"])
@pytest.mark.parametrize("outcome", ["allow", "deny", "raise", "timeout", "plugin-missing"])
def test_all_turn_sources(admission, monkeypatch, platform, outcome):
    manager, context, config = admission
    release = threading.Event()

    def policy(**kwargs):
        assert kwargs["platform"] == platform
        if outcome == "raise":
            raise RuntimeError("private error must not reach reply")
        if outcome == "timeout":
            release.wait(1)
        return {"allow": outcome == "allow", "reason": "host authority unavailable"}

    if outcome != "plugin-missing":
        context.register_hook("pre_turn_admission", policy, fail_closed=True)
    downstream = Mock(side_effect=RuntimeError("admitted"))
    monkeypatch.setattr("agent.background_review.cancel_background_review_for_live_turn", downstream)
    agent = SimpleNamespace(platform=platform, session_id="session", system_prompt=b"stable prefix", tools=["terminal"])
    history = [{"role": "user", "content": "prior"}, {"role": "assistant", "content": "answer"}]
    original = [dict(item) for item in history]
    try:
        if outcome == "allow":
            with pytest.raises(RuntimeError, match="^admitted$"):
                TurnFacadeMixin.run_conversation(agent, "hello", conversation_history=history)
            downstream.assert_called_once()
        else:
            result = TurnFacadeMixin.run_conversation(agent, "hello", conversation_history=history)
            downstream.assert_not_called()
            assert result["failed"] and result["completed"] is False
            assert result["admission"]["code"] == {
                "deny": "denied", "raise": "hook_error", "timeout": "hook_timeout",
                "plugin-missing": "plugin_unavailable",
            }[outcome]
            assert result["final_response"] and "private error" not in result["final_response"]
            assert result["messages"] == original
            if platform == "cron":
                from cron.scheduler import _final_response_from_result
                with pytest.raises(RuntimeError):
                    _final_response_from_result(result, "job", "job", None)
        assert history == original
        assert agent.system_prompt == b"stable prefix" and agent.tools == ["terminal"]
    finally:
        release.set()


def test_existing_fail_open_plugins(admission):
    from hermes_cli.turn_admission import check_turn_admission
    manager, context, config = admission
    config["plugins"]["required_admission"] = []
    context.register_hook("pre_turn_admission", Mock(side_effect=RuntimeError("legacy")))
    assert check_turn_admission(platform="cli") is None


def test_missing_plugin_readiness(admission, monkeypatch):
    from hermes_cli.turn_admission import admission_readiness
    assert admission_readiness()["status"] == "unavailable"


def test_explicit_missing_managed_directory_still_refuses_real_turn(monkeypatch, tmp_path):
    from hermes_cli.turn_admission import check_turn_admission
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(tmp_path / "missing-managed"))
    (tmp_path / "config.yaml").write_text("{}\n", encoding="utf-8")
    result = check_turn_admission(platform="matrix", user_message="real user turn")
    assert result["turn_exit_reason"] == "admission_denied"
    assert result["admission"]["code"] == "admission_unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["deny", "raise", "timeout", "plugin-missing"])
async def test_gateway_refuses_before_media_tools(admission, monkeypatch, outcome):
    from gateway.run_inbound import GatewayInboundMixin
    media = Mock(side_effect=RuntimeError("media reached"))
    monkeypatch.setattr("gateway.run_inbound.rehome_inbound_media", media)
    manager, context, _ = admission
    release = threading.Event()

    def policy(**kwargs):
        if outcome == "raise":
            raise RuntimeError("broken")
        if outcome == "timeout":
            release.wait(1)
        return False

    if outcome != "plugin-missing":
        context.register_hook("pre_turn_admission", policy, fail_closed=True)
    event = SimpleNamespace(text="image", _gateway_turn_refusal=None)
    source = SimpleNamespace(platform=SimpleNamespace(value="matrix"))
    try:
        result = await GatewayInboundMixin._prepare_inbound_message_text(
            SimpleNamespace(), event=event, source=source, history=[], session_key="session")
        assert result is None
        assert event._gateway_turn_refusal
        media.assert_not_called()
    finally:
        release.set()


def test_manifest_declared_plugin_import_failure(admission, tmp_path):
    from hermes_cli.plugins_manifest import parse_manifest_file
    from hermes_cli.turn_admission import check_turn_admission
    manager, _, config = admission
    config["plugins"]["required_admission"] = []
    plugin = tmp_path / "policy"
    plugin.mkdir()
    (plugin / "plugin.yaml").write_text("name: policy\nfail_closed_admission: true\n")
    (plugin / "__init__.py").write_text("raise RuntimeError('unloadable')\n")
    manifest = parse_manifest_file(plugin / "plugin.yaml", plugin, "user", "")
    assert manifest.fail_closed_admission is True
    manager._gate_manifest(manifest, set(), {"policy"})
    manager._load_plugin(manifest)
    assert check_turn_admission(platform="cron")["admission"]["code"] == "plugin_unavailable"


def test_disposed_policy_blocks(admission):
    from hermes_cli.turn_admission import check_turn_admission
    _, context, _ = admission
    handle = context.register_hook("pre_turn_admission", lambda: True, fail_closed=True)
    handle.dispose()
    assert check_turn_admission()["admission"]["code"] == "plugin_unavailable"


@pytest.mark.parametrize("value", [None, "allow", {}, {"allow": 1}, False])
def test_strict_requires_explicit_boolean_allow(admission, value):
    from hermes_cli.turn_admission import check_turn_admission
    _, context, _ = admission
    context.register_hook("pre_turn_admission", lambda: value, fail_closed=True)
    assert check_turn_admission()["admission"]["code"] == "denied"


def test_async_allow_and_disabled_plugin(admission):
    from hermes_cli.turn_admission import admission_readiness, check_turn_admission
    manager, context, _ = admission

    async def allow():
        return True

    context.register_hook("pre_turn_admission", allow, fail_closed=True)
    assert check_turn_admission() is None
    assert admission_readiness()["status"] == "ok"
    manager._plugins["authority"].enabled = False
    assert check_turn_admission()["admission"]["code"] == "plugin_unavailable"
    assert admission_readiness()["status"] == "unavailable"


@pytest.mark.parametrize("timeout", [0, -1, "bad", float("nan"), float("inf"), 601])
def test_strict_timeout_cannot_be_disabled(admission, timeout):
    from hermes_cli.turn_admission import check_turn_admission
    _, _, config = admission
    config["plugins"]["admission_timeout"] = timeout
    assert check_turn_admission()["admission"]["code"] == "admission_unavailable"


def test_refusal_supports_profile_locale_overlay(admission, monkeypatch, tmp_path):
    from agent.i18n import reset_language_cache
    from hermes_cli.turn_admission import check_turn_admission
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_LANGUAGE", "de")
    (tmp_path / "locales").mkdir()
    (tmp_path / "locales" / "de.yaml").write_text(
        'turn_admission:\n  configuration_error: "Noch nicht bereit ({code})."\n')
    reset_language_cache()
    try:
        # A missing plugin is a setup problem, so the overlay's configuration line is shown.
        assert check_turn_admission()["final_response"] == "Noch nicht bereit (plugin_unavailable)."
    finally:
        reset_language_cache()


@pytest.mark.asyncio
async def test_refused_gateway_turn_skips_goal_judge(monkeypatch):
    from gateway.run_goals import GatewayGoalsMixin
    monkeypatch.setattr("gateway.session_authorities.active_authority", lambda _: None)
    monkeypatch.setattr("gateway.session_viewer_automation.viewer_driven", lambda *_: False)
    await GatewayGoalsMixin._run_post_turn_hooks(
        SimpleNamespace(), agent_result="refused", source=SimpleNamespace(), is_internal=False,
        event=SimpleNamespace(_gateway_turn_refusal="refused"))


@pytest.mark.parametrize("no_agent", [True, False])
@pytest.mark.parametrize("outcome", ["allow", "deny", "raise", "timeout", "plugin-missing"])
def test_cron_refuses_before_scripts(admission, monkeypatch, no_agent, outcome):
    from cron.scheduler import _prepare_job_prompt
    _, context, _ = admission
    release = threading.Event()

    def policy(**kwargs):
        assert kwargs["platform"] == "cron" and kwargs["job_id"] == "job"
        if outcome == "raise":
            raise RuntimeError("broken")
        if outcome == "timeout":
            release.wait(1)
        return outcome == "allow"

    if outcome != "plugin-missing":
        context.register_hook("pre_turn_admission", policy, fail_closed=True)
    scripts = Mock(side_effect=RuntimeError("script reached"))
    monkeypatch.setattr("cron.scheduler._prepare_managed_script_gate", scripts)
    monkeypatch.setattr("hermes_cli.config.require_parseable_user_config", lambda: None)
    try:
        args = ({"id": "job", "no_agent": no_agent, "script": "script.py"}, "job", "job", None, None)
        if outcome == "allow":
            with pytest.raises(RuntimeError, match="script reached"):
                _prepare_job_prompt(*args)
            scripts.assert_called_once()
        else:
            early, prompt = _prepare_job_prompt(*args)
            assert early[0] is False and early[2] and "turn admission" in early[3]
            assert prompt is None
            scripts.assert_not_called()
    finally:
        release.set()


def test_reload_requirement_added_before_callback_snapshot(admission, monkeypatch):
    import hermes_cli.turn_admission as policy
    manager, _, _ = admission
    # Discovery can add a requirement after config was read, before registry snapshot.
    manager._admission_required.add("new-policy")
    monkeypatch.setattr(policy, "_policy", lambda: (manager, set(), 30))
    assert policy.check_turn_admission()["admission"]["code"] == "plugin_unavailable"


@pytest.mark.parametrize('fallback', [{}, {'plugins': {'required_admission': []}}])
def test_broken_config_refuses_even_with_old_backup(admission, monkeypatch, fallback):
    from hermes_cli.config import FailedConfigRead
    from hermes_cli.turn_admission import check_turn_admission, admission_readiness
    monkeypatch.setattr('hermes_cli.plugins.load_config_readonly', lambda: FailedConfigRead(fallback, error=ValueError('bad yaml')))
    assert check_turn_admission()['admission']['code'] == 'admission_unavailable'
    assert admission_readiness()['status'] == 'unavailable'


@pytest.mark.parametrize('timeout', [0, None, 'bad', -1])
def test_no_policy_ignores_unused_timeout(admission, timeout):
    from hermes_cli.turn_admission import check_turn_admission
    _, _, config = admission
    config['plugins'] = {'required_admission': None, 'admission_timeout': timeout}
    assert check_turn_admission() is None


def test_zero_timeout_configuration_diagnostic(admission):
    from hermes_cli.turn_admission import admission_readiness
    admission[2]['plugins']['admission_timeout'] = 0
    result = admission_readiness()
    assert 'positive' in result['reason'] and '0' in result['reason']


def test_system_exit_is_denial(admission):
    from hermes_cli.turn_admission import check_turn_admission
    admission[1].register_hook('pre_turn_admission', Mock(side_effect=SystemExit(1)), fail_closed=True)
    assert check_turn_admission()['admission']['code'] == 'hook_error'


@pytest.mark.parametrize('contents', ['plugins:\n  required_admission: [managed-authority]\n', 'plugins: [broken', 'plugins: [unterminated'])
def test_managed_pin_cannot_be_removed_by_profile(admission, monkeypatch, tmp_path, contents):
    from hermes_cli.turn_admission import check_turn_admission
    managed = tmp_path / 'managed'
    managed.mkdir()
    (managed / 'config.yaml').write_text(contents)
    monkeypatch.setenv('HERMES_MANAGED_DIR', str(managed))
    admission[2]['plugins']['required_admission'] = []
    result = check_turn_admission()
    assert result is not None
    if 'managed-authority' in contents:
        assert result['admission']['plugin'] == 'managed-authority'
    else:
        assert result['admission']['code'] == 'admission_unavailable'


@pytest.mark.parametrize('kind', ['model-provider', 'exclusive'])
def test_required_unloadable_kind_has_configuration_error(admission, kind):
    from hermes_cli.turn_admission import check_turn_admission, admission_readiness
    admission[0]._plugins['authority'].manifest.kind = kind
    assert 'kind' in admission_readiness()['reason']
    result = check_turn_admission()
    assert result['admission']['code'] == 'admission_unavailable'
    # The owner sees the setup-not-ready line (the same one a missing plugin gets), not a refusal.
    from agent.i18n import t
    assert result['final_response'] == t('turn_admission.configuration_error')
    assert result['final_response'] != t('turn_admission.refused')


@pytest.mark.asyncio
@pytest.mark.parametrize('flip', ['stop-during-transcription', 'policy-flip'])
async def test_second_check_is_unexecuted_failure(admission, monkeypatch, flip):
    from datetime import datetime
    from unittest.mock import AsyncMock
    from gateway.run import GatewayRunner
    from gateway.config import Platform
    from gateway.platforms.event import MessageEvent
    from gateway.session import SessionSource, SessionEntry
    from hermes_cli.turn_admission import check_turn_admission
    from gateway.session_results import execution_result
    source = SessionSource(platform=Platform.DISCORD, chat_id='chat', user_id='user')
    event = MessageEvent(text='voice request', source=source)
    entry = SessionEntry(session_id='test', session_key='test', created_at=datetime.now(), updated_at=datetime.now())
    runner = GatewayRunner.__new__(GatewayRunner)
    runner._hmwa_resolve_session = AsyncMock(return_value=(source, entry, 'test'))
    prepared = object.__new__(runner._PreparedTurn)
    # The real media entry checks before STT. The mocked enrichment below flips Stop during STT.
    policy_state = {'allow': True}
    decisions = []
    def policy(**ctx):
        decisions.append(ctx)
        return policy_state['allow']
    admission[1].register_hook('pre_turn_admission', policy, fail_closed=True)
    from gateway.run_inbound import GatewayInboundMixin
    seen = []
    admission[1].register_hook('pre_turn_admission', lambda **ctx: seen.append(ctx) or True)
    async def transcribe(*args):
        policy_state['allow'] = False  # owner presses Stop while transcription is in flight
        return 'transcribed voice'
    runner._consume_pending_native_image_paths = lambda _: []
    runner._prefix_inbound_sender_context = lambda event, source, text: text
    runner._classify_inbound_media = lambda *args: ([], ['voice.ogg'] if flip == 'stop-during-transcription' else [], [], [])
    runner._enrich_inbound_voice = AsyncMock(side_effect=transcribe)
    runner._prepend_inbound_media_file_notes = lambda text, *args: text
    runner._prepend_inbound_document_notes = lambda text, *args: text
    runner._prepend_inbound_reply_context = lambda event, source, text: text
    monkeypatch.setattr('gateway.run_inbound.rehome_inbound_media', lambda _: None)
    async def references(runner, event, source, session_key, text):
        return text
    monkeypatch.setattr('gateway.session_context_refs.turn_references', references)
    async def prepare(*args):
        assert await GatewayInboundMixin._prepare_inbound_message_text(
            runner, event=event, source=source, history=[], session_key='test') is not None
        if flip == 'policy-flip':
            policy_state['allow'] = False
        return prepared, {}
    for key, value in dict(history=[], message_text='transcribed voice', context_prompt='', persist_user_message=None,
                           persist_user_timestamp=None, persist_user_display_kind=None, persist_user_display_metadata=None,
                           persistence_owner='gateway', title_user_message='voice').items():
        object.__setattr__(prepared, key, value)
    runner._hmwa_prepare_turn = prepare
    runner.hooks = SimpleNamespace(emit=AsyncMock())
    runner._pinned_channel_inputs = lambda *a, **kw: ('', source)
    runner._persist_prompt_pins = AsyncMock()
    runner._reply_anchor_for_event = lambda _: ''
    runner._run_agent = AsyncMock(side_effect=lambda **_: TurnFacadeMixin.run_conversation(SimpleNamespace(platform='discord'), 'voice'))
    runner._hmwa_stop_typing_for_turn = AsyncMock()
    runner._is_session_run_current = lambda *a: True
    runner._clear_session_env = Mock()
    runner._hmwa_shape_agent_response = AsyncMock(side_effect=AssertionError('denial reached response shaping'))
    runner._hmwa_persist_turn_transcript = AsyncMock(side_effect=AssertionError('denial persisted'))
    async def propagate(exc, *args):
        raise exc
    runner._hmwa_agent_error_reply = propagate
    monkeypatch.setattr('gateway.run_heartbeat_acceptance.heartbeat_owner_is_current', lambda *a: True)
    captured = {}
    token = execution_result.set(captured)
    try:
        reply = await runner._handle_message_with_agent(event, source, 'test', 1)
        assert reply == captured['result']['final_response']
        assert 'Send it again' not in reply
        assert captured['result']['messages'] == []
        assert [ctx['stage'] for ctx in seen] == ['gateway_media']
        assert [ctx['stage'] for ctx in decisions] == ['gateway_media', 'turn']
        assert decisions[0]['turn_id'] == decisions[1]['turn_id']
        # The strict veto runs before the observer at the facade boundary.
        if flip == 'stop-during-transcription':
            runner._enrich_inbound_voice.assert_awaited_once()
        runner._hmwa_persist_turn_transcript.assert_not_called()
    finally:
        execution_result.reset(token)


def test_stable_admission_identity_reaches_tools(admission):
    from hermes_cli.turn_admission import check_turn_admission
    from agent.inline_tool_executors import tool_hook_ids
    seen = []
    admission[1].register_hook('pre_turn_admission', lambda **ctx: seen.append(ctx) or True, fail_closed=True)
    check_turn_admission(turn_id='owner-operation', stage='gateway_media')
    check_turn_admission(turn_id='owner-operation', stage='turn')
    assert [ctx['turn_id'] for ctx in seen] == ['owner-operation', 'owner-operation']
    assert tool_hook_ids(SimpleNamespace(_current_turn_id='owner-operation'), '', '')['turn_id'] == 'owner-operation'


def test_real_config_read_managed_precedence_and_corruption(monkeypatch, tmp_path):
    from hermes_cli.turn_admission import check_turn_admission, admission_readiness
    from hermes_cli.config import load_config_readonly
    home = tmp_path / 'profile'
    home.mkdir()
    managed = tmp_path / 'managed'
    managed.mkdir()
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setenv('HERMES_MANAGED_DIR', str(managed))
    profile = home / 'config.yaml'
    profile.write_text('plugins:\n  required_admission: [profile-policy]\n  admission_timeout: 0\n')
    (managed / 'config.yaml').write_text('plugins:\n  required_admission: [managed-policy]\n  admission_timeout: 20\n')
    config = load_config_readonly()
    assert set(config['plugins']['required_admission']) == {'profile-policy', 'managed-policy'}
    assert config['plugins']['admission_timeout'] == 20
    profile.write_text('plugins: [unterminated')
    assert check_turn_admission()['admission']['code'] == 'admission_unavailable'
    assert admission_readiness()['status'] == 'unavailable'


def test_facade_identifier_binds_native_tool_context(admission, monkeypatch):
    from hermes_cli.turn_admission import admission_turn_id
    from agent.turn_context import _bind_turn_identity
    from agent.inline_tool_executors import tool_hook_ids
    admission[1].register_hook('pre_turn_admission', lambda **_: True, fail_closed=True)
    agent = SimpleNamespace(platform='discord', session_id='session')
    def reached(agent):
        _bind_turn_identity(agent, 'task', None, None, None, None)
        assert tool_hook_ids(agent, 'task', 'call')['turn_id'] == 'host-admission'
        raise RuntimeError('verified')
    monkeypatch.setattr('agent.background_review.cancel_background_review_for_live_turn', reached)
    token = admission_turn_id.set('host-admission')
    try:
        with pytest.raises(RuntimeError, match='verified'):
            TurnFacadeMixin.run_conversation(agent, 'hello')
    finally:
        admission_turn_id.reset(token)
