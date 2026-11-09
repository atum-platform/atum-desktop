"""Who can rename an assistant in conversation, and that doing it moves nothing else.

The person says what to call the assistant and the assistant renames itself through the
existing ``atum_agents`` tool (read, then one revision-fenced update). No second tool exists for
it, so these tests pin the surface that tool already has and the two places it must not reach:

- it exists only where the Atum host bridge is wired (a live desktop/Matrix turn), never in a
  plain Hermes, so the CLI, the dashboard and every other platform never carry its schema;
- a group chat (a shared room) and a reply-only meeting turn never get it;
- the tool list is fixed when the agent is built: a rename changes nothing about it, so the
  conversation's cached prompt prefix is never touched.
"""

import json
from unittest.mock import MagicMock

import pytest

from tools import desktop_ui

TOOL = "atum_agents"
OTHER_HOST_TOOLS = {"atum_store", "atum_apps", "atum_agent_tasks", "atum_chats", "atum_mac"}


@pytest.fixture()
def bridge(monkeypatch):
    """The host bridge wired, as ``_wire_desktop_ui`` does before the first agent is built."""
    import model_tools
    from tools.registry import invalidate_check_fn_cache
    from tui_gateway import server
    from tui_gateway.desktop_ui_bridge import _desktop_ui_request

    monkeypatch.setattr(desktop_ui, "_emit", None)
    monkeypatch.setattr(desktop_ui, "_request", None)

    def wire(on):
        monkeypatch.setattr(desktop_ui, "_request", _desktop_ui_request if on else None)
        invalidate_check_fn_cache()
        model_tools._clear_tool_defs_cache()

    wire(False)
    yield wire
    invalidate_check_fn_cache()
    model_tools._clear_tool_defs_cache()


def _definitions(**kwargs):
    import model_tools

    return model_tools.get_tool_definitions(quiet_mode=True, skip_tool_search_assembly=True, **kwargs)


def _names(**kwargs):
    return {tool["function"]["name"] for tool in _definitions(**kwargs)}


def test_the_tool_exists_only_where_the_host_bridge_is_wired(bridge):
    bridge(False)
    assert TOOL not in _names(enabled_toolsets=[TOOL])
    assert TOOL not in _names()

    bridge(True)
    assert _names(enabled_toolsets=[TOOL]) == {TOOL}


def test_a_group_chat_never_gets_the_assistants_own_profile(bridge):
    from tui_gateway.server import SHARED_ROOM_DISABLED_TOOLSETS

    bridge(True)
    private = _names()
    shared = _names(disabled_toolsets=list(SHARED_ROOM_DISABLED_TOOLSETS))

    assert TOOL in private
    assert TOOL not in shared
    # Only the owner's own private tools leave: the rest of the host's bridge tools are unchanged by this.
    assert (OTHER_HOST_TOOLS - {"atum_chats", "atum_mac"}) & private <= shared


@pytest.mark.parametrize("flags,expected", [
    ({}, "toolsets"),
    ({"shared_room": True}, "toolsets"),
    ({"reply_only": True}, "none"),
])
def test_what_each_kind_of_matrix_session_is_built_with(bridge, monkeypatch, flags, expected):
    """The real ``_make_agent``: the toolsets it hands the agent are decided once, by the kind of chat."""
    import run_agent
    from tui_gateway import server

    bridge(True)
    captured = {}
    monkeypatch.setattr(run_agent, "AIAgent", lambda **kwargs: captured.update(kwargs) or MagicMock())
    monkeypatch.setattr(server, "_load_cfg", lambda: {"agent": {}})
    monkeypatch.setattr(server, "_get_db", lambda: None)
    monkeypatch.setattr(server, "_load_reasoning_config", lambda model: None)
    monkeypatch.setattr(server, "_load_service_tier", lambda: None)
    monkeypatch.setattr("agent.coding_context.coding_selection", lambda **kwargs: None)
    monkeypatch.setattr("hermes_cli.config.load_config", dict)
    monkeypatch.setattr("hermes_cli.tools_config._get_platform_tools", lambda *args, **kwargs: {"terminal"})
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.delenv("HERMES_TUI_TOOLSETS", raising=False)
    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider", lambda **kwargs: {
        "provider": "openrouter", "api_key": "test", "base_url": "https://example.invalid/v1",
        "api_mode": "chat_completions",
    })

    server._make_agent("sid", "key", platform_override="matrix", **flags)

    if expected == "none":
        # A reply-only (meeting) turn is built with no tools at all.
        assert captured["enabled_toolsets"] == []
    else:
        assert TOOL in captured["enabled_toolsets"]
        restricted = set(captured.get("disabled_toolsets") or [])
        assert (TOOL in restricted) is bool(flags.get("shared_room"))


def test_a_rename_changes_nothing_about_the_tool_list(bridge, monkeypatch):
    """The cached prompt prefix starts with the tools: a rename must leave them byte for byte."""
    bridge(True)
    before = json.dumps(_definitions(), sort_keys=True)

    profile = {"originPrincipal": "00000000-0000-4000-8000-11e594f48195", "originIsMain": True,
               "profile": {"principal": "00000000-0000-4000-8000-11e594f48195", "displayName": "Bông",
                           "isMain": True, "definitionRevision": 8, "identityRevision": 4, "avatarUrl": None,
                           "soul": ""}}
    monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: json.dumps(profile))
    from tools.atum_agents_tool import atum_agents

    renamed = json.loads(atum_agents("update", expected_definition_revision=7, expected_identity_revision=3,
                                     display_name="Bông"))
    assert renamed["profile"]["displayName"] == "Bông"

    assert json.dumps(_definitions(), sort_keys=True) == before
    # And the schema itself is the one the model has always had: no rename-only operation or field.
    from tools.atum_agents_tool import ATUM_AGENTS_SCHEMA

    assert ATUM_AGENTS_SCHEMA["parameters"]["properties"]["operation"]["enum"] == ["list", "read", "update", "avatar"]
