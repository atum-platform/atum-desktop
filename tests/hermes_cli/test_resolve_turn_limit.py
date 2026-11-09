"""Tests for :func:`hermes_cli.config.resolve_turn_limit` and the
``TURN_LIMIT_UNLIMITED`` sentinel.

Ported from upstream Hermes v0.22.2 (the cases that apply to this fork) and
extended with the readers this fork routes through the resolver: the gateway
config->env bridge, the TUI/desktop resolver, the CLI, the delegation cap and
the display helpers that keep the sentinel away from people.

Covers the full spelling table (int, float, numeric string, ``"none"``,
``"unlimited"``, ``"infinite"``, ``"-1"``, ``"0"``, YAML ``None``, bool,
garbage).
"""
import os
import sys

import pytest

from hermes_cli.config import (
    DEFAULT_CONFIG,
    TURN_LIMIT_UNLIMITED,
    declared_max_turns,
    format_turn_limit,
    format_turn_progress,
    is_turn_limit_unlimited,
    resolve_turn_limit,
    turn_limit_or_none,
)


@pytest.fixture(autouse=True)
def _restore_max_iterations_env():
    """The gateway bridge writes HERMES_MAX_ITERATIONS into the real process env."""
    before = os.environ.get("HERMES_MAX_ITERATIONS")
    yield
    if before is None:
        os.environ.pop("HERMES_MAX_ITERATIONS", None)
    else:
        os.environ["HERMES_MAX_ITERATIONS"] = before


class TestNumericValues:
    def test_int_passthrough(self):
        assert resolve_turn_limit(90) == 90
        assert resolve_turn_limit(120) == 120
        assert resolve_turn_limit(1) == 1

    def test_float_truncated(self):
        assert resolve_turn_limit(3.7) == 3
        assert resolve_turn_limit(3.0) == 3
        assert resolve_turn_limit(100.9) == 100

    def test_numeric_string(self):
        assert resolve_turn_limit("120") == 120
        assert resolve_turn_limit("3") == 3
        assert resolve_turn_limit("3.7") == 3  # float string -> int

    def test_negative_int_is_unlimited(self):
        assert resolve_turn_limit(-5) == TURN_LIMIT_UNLIMITED

    def test_value_beyond_the_sentinel_is_clamped_to_it(self):
        # The cap must survive the str->int round trip through HERMES_MAX_ITERATIONS.
        assert resolve_turn_limit(10**30) == TURN_LIMIT_UNLIMITED
        assert resolve_turn_limit(str(10**30)) == TURN_LIMIT_UNLIMITED


class TestUnlimitedSpellings:
    @pytest.mark.parametrize("spelling", [
        "none", "None", "NONE",
        "null",
        "unlimited",
        "infinite",
        "inf",
        "∞",
        "-1", "0",
    ])
    def test_string_spellings_resolve_to_sentinel(self, spelling):
        assert resolve_turn_limit(spelling) == TURN_LIMIT_UNLIMITED

    @pytest.mark.parametrize("spelling", [" none ", "  unlimited  ", "\tinfinite\t"])
    def test_whitespace_tolerant(self, spelling):
        assert resolve_turn_limit(spelling) == TURN_LIMIT_UNLIMITED

    def test_zero_int_is_unlimited(self):
        assert resolve_turn_limit(0) == TURN_LIMIT_UNLIMITED

    def test_zero_float_is_unlimited(self):
        assert resolve_turn_limit(0.0) == TURN_LIMIT_UNLIMITED

    def test_yaml_infinity_is_unlimited(self):
        # YAML ``.inf`` parses to float('inf'); int() of it raises OverflowError.
        assert resolve_turn_limit(float("inf")) == TURN_LIMIT_UNLIMITED


class TestAbsentAndDefault:
    def test_none_returns_default(self):
        # The default is unlimited: a cap caused more truncated tasks than it prevented.
        assert resolve_turn_limit(None) == TURN_LIMIT_UNLIMITED

    def test_none_custom_default(self):
        assert resolve_turn_limit(None, default=500) == 500

    def test_empty_string_returns_default(self):
        assert resolve_turn_limit("") == TURN_LIMIT_UNLIMITED
        assert resolve_turn_limit("", default=7) == 7

    def test_whitespace_only_returns_default(self):
        assert resolve_turn_limit("   ") == TURN_LIMIT_UNLIMITED


