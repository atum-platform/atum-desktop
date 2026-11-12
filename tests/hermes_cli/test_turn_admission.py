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
            assert result["messages"] == []
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


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["deny", "raise", "timeout", "plugin-missing"])
async def test_gateway_refuses_before_media_tools(admission, outcome):
    from gateway.run_inbound import GatewayInboundMixin
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
