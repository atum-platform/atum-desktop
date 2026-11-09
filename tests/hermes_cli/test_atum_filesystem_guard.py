"""Classification for Atum's consent adapter: only interaction tools and
``write_file`` are mediated; everything else is plain Hermes."""

import pytest

from hermes_cli.atum_filesystem_guard import (
    GUARDED_TOOLS,
    capability_required,
    guard_unavailable_message,
    is_interaction_tool,
    requires_filesystem_guard,
)


@pytest.mark.parametrize("value,expected", [("1", True), ("on", True), ("TRUE", True), ("yes", True), ("0", False), ("", False)])
def test_capability_required_reads_the_desktop_marker(monkeypatch, value, expected):
    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", value)
    assert capability_required() is expected


@pytest.mark.parametrize(
    "tool",
    ["computer_use", "web_search", "web_extract", "browser_navigate", "browser_click", "browser_screenshot"],
)
def test_interaction_tools_are_mediated_as_one_class(tool):
    assert is_interaction_tool(tool)
    assert requires_filesystem_guard(tool)
    assert guard_unavailable_message(tool) == "CAPABILITY_DENIED: Atum capability guard unavailable"


def test_write_file_is_mediated_but_is_not_an_interaction_tool():
    assert not is_interaction_tool("write_file")
    assert requires_filesystem_guard("write_file", {"path": "a.md"})
    assert guard_unavailable_message("write_file") == "CAPABILITY_DENIED: Atum filesystem guard unavailable"


@pytest.mark.parametrize(
    "tool",
    [
        "terminal",
        "execute_code",
        "patch",
        "search_files",
        "skill_manage",
        "read_file",
        "open_preview",
        "vision_analyze",
        "mcp__filesystem__read_file",
        "todo",
        "browser",
    ],
)
def test_everything_else_runs_as_hermes_ships_it(tool):
    assert not is_interaction_tool(tool)
    assert not requires_filesystem_guard(tool, {"path": "/anything"})
    assert tool not in GUARDED_TOOLS