class TestInvalidInputs:
    def test_bool_rejected(self):
        # bool is an int subclass - must not silently become 1/0
        assert resolve_turn_limit(True) == TURN_LIMIT_UNLIMITED
        assert resolve_turn_limit(False) == TURN_LIMIT_UNLIMITED
        assert resolve_turn_limit(True, default=42) == 42

    def test_garbage_string_returns_default(self):
        assert resolve_turn_limit("garbage") == TURN_LIMIT_UNLIMITED
        assert resolve_turn_limit("not_a_number") == TURN_LIMIT_UNLIMITED
        assert resolve_turn_limit("garbage", default=33) == 33

    def test_nan_returns_default(self):
        assert resolve_turn_limit(float("nan"), default=33) == 33
        assert resolve_turn_limit("nan", default=33) == 33

    def test_list_returns_default(self):
        assert resolve_turn_limit([]) == TURN_LIMIT_UNLIMITED
        assert resolve_turn_limit([90]) == TURN_LIMIT_UNLIMITED

    def test_dict_returns_default(self):
        assert resolve_turn_limit({}) == TURN_LIMIT_UNLIMITED
        assert resolve_turn_limit({"max_turns": 90}) == TURN_LIMIT_UNLIMITED


class TestSentinelHelpers:
    """The sentinel is sys.maxsize; people must never see it, and JSON must never carry it."""

    def test_sentinel_is_a_python_int_ceiling(self):
        assert TURN_LIMIT_UNLIMITED == sys.maxsize

    def test_is_turn_limit_unlimited(self):
        assert is_turn_limit_unlimited(TURN_LIMIT_UNLIMITED)
        assert not is_turn_limit_unlimited(90)
        assert not is_turn_limit_unlimited(None)
        assert not is_turn_limit_unlimited("garbage")

    def test_format_turn_limit(self):
        assert format_turn_limit(TURN_LIMIT_UNLIMITED) == "unlimited"
        assert format_turn_limit(90) == "90"

    def test_format_turn_progress_never_shows_the_sentinel(self):
        assert format_turn_progress(12, 90) == "12/90"
        assert format_turn_progress(12, TURN_LIMIT_UNLIMITED) == "12"
        assert str(sys.maxsize) not in format_turn_progress(12, TURN_LIMIT_UNLIMITED)

    def test_turn_limit_or_none_for_json(self):
        assert turn_limit_or_none(TURN_LIMIT_UNLIMITED) is None
        assert turn_limit_or_none(None) is None
        assert turn_limit_or_none(90) == 90


class TestDeclaredMaxTurns:
    """``declared_max_turns`` separates "no cap, on purpose" (the key is there, empty) from
    "never configured" (the key is absent) -- the merged config cannot, because the schema
    default is also null."""

    @pytest.mark.parametrize(
        "raw",
        [
            {},
            {"agent": {}},
            {"agent": None},
            {"agent": {"verbose": False}},
            {"model": "m"},
            None,
            [],
            "agent: {}",
        ],
    )
    def test_absent_key_is_not_declared(self, raw):
        assert declared_max_turns(raw) == (False, None)

    @pytest.mark.parametrize(
        "raw",
        [
            {"agent": {"max_turns": None}},
            {"max_turns": None},
            {"agent": {"max_turns": None}, "max_turns": None},
        ],
    )
    def test_explicit_null_is_declared_with_no_value(self, raw):
        assert declared_max_turns(raw) == (True, None)

    def test_values_are_returned_as_written(self):
        assert declared_max_turns({"agent": {"max_turns": 30}}) == (True, 30)
        assert declared_max_turns({"agent": {"max_turns": "unlimited"}}) == (True, "unlimited")
        assert declared_max_turns({"agent": {"max_turns": 0}}) == (True, 0)

    def test_legacy_root_key_fills_in_for_a_missing_or_null_nested_key(self):
        # Same precedence as load_config(): a non-null agent.max_turns wins, then the root key.
        assert declared_max_turns({"max_turns": 45}) == (True, 45)
        assert declared_max_turns({"agent": {"max_turns": None}, "max_turns": 45}) == (True, 45)
        assert declared_max_turns({"agent": {"max_turns": 30}, "max_turns": 45}) == (True, 30)

    def test_agrees_with_load_config_on_the_value(self, monkeypatch, tmp_path):
        from hermes_cli.config import load_config

        home = tmp_path / "hh"
        home.mkdir()
        monkeypatch.setenv("HERMES_HOME", str(home))
        for yaml_text, raw in [
            ("max_turns: 45\n", {"max_turns": 45}),
            ("agent:\n  max_turns: null\nmax_turns: 45\n", {"agent": {"max_turns": None}, "max_turns": 45}),
            ("agent:\n  max_turns: 30\nmax_turns: 45\n", {"agent": {"max_turns": 30}, "max_turns": 45}),
        ]:
            (home / "config.yaml").write_text(yaml_text, encoding="utf-8")
            assert load_config()["agent"]["max_turns"] == declared_max_turns(raw)[1]


