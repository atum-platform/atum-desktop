from __future__ import annotations
import pytest as _pytest

# Train A defers the Atum direct Claude/Kimi sidecar commands and their GatewayRunner routing to
# E5/E6 ( hermes_cli/commands.py row). Re-enable with that work.
_pytest.skip("Claude/Kimi sidecar routing is deferred to E5/E6 on Train A", allow_module_level=True)


import uuid
from types import SimpleNamespace

import pytest

from gateway.claude_sidecar import (
    CLAUDE_SIDECAR_TRANSCRIPT_MARKER,
    ClaudeModeStateStore,
    ClaudeSessionState,
    ClaudeSidecarConfig,
    ClaudeTurnLockRegistry,
)
from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import MessageEvent, MessageType
from gateway.run import GatewayRunner, _build_replay_entry
from gateway.session import SessionSource
from hermes_cli.commands import resolve_command


def test_claude_mode_commands_are_registered():
    for name in ("claude", "kimi", "codex", "opus", "sonnet", "fable", "exec"):
        assert resolve_command(name) is not None


def test_claude_sidecar_config_resolves_fable_alias(tmp_path):
    config = ClaudeSidecarConfig.from_gateway_config(
        {"conversation": {"fable_model": "claude-fable-test"}},
        hermes_home=tmp_path,
    )

    assert config.resolve_model("fable") == "claude-fable-test"
    assert config.resolve_model("claude-fable-5") == "claude-fable-5"


def test_should_route_to_claude_respects_force_codex_and_state(tmp_path):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(default_mode="claude")
    runner._claude_sidecar_config = lambda: config
    runner._claude_sidecar_state = ClaudeModeStateStore(tmp_path / "state.json")
    runner._claude_sidecar_state.set_mode("k", "claude", config)

    event = MessageEvent(
        text="hello",
        message_type=MessageType.TEXT,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
    )
    assert runner._should_route_to_claude_sidecar(event, "k") is True

    event.force_codex = True
    assert runner._should_route_to_claude_sidecar(event, "k") is False


def test_should_route_to_claude_respects_disabled_config(tmp_path):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(enabled=False, default_mode="claude")
    runner._claude_sidecar_config = lambda: config
    runner._claude_sidecar_state = ClaudeModeStateStore(tmp_path / "state.json")
    event = MessageEvent(
        text="/claude hi",
        message_type=MessageType.TEXT,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
    )

    event.force_claude = True
    assert runner._should_route_to_claude_sidecar(event, "k") is False


def test_exec_requires_explicit_slash_admin():
    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(
        platforms={
            Platform.TELEGRAM: PlatformConfig(
                enabled=True,
                token="***",
                extra={"allow_admin_from": ["111"]},
            )
        }
    )
    admin = SessionSource(
        platform=Platform.TELEGRAM,
        chat_id="1",
        chat_type="dm",
        user_id="111",
    )
    user = SessionSource(
        platform=Platform.TELEGRAM,
        chat_id="1",
        chat_type="dm",
        user_id="999",
    )

    assert runner._check_explicit_slash_admin(admin, "exec") is None
    assert "requires a configured" in runner._check_explicit_slash_admin(user, "exec")

    runner.config = GatewayConfig(
        platforms={
            Platform.TELEGRAM: PlatformConfig(
                enabled=True,
                token="***",
                extra={},
            )
        }
    )
    assert "requires a configured" in runner._check_explicit_slash_admin(admin, "exec")


@pytest.mark.asyncio
async def test_claude_model_command_with_prompt_falls_through(tmp_path):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(
        default_mode="codex",
        default_model="sonnet",
        opus_model="claude-opus-test",
    )
    runner._claude_sidecar_state = ClaudeModeStateStore(tmp_path / "state.json")
    runner._claude_sidecar_config = lambda: config
    runner.session_store = SimpleNamespace(
        get_or_create_session=lambda source: SimpleNamespace(session_key="session-key")
    )
    event = MessageEvent(
        text="/opus advise me",
        message_type=MessageType.TEXT,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
    )

    result = await runner._handle_claude_model_command(event, "opus")

    state = runner._claude_sidecar_state.get("session-key", config)
    assert result is None
    assert event.text == "advise me"
    assert event.force_claude is True
    assert state.mode == "claude"
    assert state.model == "opus"


@pytest.mark.asyncio
async def test_claude_model_command_without_prompt_returns_confirmation(tmp_path):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(
        default_mode="codex",
        sonnet_model="claude-sonnet-test",
    )
    runner._claude_sidecar_state = ClaudeModeStateStore(tmp_path / "state.json")
    runner._claude_sidecar_config = lambda: config
    runner.session_store = SimpleNamespace(
        get_or_create_session=lambda source: SimpleNamespace(session_key="session-key")
    )
    event = MessageEvent(
        text="/sonnet",
        message_type=MessageType.TEXT,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
    )

    result = await runner._handle_claude_model_command(event, "sonnet")

    assert result == "Claude conversation mode is on using `claude-sonnet-test`."
    assert not hasattr(event, "force_claude")


@pytest.mark.asyncio
async def test_claude_fable_model_command_uses_configured_alias(tmp_path):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(
        default_mode="codex",
        fable_model="claude-fable-test",
    )
    runner._claude_sidecar_state = ClaudeModeStateStore(tmp_path / "state.json")
    runner._claude_sidecar_config = lambda: config
    runner.session_store = SimpleNamespace(
        get_or_create_session=lambda source: SimpleNamespace(session_key="session-key")
    )
    event = MessageEvent(
        text="/fable",
        message_type=MessageType.TEXT,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
    )

    result = await runner._handle_claude_model_command(event, "fable")

    state = runner._claude_sidecar_state.get("session-key", config)
    assert result == "Claude conversation mode is on using `claude-fable-test`."
    assert state.mode == "claude"
    assert state.model == "fable"
    assert not hasattr(event, "force_claude")


