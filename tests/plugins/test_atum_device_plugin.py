"""The atum-device plugin (S1 build plan §3.4): the cloud assistant's reach into the owner's Macs.

Every wrapped schema is exactly the original plus the optional ``device`` property; the tool list
is fixed (so a conversation's cached prompt prefix holds); calls route through the controller's
answer; Hermes's own command floor still applies to commands bound for a Mac; and the plugin
loads only when the cloud configuration enables it.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

PLUGIN = Path(__file__).parents[2] / "plugins" / "atum-device" / "__init__.py"
SPEC = importlib.util.spec_from_file_location("atum_device_under_test", PLUGIN)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def _originals():
    import model_tools
    from tools.registry import registry

    return {name: registry.get_entry(name) for name in MODULE.DEVICE_TOOLS}


class Ctx:
    """Collects what the plugin registers, without touching the global registry."""

    def __init__(self):
        self.tools = {}

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs


def _registered():
    ctx = Ctx()
    MODULE.register(ctx)
    return ctx.tools


def test_each_schema_is_the_original_plus_device_and_nothing_else():
    originals = _originals()
    tools = _registered()
    assert set(tools) == set(MODULE.DEVICE_TOOLS) | {"device_send_file"}
    for name in MODULE.DEVICE_TOOLS:
        wrapped = copy.deepcopy(tools[name]["schema"])
        properties = wrapped["parameters"]["properties"]
        assert properties.pop("device") == MODULE.DEVICE_PROPERTY
        if name == "terminal":
            assert properties.pop("needs") == MODULE.NEEDS_PROPERTY
        assert wrapped == originals[name].schema
        # Never required: omitting it means "the device this message came from".
        assert "device" not in tools[name]["schema"]["parameters"].get("required", [])
        assert tools[name]["toolset"] == originals[name].toolset
        assert tools[name]["override"] is True
        assert tools[name]["max_result_size_chars"] == originals[name].max_result_size_chars
    # The wrapper never edits the built-in schema it read.
    assert "device" not in originals["terminal"].schema["parameters"]["properties"]


def test_the_tool_list_is_fixed_whatever_the_runtime_checks_say(monkeypatch):
    def digest(tools):
        schemas = [tools[name]["schema"] for name in sorted(tools)]
        return hashlib.sha256(json.dumps(schemas, sort_keys=True).encode()).hexdigest()

    first = _registered()
    # computer_use's own check fails in a sandbox with no display; the routed tool is still offered.
    monkeypatch.setattr(_originals()["computer_use"], "check_fn", lambda: False)
    second = _registered()
    assert digest(first) == digest(second)
    assert all(tool["check_fn"]() is True for tool in second.values())


def _route(monkeypatch, answer):
    """The desktop UI bridge as tui_gateway installs it; ``None`` means no bridge at all."""
    calls = []

    def request(sid, event, payload, timeout=30):
        calls.append((event, payload, timeout))
        return answer if isinstance(answer, str) else json.dumps(answer)

    from tools import desktop_ui

    monkeypatch.setattr(desktop_ui, "_request", None if answer is None else request)
    return calls


def test_routing_follows_the_controllers_answer(monkeypatch):
    ran = []
    original = lambda args, **kw: (ran.append(args), json.dumps({"ran": "here"}))[1]
    terminal = MODULE.wrap("terminal", original)

    calls = _route(monkeypatch, {"status": "cloud", "message": "Runs in the cloud."})
    assert json.loads(terminal({"command": "ls", "device": "cloud"})) == {"ran": "here"}
    assert ran == [{"command": "ls"}]  # the routing properties never reach the original tool
    assert calls[0][0] == "atum.device.request"
    assert calls[0][1]["tool"] == "terminal" and calls[0][1]["device"] == "cloud"

    _route(monkeypatch, {"status": "ok", "device": {"id": "d1", "name": "MacBook Pro"}, "result": {"output": "hello.txt", "exit_code": 0}, "message": "done"})
    assert json.loads(terminal({"command": "ls ~/Downloads"})) == {"output": "hello.txt", "exit_code": 0}

    _route(monkeypatch, {"status": "offline", "device": {"id": "d2", "name": "Mac mini"}, "message": "Mac mini is offline; wait or name another device."})
    error = json.loads(terminal({"command": "ls", "device": "Mac mini"}))
    assert error == {"error": "Mac mini is offline; wait or name another device.", "status": "offline", "device": "Mac mini"}

    _route(monkeypatch, "")  # an interrupt released the request
    assert json.loads(terminal({"command": "ls"}))["status"] == "stopped"
    _route(monkeypatch, "not json")
    assert json.loads(terminal({"command": "ls"}))["status"] == "unknown"
    assert len(ran) == 1


def test_the_request_outlives_the_owners_ten_minute_approval(monkeypatch):
    terminal = MODULE.wrap("terminal", lambda args, **kw: "must not run")
    calls = _route(monkeypatch, {"status": "approval_timeout", "message": "Nobody was at the Mac."})
    answer = json.loads(terminal({"command": "security find-generic-password -s x", "device": "Mac mini"}))
    assert answer["status"] == "approval_timeout"
    # A Touch ID sheet waits up to 600 s: the request must still be listening, and stays under the cap.
    assert calls[0][2] > 600
    assert calls[0][2] <= MODULE.MAX_REQUEST_S
    # A long tool timeout never pushes the request past the cap.
    terminal({"command": "sleep 800", "timeout": 800, "device": "Mac mini"})
    assert calls[1][2] == MODULE.MAX_REQUEST_S


def test_computer_control_never_runs_in_the_cloud(monkeypatch):
    original = lambda args, **kw: "must not run"
    computer = MODULE.wrap("computer_use", original)
    _route(monkeypatch, {"status": "cloud", "message": "Runs in the cloud."})
    assert json.loads(computer({"action": "screenshot"}))["status"] == "refused"


def test_any_other_hermes_without_a_controller_simply_runs_the_tool(monkeypatch):
    _route(monkeypatch, None)
    read = MODULE.wrap("read_file", lambda args, **kw: "file text")
    assert read({"path": "notes.md", "device": "MacBook Pro"}) == "file text"


def test_hermes_floor_stops_a_catastrophic_command_before_it_reaches_a_mac(monkeypatch):
    calls = _route(monkeypatch, {"status": "ok", "result": "ran", "message": "done"})
    terminal = MODULE.wrap("terminal", lambda args, **kw: "must not run")
    blocked = json.loads(terminal({"command": "rm -rf /", "device": "MacBook Pro"}))
    assert blocked.get("approved") is False
    assert calls == []
    assert json.loads(terminal({"command": "ls", "needs": ["root_password"]}))["status"] == "refused"
    assert calls == []
    assert terminal({"command": "git push", "needs": ["ssh_agent"]}) == "ran"
    assert calls[-1][1]["needs"] == ["ssh_agent"]


def test_device_send_file_needs_a_mac_and_a_path(monkeypatch):
    calls = _route(monkeypatch, {"status": "pending_device", "device": {"id": "d2", "name": "Mac mini"}, "message": "Your Mac mini is offline; I'll get it when it's back."})
    assert json.loads(MODULE.send_file({"path": "~/x"}))["status"] == "refused"
    answer = json.loads(MODULE.send_file({"device": "Mac mini", "path": "~/Desktop/s1-demo/hello.txt"}))
    assert answer == {"error": "Your Mac mini is offline; I'll get it when it's back.", "status": "pending_device", "device": "Mac mini"}
    assert calls[-1][1] == {"tool": "device_send_file", "device": "Mac mini", "args": {"path": "~/Desktop/s1-demo/hello.txt"}, "tool_call_id": ""}


def test_device_list_asks_the_controller_and_never_runs_the_tool(monkeypatch):
    # Awareness on demand: device="list" on any routed tool shows the owner's Macs and what works
    # on each. It is a question to the controller; the tool itself never runs (here or on a Mac).
    macs = {"macs": [{"name": "Mac mini", "online": False, "works": ["terminal"], "note": "off"}], "message": "Every Mac is off."}
    calls = _route(monkeypatch, {"status": "ok", "result": macs, "message": "Every Mac is off."})
    ran = []
    terminal = MODULE.wrap("terminal", lambda args, **kw: ran.append(args))
    read = MODULE.wrap("read_file", lambda args, **kw: ran.append(args))
    assert json.loads(terminal({"command": "rm -rf /", "device": " List "})) == macs
    assert json.loads(read({"path": "x", "device": "list"})) == macs
    assert json.loads(MODULE.send_file({"device": "list"})) == macs
    assert ran == []
    assert [c[1]["device"] for c in calls] == ["list", "list", "list"]
    assert [c[1]["tool"] for c in calls] == ["terminal", "read_file", "device_send_file"]
    assert all(c[1]["args"] == {} for c in calls)  # nothing of the call's own arguments travels
    # The property says so, so the model can find it without a prompt change.
    assert "list" in MODULE.DEVICE_PROPERTY["description"]

    # A refusal from the controller reaches the model as a plain error, not a crash.
    _route(monkeypatch, {"status": "refused", "message": "No Mac is set up for Atum yet."})
    assert json.loads(terminal({"device": "list"}))["status"] == "refused"
    # Any other Hermes (no controller): nothing is reachable, and it says so.
    _route(monkeypatch, None)
    assert json.loads(terminal({"device": "list"}))["macs"] == []


def test_the_plugin_loads_only_when_the_cloud_configuration_enables_it(monkeypatch, tmp_path):
    from hermes_cli.plugins import PluginManager

    home = Path(os.environ["HERMES_HOME"])
    off = PluginManager()
    off.discover_and_load()
    assert "atum-device" in off._plugins and not off._plugins["atum-device"].enabled

    (home / "config.yaml").write_text("plugins:\n  enabled: [atum-device]\n  entries:\n    atum-device:\n      allow_tool_override: true\n")
    on = PluginManager()
    on.discover_and_load()
    assert on._plugins["atum-device"].enabled
    from tools.registry import registry

    assert "device" in registry.get_entry("terminal").schema["parameters"]["properties"]
    assert registry.get_entry("device_send_file").toolset == "atum_device"


def test_plugins_first_startup_registers_the_device_overrides(tmp_path):
    """Reproduce ``hermes serve`` before its first model_tools import.

    This must run in a child interpreter: the test module's normal helpers
    intentionally import model_tools, so the parent registry is already warm.
    """
    (tmp_path / "config.yaml").write_text(
        "plugins:\n"
        "  enabled: [atum-device]\n"
        "  entries:\n"
        "    atum-device:\n"
        "      allow_tool_override: true\n"
    )
    script = """
import sys
assert 'model_tools' not in sys.modules
from hermes_cli.plugins import discover_plugins
discover_plugins()
from tools.registry import registry
terminal = registry.get_entry('terminal')
assert terminal is not None
assert 'device' in terminal.schema['parameters']['properties']
assert registry.get_entry('device_send_file') is not None
"""
    env = os.environ.copy()
    env["HERMES_HOME"] = str(tmp_path)
    env["PYTHONNOUSERSITE"] = "1"
    subprocess.run(
        [sys.executable, "-c", script],
        cwd=PLUGIN.parents[2],
        env=env,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_device_request_uses_native_approval_correlation(monkeypatch):
    from tools.approval_context import set_current_observability_context, reset_current_observability_context
    from tools import desktop_ui

    observed = []
    monkeypatch.setattr(desktop_ui, "request", lambda _name, payload, _timeout: observed.append(payload) or '{"status":"cloud"}')
    tokens = set_current_observability_context(turn_id="turn", tool_call_id="native-call", session_id="session")
    try:
        MODULE._request("read_file", None, {"path": "note.txt"}, None, 1)
    finally:
        reset_current_observability_context(tokens)
    assert observed[0]["tool_call_id"] == "native-call"