class TestSchemaDefaults:
    """Contracts between the schema defaults and the code that falls back to them."""

    def test_agent_max_turns_defaults_to_unlimited(self):
        # null in the schema; every reader resolves it to the sentinel, never to a cap.
        assert resolve_turn_limit(DEFAULT_CONFIG["agent"]["max_turns"]) == TURN_LIMIT_UNLIMITED

    def test_delegate_fallbacks_match_the_schema(self):
        # tools/delegate_tool.py keeps module fallbacks for configs that never merged the
        # schema (raw reads, tests, early startup); they must not drift from DEFAULT_CONFIG.
        from tools import delegate_tool

        deleg = DEFAULT_CONFIG["delegation"]
        assert delegate_tool.DEFAULT_MAX_ITERATIONS == deleg["max_iterations"]
        assert delegate_tool._DEFAULT_MAX_CONCURRENT_CHILDREN == deleg["max_concurrent_children"]

    def test_cli_defaults_match_the_schema(self):
        # cli.py builds its own default dict; it drifted from the schema once (45 vs 50).
        import cli

        assert cli.CLI_CONFIG["agent"]["max_turns"] == DEFAULT_CONFIG["agent"]["max_turns"]
        assert (
            cli.CLI_CONFIG["delegation"]["max_iterations"]
            == DEFAULT_CONFIG["delegation"]["max_iterations"]
        )

    def test_web_editor_offers_a_number_field(self):
        # A null default would otherwise be inferred as a free-text field.
        from hermes_cli.web_server import CONFIG_SCHEMA

        assert CONFIG_SCHEMA["agent.max_turns"]["type"] == "number"


