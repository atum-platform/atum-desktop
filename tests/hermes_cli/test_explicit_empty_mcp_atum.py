"""An empty saved allowlist must not be widened by MCP/plugin defaults."""
from hermes_cli.tools_config import _get_platform_tools


def test_explicit_empty_cli_excludes_default_mcp(monkeypatch):
    monkeypatch.setattr('hermes_cli.tools_config._get_plugin_toolset_keys', lambda: {'atum-device'})
    cfg = {'platform_toolsets': {'cli': []}, 'mcp_servers': {'reader': {'command': 'reader'}},
           'plugins': {'enabled': ['atum-device']}}
    assert _get_platform_tools(cfg, 'cli', include_default_mcp_servers=True) == set()
