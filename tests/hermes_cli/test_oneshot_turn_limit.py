"""``hermes -z`` (oneshot) builds its AIAgent from the profile config, including the turn cap.

It used to rely on AIAgent's library default (90) and ignore ``agent.max_turns`` entirely.
"""

import pytest

from hermes_cli.config import TURN_LIMIT_UNLIMITED


def _run_oneshot(monkeypatch, config=None) -> dict:
    """Run ``oneshot._run_agent`` with a recording AIAgent and return its constructor kwargs.

    ``config`` replaces ``load_config``; when it is ``None`` the real ``load_config`` reads the
    ``config.yaml`` in the (temporary) HERMES_HOME, so the whole config path is exercised.
    """
    from hermes_cli import oneshot

    built = {}

    class _FakeAgent:
        def __init__(self, **kwargs):
            built.update(kwargs)

        def run_conversation(self, prompt, **_kwargs):
            return {"final_response": "ok"}

        def shutdown_memory_provider(self, *args, **kwargs):
            pass

        def close(self):
            pass

    if config is not None:
        monkeypatch.setattr("hermes_cli.config.load_config", lambda: config)
    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        lambda **kwargs: {
            "provider": "openrouter",
            "api_mode": "chat_completions",
            "base_url": "https://example.invalid/v1",
            "api_key": "test-key",
        },
    )
    monkeypatch.setattr(oneshot, "_create_session_db_for_oneshot", lambda: None)
    monkeypatch.setattr("hermes_cli.tools_config._get_platform_tools", lambda cfg, platform: set())
    monkeypatch.setattr("run_agent.AIAgent", _FakeAgent)

    text, _result = oneshot._run_agent("hello", model="m")

    assert text == "ok"
    return built


@pytest.mark.parametrize(
    "agent_cfg, expected",
    [
        ({}, "unlimited"),
        ({"max_turns": None}, "unlimited"),
        ({"max_turns": "none"}, "unlimited"),
        ({"max_turns": 0}, "unlimited"),
        ({"max_turns": 25}, 25),
    ],
)
def test_oneshot_agent_cap_follows_agent_max_turns(monkeypatch, agent_cfg, expected):
    config = {"model": {"default": "m", "provider": "openrouter"}, "agent": agent_cfg}

    built = _run_oneshot(monkeypatch, config)

    want = TURN_LIMIT_UNLIMITED if expected == "unlimited" else expected
    assert built["max_iterations"] == want


@pytest.mark.parametrize(
    "config_yaml, expected",
    [
        # The legacy root-level key is folded into agent.max_turns by load_config(), so
        # hermes -z honors it without a reader of its own.
        ("max_turns: 45\n", 45),
        ("agent:\n  max_turns: null\nmax_turns: 45\n", 45),
        ("agent:\n  max_turns: 30\nmax_turns: 45\n", 30),
        ("max_turns: null\n", TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns: 25\n", 25),
    ],
)
def test_oneshot_reads_the_real_config_including_the_legacy_root_key(
    monkeypatch, config_yaml, expected
):
    import os
    from pathlib import Path

    (Path(os.environ["HERMES_HOME"]) / "config.yaml").write_text(config_yaml, encoding="utf-8")

    built = _run_oneshot(monkeypatch)

    assert built["max_iterations"] == expected