class TestGatewayBridgeNullHandling:
    """Verify that _bridge_max_turns_from_config does NOT serialize Python None
    (from YAML ``null`` or bare ``key:``) into the env var as the string
    "None", and that it clears a stale cap instead of leaving it in place."""

    def test_none_value_not_bridged(self, monkeypatch, tmp_path):
        """YAML ``max_turns: null`` should not set HERMES_MAX_ITERATIONS."""
        cfg_file = tmp_path / "config.yaml"
        cfg_file.write_text("agent:\n  max_turns: null\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_MAX_ITERATIONS", "stale-120")
        # Import here to avoid module-level gateway dependency
        from gateway.run import _bridge_max_turns_from_config
        _bridge_max_turns_from_config(tmp_path)
        # The stale env var should be cleared so downstream resolver
        # applies the default rather than using the stale value.
        assert "HERMES_MAX_ITERATIONS" not in os.environ

    def test_string_none_bridged_correctly(self, monkeypatch, tmp_path):
        """YAML ``max_turns: "none"`` should bridge as the string "none"."""
        cfg_file = tmp_path / "config.yaml"
        cfg_file.write_text('agent:\n  max_turns: "none"\n', encoding="utf-8")
        monkeypatch.delenv("HERMES_MAX_ITERATIONS", raising=False)
        from gateway.run import _bridge_max_turns_from_config
        _bridge_max_turns_from_config(tmp_path)
        assert os.environ.get("HERMES_MAX_ITERATIONS") == "none"

    def test_int_bridged_correctly(self, monkeypatch, tmp_path):
        """YAML ``max_turns: 120`` should bridge as "120"."""
        cfg_file = tmp_path / "config.yaml"
        cfg_file.write_text("agent:\n  max_turns: 120\n", encoding="utf-8")
        monkeypatch.delenv("HERMES_MAX_ITERATIONS", raising=False)
        from gateway.run import _bridge_max_turns_from_config
        _bridge_max_turns_from_config(tmp_path)
        assert os.environ.get("HERMES_MAX_ITERATIONS") == "120"

    def test_bare_key_treated_as_null(self, monkeypatch, tmp_path):
        """YAML ``max_turns:`` (bare key, no value) parses as Python None."""
        cfg_file = tmp_path / "config.yaml"
        cfg_file.write_text("agent:\n  max_turns:\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_MAX_ITERATIONS", "stale-90")
        from gateway.run import _bridge_max_turns_from_config
        _bridge_max_turns_from_config(tmp_path)
        assert "HERMES_MAX_ITERATIONS" not in os.environ

    def test_absent_key_leaves_the_environment_alone(self, monkeypatch, tmp_path):
        """No agent.max_turns in config.yaml: an env cap (e.g. from .env) is not touched."""
        (tmp_path / "config.yaml").write_text("agent: {}\n", encoding="utf-8")
        monkeypatch.setenv("HERMES_MAX_ITERATIONS", "45")
        from gateway.run import _bridge_max_turns_from_config
        _bridge_max_turns_from_config(tmp_path)
        assert os.environ["HERMES_MAX_ITERATIONS"] == "45"


