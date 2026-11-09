"""The real gateway approval registry must gate computer mutations, not reads."""
import json
from unittest.mock import patch

import pytest

from tools import approval
from tools.computer_use import tool


@pytest.fixture(autouse=True)
def isolated_gateway(monkeypatch):
    tool.reset_backend_for_tests()
    monkeypatch.setattr(tool, "_approval_callback", None)
    # Upstream's recording stub (tests patch _new_backend); never the real cua-driver.
    monkeypatch.setattr(tool, "_new_backend", lambda mode: tool._NoopBackend())
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    monkeypatch.delenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", raising=False)
    monkeypatch.setattr(approval, "is_approval_bypass_active", lambda: False)
    key = approval.get_current_session_key()
    yield key
    approval.unregister_gateway_notify(key)
    approval.clear_session(key)
    tool.reset_backend_for_tests()


@pytest.mark.parametrize("choice,allowed", [("deny", False), ("once", True)])
def test_gateway_decision_precedes_launch_and_once_does_not_persist(isolated_gateway, choice, allowed):
    backend = tool._get_backend()
    requests = []

    def answer(data):
        assert backend.calls == []
        assert data["choices"] == ["once", "deny"]
        assert not data["allow_permanent"]
        # Upstream dropped Atum's launch_app; focus_app is the mutating app action it gates.
        assert "focus_app" in data["description"]
        requests.append(data)
        approval.resolve_gateway_approval(isolated_gateway, choice)

    approval.register_gateway_notify(isolated_gateway, answer)
    result = json.loads(tool.handle_computer_use({"action": "focus_app", "app": "Calculator"}))
    assert len(requests) == 1
    assert bool(backend.calls) is allowed
    if not allowed:
        assert "denied by user" in result["error"]
    backend.calls.clear()
    tool.handle_computer_use({"action": "focus_app", "app": "Calculator"})
    assert len(requests) == 2


def test_missing_gateway_listener_never_dispatches_mutation(isolated_gateway):
    backend = tool._get_backend()
    result = json.loads(tool.handle_computer_use({"action": "focus_app", "app": "Calculator"}))
    assert "error" in result
    assert backend.calls == []


def test_failed_gateway_notification_never_dispatches_mutation(isolated_gateway):
    def broken(_data):
        raise RuntimeError("UI disconnected")

    approval.register_gateway_notify(isolated_gateway, broken)
    backend = tool._get_backend()
    result = json.loads(tool.handle_computer_use({"action": "focus_app", "app": "Calculator"}))
    assert "error" in result
    assert backend.calls == []


def test_read_action_does_not_request_approval(isolated_gateway):
    with patch.object(approval, "request_tool_approval", side_effect=AssertionError("read was gated")):
        result = json.loads(tool.handle_computer_use({"action": "list_apps"}))
    assert result["apps"] == []


def test_existing_cli_callback_still_owns_cli_decision(isolated_gateway, monkeypatch):
    # Upstream routes to the CLI panel only for an interactive CLI with no gateway listener
    # (tools/approval_context.py ``_should_fall_through_to_cli_approval``).
    monkeypatch.setenv("HERMES_INTERACTIVE", "1")
    monkeypatch.setattr(tool, "_approval_callback", lambda *_a, **_k: "deny")
    with patch.object(approval, "request_tool_approval", side_effect=AssertionError("second gate")):
        result = json.loads(tool.handle_computer_use({"action": "focus_app", "app": "Calculator"}))
    assert result["error"] == "denied by user"


def test_required_atum_dispatch_adapter_does_not_ask_a_second_time(isolated_gateway, monkeypatch):
    monkeypatch.setenv("ATUM_FILESYSTEM_CAPABILITY_REQUIRED", "1")
    with patch.object(approval, "request_tool_approval", side_effect=AssertionError("duplicated approval")):
        tool.handle_computer_use({"action": "focus_app", "app": "Calculator"})
    assert tool._get_backend().calls


def test_a_callback_without_an_interactive_cli_never_dispatches(isolated_gateway, monkeypatch):
    # The gateway context has no listener and the CLI panel is not reachable: fail closed.
    monkeypatch.setattr(tool, "_approval_callback", lambda *_a, **_k: "once")
    result = json.loads(tool.handle_computer_use({"action": "focus_app", "app": "Calculator"}))
    assert "error" in result
    assert tool._get_backend().calls == []


def test_gateway_answer_outside_once_deny_is_refused_and_persists_nothing(isolated_gateway):
    def answer(data):
        approval.resolve_gateway_approval(isolated_gateway, "always")

    approval.register_gateway_notify(isolated_gateway, answer)
    result = json.loads(tool.handle_computer_use({"action": "focus_app", "app": "Calculator"}))
    assert "error" in result
    assert tool._get_backend().calls == []
    assert not approval.is_approved(isolated_gateway, "cua:focus_app:background")