@pytest.mark.asyncio
async def test_claude_command_denies_when_disabled(tmp_path):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(enabled=False)
    runner._claude_sidecar_state = ClaudeModeStateStore(tmp_path / "state.json")
    runner._claude_sidecar_config = lambda: config
    runner.session_store = SimpleNamespace(
        get_or_create_session=lambda source: SimpleNamespace(session_key="session-key")
    )
    event = MessageEvent(
        text="/claude say hello",
        message_type=MessageType.TEXT,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
    )

    result = await runner._handle_claude_command(event)

    assert result == "Claude conversation mode is disabled for this gateway profile."
    assert event.text == "/claude say hello"
    assert not hasattr(event, "force_claude")


@pytest.mark.asyncio
async def test_run_claude_sidecar_agent_returns_agent_result_shape(monkeypatch):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(default_model="opus", workdir="/tmp")
    state = ClaudeSessionState(
        mode="claude",
        model="opus",
        claude_session_id=str(uuid.uuid4()),
    )
    runner._claude_sidecar_state_for = lambda session_key: (config, state)
    runner._claude_turn_locks = ClaudeTurnLockRegistry()
    runner._claude_sidecar_state = object()

    async def fake_run_claude_conversation(**kwargs):
        assert kwargs["message"] == "hi"
        assert kwargs["context_prompt"] == "ctx"
        assert kwargs["shared_history"] == [{"role": "session_meta", "content": ""}]
        assert kwargs["session_key"] == "session-key"
        return "hello from claude"

    monkeypatch.setattr(
        "gateway.claude_sidecar.run_claude_conversation",
        fake_run_claude_conversation,
    )

    result = await runner._run_claude_sidecar_agent(
        message="hi",
        context_prompt="ctx",
        history=[{"role": "session_meta", "content": ""}],
        session_key="session-key",
        session_id="sid",
    )

    assert result["final_response"] == "hello from claude"
    assert result["history_offset"] == 1
    assert result["session_id"] == "sid"
    assert result["model"] == "claude:opus"
    assert result["messages"][-2:] == [
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": f"hello from claude\n\n{CLAUDE_SIDECAR_TRANSCRIPT_MARKER}",
        },
    ]


@pytest.mark.asyncio
async def test_run_kimi_sidecar_agent_returns_agent_result_shape(monkeypatch):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(kimi_model="kimi-code/k3", workdir="/tmp")
    state = ClaudeSessionState(
        mode="kimi",
        model="sonnet",
        claude_session_id=str(uuid.uuid4()),
        kimi_session_id="session_test",
        kimi_created=True,
    )
    runner._claude_sidecar_state_for = lambda session_key: (config, state)
    runner._kimi_turn_locks = ClaudeTurnLockRegistry()
    runner._claude_sidecar_state = object()

    async def fake_run_kimi_conversation(**kwargs):
        assert kwargs["message"] == "hi"
        assert kwargs["session_key"] == "session-key"
        return "hello from kimi"

    monkeypatch.setattr(
        "gateway.kimi_sidecar.run_kimi_conversation",
        fake_run_kimi_conversation,
    )

    result = await runner._run_kimi_sidecar_agent(
        message="hi",
        context_prompt="ctx",
        history=[],
        session_key="session-key",
        session_id="sid",
    )

    assert result["final_response"] == "hello from kimi"
    assert result["model"] == "kimi:kimi-code/k3"
    assert result["messages"][-1]["content"].endswith(
        "<!-- hermes:kimi-sidecar -->"
    )


def test_replay_entry_strips_claude_sidecar_marker():
    entry = _build_replay_entry(
        "assistant",
        f"visible answer\n\n{CLAUDE_SIDECAR_TRANSCRIPT_MARKER}",
        {},
    )

    assert entry == {"role": "assistant", "content": "visible answer"}


def test_replay_entry_strips_kimi_sidecar_marker():
    entry = _build_replay_entry(
        "assistant",
        "visible answer\n\n<!-- hermes:kimi-sidecar -->",
        {},
    )

    assert entry == {"role": "assistant", "content": "visible answer"}


@pytest.mark.asyncio
async def test_kimi_command_with_prompt_selects_kimi(tmp_path):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(default_mode="codex", kimi_model="kimi-code/k3")
    runner._claude_sidecar_state = ClaudeModeStateStore(tmp_path / "state.json")
    runner._claude_sidecar_config = lambda: config
    runner.session_store = SimpleNamespace(
        get_or_create_session=lambda source: SimpleNamespace(session_key="session-key")
    )
    event = MessageEvent(
        text="/kimi review this",
        message_type=MessageType.TEXT,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
    )

    result = await runner._handle_kimi_command(event)

    state = runner._claude_sidecar_state.get("session-key", config)
    assert result is None
    assert event.text == "review this"
    assert event.force_kimi is True
    assert state.mode == "kimi"


def test_should_route_to_kimi_respects_state_and_force_claude(tmp_path):
    runner = object.__new__(GatewayRunner)
    config = ClaudeSidecarConfig(default_mode="codex", kimi_enabled=True)
    runner._claude_sidecar_config = lambda: config
    runner._claude_sidecar_state = ClaudeModeStateStore(tmp_path / "state.json")
    runner._claude_sidecar_state.set_mode("k", "kimi", config)
    event = MessageEvent(
        text="hello",
        message_type=MessageType.TEXT,
        source=SessionSource(platform=Platform.TELEGRAM, chat_id="1", chat_type="dm"),
    )

    assert runner._should_route_to_kimi_sidecar(event, "k") is True
    event.force_claude = True
    assert runner._should_route_to_kimi_sidecar(event, "k") is False