class TestGatewayCurrentMaxIterations:
    """What the gateway hands AIAgent for each way agent.max_turns can be written."""

    @pytest.fixture
    def gateway_home(self, tmp_path, monkeypatch):
        from gateway import run as gateway_run

        home = tmp_path / ".hermes"
        home.mkdir()
        monkeypatch.setattr(gateway_run, "_hermes_home", home)
        monkeypatch.delenv("HERMES_MAX_ITERATIONS", raising=False)
        return home

    @pytest.mark.parametrize("yaml_text, expected", [
        ("agent:\n  max_turns: null\n", TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns:\n", TURN_LIMIT_UNLIMITED),
        ("agent: {}\n", TURN_LIMIT_UNLIMITED),
        ("{}\n", TURN_LIMIT_UNLIMITED),
        ('agent:\n  max_turns: "unlimited"\n', TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns: 0\n", TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns: -1\n", TURN_LIMIT_UNLIMITED),
        ("agent:\n  max_turns: 30\n", 30),
        ("agent:\n  max_turns: 90\n", 90),
    ])
    def test_config_value_reaches_the_cap(self, gateway_home, yaml_text, expected):
        from gateway import run as gateway_run

        (gateway_home / "config.yaml").write_text(yaml_text, encoding="utf-8")
        assert gateway_run._current_max_iterations() == expected

    def test_null_in_config_overrides_a_stale_env_cap(self, gateway_home):
        from gateway import run as gateway_run

        (gateway_home / "config.yaml").write_text("agent:\n  max_turns: null\n", encoding="utf-8")
        (gateway_home / ".env").write_text("HERMES_MAX_ITERATIONS=60\n", encoding="utf-8")
        assert gateway_run._current_max_iterations() == TURN_LIMIT_UNLIMITED

    def test_unreadable_env_value_is_not_a_crash(self, gateway_home, monkeypatch):
        from gateway import run as gateway_run

        monkeypatch.setenv("HERMES_MAX_ITERATIONS", "not-a-number")
        assert gateway_run._current_max_iterations() == TURN_LIMIT_UNLIMITED


class TestTUIResolver:
    """Verify that _cfg_max_turns in tui_gateway/server.py routes through
    resolve_turn_limit instead of bare int()."""

    def test_string_none_resolves_to_unlimited(self):
        from tui_gateway.server import _cfg_max_turns
        cfg = {"agent": {"max_turns": "none"}}
        assert _cfg_max_turns(cfg, default=25) == TURN_LIMIT_UNLIMITED

    def test_yaml_null_resolves_to_the_default(self):
        from tui_gateway.server import _cfg_max_turns
        cfg = {"agent": {"max_turns": None}}
        assert _cfg_max_turns(cfg, default=25) == 25
        assert _cfg_max_turns(cfg) == TURN_LIMIT_UNLIMITED

    def test_int_passthrough(self):
        from tui_gateway.server import _cfg_max_turns
        cfg = {"agent": {"max_turns": 50}}
        assert _cfg_max_turns(cfg, default=25) == 50

    def test_none_falls_through_to_default(self):
        from tui_gateway.server import _cfg_max_turns
        cfg = {"agent": {}}
        assert _cfg_max_turns(cfg, default=25) == 25

    def test_unset_everywhere_is_unlimited_without_an_explicit_default(self):
        from tui_gateway.server import _cfg_max_turns
        assert _cfg_max_turns({}) == TURN_LIMIT_UNLIMITED

    def test_env_var_override(self, monkeypatch):
        from tui_gateway.server import _cfg_max_turns
        monkeypatch.setenv("HERMES_TUI_MAX_TURNS", "none")
        cfg = {"agent": {"max_turns": 50}}
        assert _cfg_max_turns(cfg, default=25) == TURN_LIMIT_UNLIMITED

    def test_env_var_zero_is_unlimited(self, monkeypatch):
        """Old code swallowed 0 via `int(0) > 0` -> False. Now it routes
        through resolve_turn_limit which treats 0 as unlimited."""
        from tui_gateway.server import _cfg_max_turns
        monkeypatch.setenv("HERMES_TUI_MAX_TURNS", "0")
        cfg = {"agent": {"max_turns": 50}}
        assert _cfg_max_turns(cfg, default=25) == TURN_LIMIT_UNLIMITED

    def test_env_var_positive_wins_over_config(self, monkeypatch):
        from tui_gateway.server import _cfg_max_turns
        monkeypatch.setenv("HERMES_TUI_MAX_TURNS", "12")
        assert _cfg_max_turns({"agent": {"max_turns": 50}}, default=25) == 12

    def test_unreadable_env_var_falls_through_to_config(self, monkeypatch):
        from tui_gateway.server import _cfg_max_turns
        monkeypatch.setenv("HERMES_TUI_MAX_TURNS", "lots")
        assert _cfg_max_turns({"agent": {"max_turns": 50}}, default=25) == 50

    def test_root_level_max_turns(self):
        """Legacy root-level max_turns still works."""
        from tui_gateway.server import _cfg_max_turns
        cfg = {"max_turns": "none"}
        assert _cfg_max_turns(cfg, default=25) == TURN_LIMIT_UNLIMITED


class TestConfigShow:
    """`hermes config` prints the cap in words, never as 2**63-1, and compares by value."""

    @pytest.fixture
    def home(self, tmp_path, monkeypatch):
        import hermes_cli.config as cfg

        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        cfg._LOAD_CONFIG_CACHE.clear()
        cfg._RAW_CONFIG_CACHE.clear()
        return tmp_path

    def test_unset_cap_is_shown_as_unlimited(self, home, capsys):
        from hermes_cli.config import show_config

        show_config()
        out = capsys.readouterr().out
        assert "Max turns:    unlimited" in out
        assert str(sys.maxsize) not in out

    def test_configured_cap_is_shown_as_a_number(self, home, capsys):
        from hermes_cli.config import show_config

        (home / "config.yaml").write_text("agent:\n  max_turns: 30\n", encoding="utf-8")
        show_config()
        assert "Max turns:    30" in capsys.readouterr().out

    def test_env_ghost_that_resolves_differently_is_flagged(self, home, capsys):
        from hermes_cli.config import show_config

        (home / ".env").write_text("HERMES_MAX_ITERATIONS=90\n", encoding="utf-8")
        show_config()
        assert "stale HERMES_MAX_ITERATIONS=90" in capsys.readouterr().out

    def test_env_ghost_that_resolves_the_same_is_not_flagged(self, home, capsys):
        from hermes_cli.config import show_config

        (home / ".env").write_text("HERMES_MAX_ITERATIONS=none\n", encoding="utf-8")
        show_config()
        assert "stale HERMES_MAX_ITERATIONS" not in capsys.readouterr().out
