"""Ported from upstream PR #135048 ("fix(plugins): enabling a plugin from
Desktop/TUI/dashboard no longer strips the core tools").

Two contracts against our hermes_cli/plugins_cmd.py:

1. dashboard_set_agent_plugin_enabled on a config with NO saved
   platform_toolsets must not seed platform_toolsets.cli = [<plugin_ts>]:
   the seed replaced the "hermes-cli" composite, so the model lost every
   built-in tool (27 -> 2, no terminal). A plugin toolset is enabled by
   default via _get_platform_tools, so no saved list is needed.
2. dashboard_remove_user_plugin must drop the plugin's toolset from saved
   platform_toolsets lists even when plugin.yaml never declared provides_tools,
   otherwise hermes config check warns about an unknown toolset forever.
"""

import pytest
import yaml


def _write_plugin(root, name):
    """A minimal user plugin: <root>/<name>/ with plugin.yaml + no-op register."""
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "plugin.yaml").write_text(
        f"name: {name}\nversion: 1.0.0\ndescription: test plugin\n",
        encoding="utf-8",
    )
    (d / "__init__.py").write_text("def register(ctx): pass\n", encoding="utf-8")
    return d


def _write_tool_plugin(root, name):
    """User plugin registering one tool in its own toolset, WITHOUT
    ``provides_tools`` in plugin.yaml."""
    d = _write_plugin(root, name)
    (d / "__init__.py").write_text(
        "def register(ctx):\n"
        "    ctx.register_tool(name='" + name + "_tool', toolset='" + name + "_ts',\n"
        "                      handler=lambda args, **kw: '{}',\n"
        "                      schema={'name': '" + name + "_tool', 'description': 'probe',\n"
        "                              'parameters': {'type': 'object', 'properties': {}}})\n",
        encoding="utf-8",
    )
    return d


def _config(home):
    with open(home / "config.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


@pytest.fixture
def home(_isolate_hermes_home, tmp_path, monkeypatch):
    """Per-test HERMES_HOME. Keep the repo's bundled plugins out of the
    discovery sweep so only the user plugin under test loads (hermetic + fast):
    this fork's bundled plugin set is not upstream's."""
    hermes_home = tmp_path / "hermes-home"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setattr(
        "hermes_cli.plugins.get_bundled_plugins_dir",
        lambda: hermes_home / "no-bundled-plugins",
    )
    return hermes_home


def test_dashboard_enable_on_a_fresh_config_keeps_the_core_tools(home):
    """Desktop/TUI/dashboard enable with no saved ``platform_toolsets`` must not
    write one: the old seed ``platform_toolsets.cli: [<plugin_ts>]`` replaced the
    ``hermes-cli`` composite, so the model lost every built-in tool (27 -> 2, no
    ``terminal``). The plugin toolset is on by default anyway."""
    from hermes_cli.config import load_config
    from hermes_cli.plugins_cmd import dashboard_set_agent_plugin_enabled
    from hermes_cli.tools_config import _get_platform_tools
    from tools.registry import registry

    _write_tool_plugin(home / "plugins", "zzseed")
    try:
        assert dashboard_set_agent_plugin_enabled("zzseed", enabled=True)["ok"] is True
        cfg = load_config()
        assert not cfg.get("platform_toolsets")
        assert {"terminal", "file", "zzseed_ts"} <= _get_platform_tools(cfg, "cli")
    finally:
        registry.deregister("zzseed_tool")


def test_remove_clears_the_toolset_of_a_plugin_without_provides_tools(home):
    """``remove`` drops the plugin's toolset from a saved ``platform_toolsets``
    list even when plugin.yaml never declared ``provides_tools``; otherwise
    ``hermes config check`` warns about an unknown toolset forever."""
    from hermes_cli.plugins_cmd import dashboard_remove_user_plugin
    from tools.registry import registry

    _write_tool_plugin(home / "plugins", "zznodecl")
    (home / "config.yaml").write_text(yaml.safe_dump({
        "plugins": {"enabled": ["zznodecl"]},
        "platform_toolsets": {
            "cli": ["hermes-cli", "zznodecl_ts"],
            "telegram": ["hermes-telegram"],
        },
    }), encoding="utf-8")
    try:
        assert dashboard_remove_user_plugin("zznodecl")["ok"] is True
    finally:
        registry.deregister("zznodecl_tool")

    assert _config(home)["platform_toolsets"] == {
        "cli": ["hermes-cli"],
        "telegram": ["hermes-telegram"],
    }
