"""Detached work inherits an intentional lack of authority from its parent."""
from types import SimpleNamespace

from model_tools import get_tool_definitions
from tui_gateway import server


def test_background_inherits_zero_native_and_mcp_tools(monkeypatch):
    monkeypatch.setattr(server, '_load_cfg', dict)
    monkeypatch.setattr(server, '_load_enabled_toolsets', lambda *_args: ['file', 'memory', 'mcp-reader'])
    monkeypatch.setattr(server, '_load_disabled_toolsets', lambda: ['web'])
    parent = SimpleNamespace(model='synthetic', enabled_toolsets=[], disabled_toolsets=[], _fallback_chain=[])
    child = server._background_agent_kwargs(parent, 'synthetic-background')
    assert child['enabled_toolsets'] == parent.enabled_toolsets
    assert child['disabled_toolsets'] == parent.disabled_toolsets
    assert get_tool_definitions(enabled_toolsets=child['enabled_toolsets'], quiet_mode=True) == []
