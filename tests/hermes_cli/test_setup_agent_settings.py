"""Tests for agent-settings copy in the interactive setup wizard."""

from hermes_cli.setup import setup_agent_settings




def test_setup_agent_settings_prefers_config_over_stale_env(tmp_path, monkeypatch, capsys):
    """Config.yaml wins even when a stale .env value disagrees.

    Regression guard for the bug where `.env HERMES_MAX_ITERATIONS=60`
    from an old `hermes setup` run shadowed `agent.max_turns: 500` in
    config.yaml. The wizard must now display the config value.
    """
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    config = {
        "agent": {"max_turns": 500},  # user bumped this in config.yaml
        "display": {"tool_progress": "all"},
        "compression": {"threshold": 0.50},
    }

    prompt_answers = iter(["500", "all", "0.5"])

    # Simulate stale .env value — the wizard must ignore this.
    monkeypatch.setattr(
        "hermes_cli.setup.get_env_value",
        lambda key: "60" if key == "HERMES_MAX_ITERATIONS" else "",
    )
    monkeypatch.setattr("hermes_cli.setup.prompt", lambda *args, **kwargs: next(prompt_answers))
    monkeypatch.setattr("hermes_cli.setup.prompt_choice", lambda *args, **kwargs: 4)
    monkeypatch.setattr("hermes_cli.setup.save_env_value", lambda *args, **kwargs: None)

    removed_keys: list[str] = []
    monkeypatch.setattr(
        "hermes_cli.setup.remove_env_value",
        lambda key: (removed_keys.append(key), True)[1],
    )
    monkeypatch.setattr("hermes_cli.setup.save_config", lambda *args, **kwargs: None)

    setup_agent_settings(config)

    out = capsys.readouterr().out
    # Config value wins
    assert "Press Enter to keep 500." in out
    assert "Press Enter to keep 60." not in out
    # And the stale .env entry gets cleaned up
    assert "HERMES_MAX_ITERATIONS" in removed_keys


def _run_wizard(monkeypatch, config, answers):
    prompt_answers = iter(answers)
    monkeypatch.setattr("hermes_cli.setup.prompt", lambda *args, **kwargs: next(prompt_answers))
    monkeypatch.setattr("hermes_cli.setup.prompt_choice", lambda *args, **kwargs: 4)
    monkeypatch.setattr("hermes_cli.setup.save_env_value", lambda *args, **kwargs: None)
    monkeypatch.setattr("hermes_cli.setup.remove_env_value", lambda *args, **kwargs: None)
    monkeypatch.setattr("hermes_cli.setup.save_config", lambda *args, **kwargs: None)
    setup_agent_settings(config)


def _wizard_config(**agent):
    return {
        "agent": dict(agent),
        "display": {"tool_progress": "all"},
        "compression": {"threshold": 0.50},
        "session_reset": {"mode": "both", "idle_minutes": 1440, "at_hour": 4},
    }


def test_setup_agent_settings_shows_unlimited_when_no_cap_is_set(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    config = _wizard_config()

    _run_wizard(monkeypatch, config, ["unlimited", "all", "0.5"])

    out = capsys.readouterr().out
    assert "Press Enter to keep unlimited." in out
    assert "9223372036854775807" not in out
    assert config["agent"]["max_turns"] is None


def test_setup_agent_settings_accepts_a_new_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    config = _wizard_config(max_turns=60)

    _run_wizard(monkeypatch, config, ["45", "all", "0.5"])

    assert config["agent"]["max_turns"] == 45


def test_setup_agent_settings_can_remove_a_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    config = _wizard_config(max_turns=60)

    _run_wizard(monkeypatch, config, ["0", "all", "0.5"])

    assert config["agent"]["max_turns"] is None


def test_setup_agent_settings_keeps_the_cap_on_unreadable_input(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    config = _wizard_config(max_turns=60)

    _run_wizard(monkeypatch, config, ["lots", "all", "0.5"])

    assert config["agent"]["max_turns"] == 60
    assert "Invalid number, keeping current value" in capsys.readouterr().out


def test_recommended_defaults_do_not_pin_a_turn_cap(tmp_path, monkeypatch):
    from hermes_cli.setup import _apply_default_agent_settings

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr("hermes_cli.setup.remove_env_value", lambda *args, **kwargs: None)
    monkeypatch.setattr("hermes_cli.setup.save_config", lambda *args, **kwargs: None)
    config = _wizard_config(max_turns=60)

    _apply_default_agent_settings(config)

    assert config["agent"]["max_turns"] is None
