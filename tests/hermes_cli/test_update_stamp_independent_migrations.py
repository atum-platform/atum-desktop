"""Every update entrypoint honors legacy-key migrations even at the current schema stamp."""
from pathlib import Path

import pytest

from hermes_cli import config, post_update, update_cmd_config
from hermes_cli.config_defaults import DEFAULT_CONFIG


@pytest.mark.parametrize("route", ["post-update", "active", "sibling"])
@pytest.mark.parametrize("stamp_offset", [0, 1], ids=["current", "ahead"])
def test_current_stamp_does_not_skip_retired_mcp_key(tmp_path, monkeypatch, route, stamp_offset):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    target = home / "profiles" / "work" if route == "sibling" else home
    target.mkdir(parents=True, exist_ok=True)
    path = target / "config.yaml"
    stamp = DEFAULT_CONFIG["_config_version"] + stamp_offset
    path.write_text(f"# User comment\n_config_version: {stamp}\n"
                    "model:\n  provider: custom\n  default: fake-model\n"
                    "mcp_servers:\n  retired:\n    command: /bin/true\n    disabled: true\n")
    (target / ".env").write_text("OPENAI_API_KEY=sk-fake\n")
    if route == "post-update":
        run = post_update.step_migrate_config
    elif route == "active":
        run = lambda: update_cmd_config._check_and_apply_config_migration(assume_yes=True)
    else:
        run = update_cmd_config._migrate_sibling_profile_configs
    run()
    after = path.read_bytes()
    assert config.yaml.safe_load(after)["mcp_servers"]["retired"] == {"command": "/bin/true", "enabled": False}
    assert config.yaml.safe_load(after)["_config_version"] == stamp
    assert b"# User comment" in after
    run()
    assert path.read_bytes() == after
