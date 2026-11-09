"""The cap the interactive CLI hands the AIAgent it builds, for each way
``agent.max_turns`` can be written in config.yaml (or left out).

Runs the real path: config.yaml on disk -> ``cli.load_cli_config`` ->
``HermesCLI`` -> ``HermesCLI._init_agent`` -> the ``AIAgent`` constructor call.
Only the AIAgent class (a recorder) and credential resolution are faked.
"""

import os
from pathlib import Path

import pytest

from hermes_cli.config import TURN_LIMIT_UNLIMITED
from tests.hermes_cli.test_cli_provider_resolution import (
    _import_cli,
    _restore_cli_and_tool_modules,
)


def _build_agent_kwargs(
    monkeypatch,
    config_yaml: str | None,
    env_cap: str | None = None,
    **cli_kwargs,
) -> dict:
    """``env_cap`` plays the stale ``HERMES_MAX_ITERATIONS`` an old ``hermes setup`` left in .env."""
    home = Path(os.environ["HERMES_HOME"])
    if config_yaml is not None:
        (home / "config.yaml").write_text(config_yaml, encoding="utf-8")
    monkeypatch.delenv("HERMES_MAX_ITERATIONS", raising=False)
    if env_cap is not None:
        monkeypatch.setenv("HERMES_MAX_ITERATIONS", env_cap)

    cli = _import_cli()
    shell = cli.HermesCLI(model="gpt-5", compact=True, **cli_kwargs)
    # The classic CLI now sends this launch policy to the native gateway; the
    # local AIAgent constructor no longer exists on this surface.
    return {"max_iterations": shell.max_turns}


@pytest.mark.parametrize(
    "config_yaml, expected",
    [
        ("agent:\n  max_turns: null\n", TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns:\n", TURN_LIMIT_UNLIMITED),
        ("agent: {}\n", TURN_LIMIT_UNLIMITED),
        (None, TURN_LIMIT_UNLIMITED),
        ('agent:\n  max_turns: "unlimited"\n', TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns: 0\n", TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns: -1\n", TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns: 30\n", 30),
        ("agent:\n  max_turns: 90\n", 90),
        # legacy root-level key
        ("max_turns: 45\n", 45),
    ],
)
def test_agent_built_by_the_cli_gets_the_configured_cap(monkeypatch, config_yaml, expected):
    kwargs = _build_agent_kwargs(monkeypatch, config_yaml)

    assert kwargs["max_iterations"] == expected


def test_cli_flag_wins_over_config(monkeypatch):
    kwargs = _build_agent_kwargs(monkeypatch, "agent:\n  max_turns: 30\n", max_turns=7)

    assert kwargs["max_iterations"] == 7


@pytest.mark.parametrize("flag", [0, -1])
def test_cli_flag_zero_or_minus_one_means_unlimited(monkeypatch, flag):
    kwargs = _build_agent_kwargs(monkeypatch, "agent:\n  max_turns: 30\n", max_turns=flag)

    assert kwargs["max_iterations"] == TURN_LIMIT_UNLIMITED


def test_env_cap_applies_only_when_the_config_key_is_absent(monkeypatch):
    home = Path(os.environ["HERMES_HOME"])
    (home / "config.yaml").write_text("agent: {}\n", encoding="utf-8")
    cli = _import_cli()
    monkeypatch.setenv("HERMES_MAX_ITERATIONS", "42")
    assert cli.HermesCLI(model="gpt-5", compact=True).max_turns == 42

    (home / "config.yaml").write_text("agent:\n  max_turns: 30\n", encoding="utf-8")
    cli = _import_cli()
    assert cli.HermesCLI(model="gpt-5", compact=True).max_turns == 30


# An explicit null in config.yaml means "no cap" and is authoritative, exactly as in the gateway
# (which clears HERMES_MAX_ITERATIONS on a null). Only a key that is absent from config.yaml
# lets a stale HERMES_MAX_ITERATIONS from .env through.
@pytest.mark.parametrize(
    "config_yaml",
    [
        "agent:\n  max_turns: null\n",
        "agent:\n  max_turns:\n",
        "agent:\n  max_turns: ~\n",
        # legacy root-level key, written as null
        "max_turns: null\n",
        "max_turns:\n",
        # explicit null beside other agent settings
        "agent:\n  verbose: false\n  max_turns: null\n",
    ],
)
def test_explicit_null_means_unlimited_and_skips_the_env_fallback(monkeypatch, config_yaml):
    kwargs = _build_agent_kwargs(monkeypatch, config_yaml, env_cap="90")

    assert kwargs["max_iterations"] == TURN_LIMIT_UNLIMITED


@pytest.mark.parametrize(
    "config_yaml",
    [
        None,  # no config.yaml at all
        "agent: {}\n",
        "agent:\n  verbose: false\n",
        "model: gpt-5\n",
    ],
)
def test_absent_key_still_falls_back_to_the_env_cap(monkeypatch, config_yaml):
    kwargs = _build_agent_kwargs(monkeypatch, config_yaml, env_cap="90")

    assert kwargs["max_iterations"] == 90


@pytest.mark.parametrize(
    "config_yaml, expected",
    [
        ("agent:\n  max_turns: 30\n", 30),
        ('agent:\n  max_turns: "unlimited"\n', TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns: 0\n", TURN_LIMIT_UNLIMITED),
        # the legacy root-level key still fills in a null nested key, as everywhere else
        ("agent:\n  max_turns: null\nmax_turns: 45\n", 45),
        ("max_turns: 45\n", 45),
    ],
)
def test_an_explicit_value_wins_over_the_env_cap(monkeypatch, config_yaml, expected):
    kwargs = _build_agent_kwargs(monkeypatch, config_yaml, env_cap="90")

    assert kwargs["max_iterations"] == expected


def test_cli_flag_still_wins_over_an_explicit_null(monkeypatch):
    kwargs = _build_agent_kwargs(monkeypatch, "agent:\n  max_turns: null\n", env_cap="90", max_turns=7)

    assert kwargs["max_iterations"] == 7


def test_managed_scope_null_is_explicit_too(monkeypatch, tmp_path):
    """An administrator-pinned ``agent.max_turns: null`` is a declared key like any other."""
    from hermes_cli import managed_scope

    managed_dir = tmp_path / "managed"
    managed_dir.mkdir()
    (managed_dir / "config.yaml").write_text("agent:\n  max_turns: null\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()
    try:
        # The user's own file says 30; managed wins at the leaf and pins "no cap".
        kwargs = _build_agent_kwargs(monkeypatch, "agent:\n  max_turns: 30\n", env_cap="90")
    finally:
        managed_scope.invalidate_managed_cache()

    assert kwargs["max_iterations"] == TURN_LIMIT_UNLIMITED
