"""The atum-company plugin bootstrap (COS-FULL-POWER C1a): dark until a domain is accepted.

The plugin registers only the domain modules named in ``ACCEPTED_MODULES`` (the Python half of the
controller's accepted-adapters table), in order, one tool each, never overriding a native tool.
It ships with an empty tuple, so loading it must change nothing about the tool surface.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

PLUGIN_DIR = Path(__file__).parents[2] / "plugins" / "atum-company"
SPEC = importlib.util.spec_from_file_location("atum_company_under_test", PLUGIN_DIR / "__init__.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Ctx:
    def __init__(self):
        self.tools = []

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)


def _domain(tool: str, toolset: str = "atum_company") -> ModuleType:
    module = ModuleType(f"fake_{tool}")
    module.TOOL_NAME = tool
    module.TOOLSET = toolset
    module.SCHEMA = {"name": tool, "description": "d", "parameters": {"type": "object", "properties": {}}}
    module.handle = lambda arguments, **kw: "{}"
    return module


def _loader(modules):
    return lambda name: modules[name]


def test_ships_dark_and_registers_nothing():
    assert tuple(MODULE.ACCEPTED_MODULES) == ()
    ctx = Ctx()
    MODULE.register(ctx)
    assert ctx.tools == []


def test_manifest_is_an_opt_in_standalone_plugin():
    text = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
    assert "name: atum-company" in text
    assert "kind: standalone" in text


def test_registers_accepted_modules_in_order_without_overriding_native_tools(monkeypatch):
    modules = {"board": _domain("company_board"), "files": _domain("company_files")}
    assert list(MODULE.accepted_modules(("board", "files"), loader=_loader(modules))) == ["board", "files"]

    monkeypatch.setattr(MODULE, "ACCEPTED_MODULES", ("board", "files"))
    monkeypatch.setattr(MODULE, "_load", lambda name, root: modules[name])
    ctx = Ctx()
    MODULE.register(ctx)
    assert [tool["name"] for tool in ctx.tools] == ["company_board", "company_files"]
    for tool in ctx.tools:
        assert tool["override"] is False
        assert tool["check_fn"]() is True
        assert callable(tool["handler"])


@pytest.mark.parametrize("names, modules, message", [
    (("nope",), {}, "unknown module"),
    (("board", "board"), {"board": _domain("company_board")}, "duplicate module"),
    (("board", "files"), {"board": _domain("same"), "files": _domain("same")}, "duplicate tool"),
])
def test_refuses_unknown_duplicate_and_colliding_modules(names, modules, message):
    with pytest.raises(ValueError, match=message):
        MODULE.accepted_modules(names, loader=_loader(modules))


def test_refuses_a_module_that_does_not_export_the_contract():
    incomplete = ModuleType("fake_incomplete")
    incomplete.TOOL_NAME = "company_board"
    with pytest.raises(ValueError, match="lacks"):
        MODULE.accepted_modules(("board",), loader=_loader({"board": incomplete}))


def test_an_unaccepted_domain_is_never_imported():
    imported = []

    def loader(name):
        imported.append(name)
        return _domain("company_board")

    MODULE.accepted_modules(("board",), loader=loader)
    assert imported == ["board"]  # files/brain/people stay pending: not imported, cannot block
