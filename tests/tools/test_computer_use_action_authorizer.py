"""Trusted embedding hosts authorize against the locked dispatch backend."""
import json

import pytest

from tools.computer_use import tool as cu


@pytest.fixture
def backend(monkeypatch):
    cu.reset_backend_for_tests()
    instance = cu._NoopBackend()
    monkeypatch.setattr(cu, "_new_backend", lambda mode: instance)
    yield instance
    cu.reset_backend_for_tests()


@pytest.mark.parametrize("bypass", ["off", "yolo", "manual"])
def test_authorizer_runs_once_per_scope_under_call_lock(backend, monkeypatch, tmp_path, bypass):
    from tools import approval

    (tmp_path / "config.yaml").write_text(f"approvals:\n  mode: {'off' if bypass == 'off' else 'manual'}\n")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", bypass == "yolo")
    assert approval.is_approval_bypass_active_for_session("host") is (bypass != "manual")
    monkeypatch.setattr(cu, "_request_approval", lambda *a: pytest.fail("shared gate called"))
    events = []

    def authorize(scope, args, summary, actual):
        assert actual is backend
        assert cu._backend_call_locks[cu._scoped_sid("host")]._is_owned()
        events.append(scope)
        return True

    def dispatch(actual, action, args, **kw):
        assert actual is backend
        assert events == ["focus_app", "bring_to_front"]
        return '{"ok": true}'

    monkeypatch.setattr(cu, "_dispatch", dispatch)
    assert json.loads(cu.handle_computer_use(
        {"action": "focus_app", "app": "Fixture", "raise_window": True},
        session_id="host", action_authorizer=authorize,
    ))["ok"]
    assert events == ["focus_app", "bring_to_front"]


@pytest.mark.parametrize("raises", [False, True])
def test_denial_or_authorizer_error_never_dispatches(backend, monkeypatch, raises):
    monkeypatch.setattr(cu, "_dispatch", lambda *a, **kw: pytest.fail("dispatched"))
    monkeypatch.setattr(cu, "_request_approval", lambda *a: pytest.fail("shared gate called"))

    def authorize(*args):
        if raises:
            raise RuntimeError("authorizer unavailable")
        return False

    result = json.loads(cu.handle_computer_use(
        {"action": "click", "coordinate": [1, 2]}, action_authorizer=authorize,
    ))
    assert "error" in result
    assert ("authorizer unavailable" in result["error"]) is raises


def test_without_authorizer_uses_shared_gate(backend, monkeypatch):
    calls = []
    monkeypatch.setattr(cu, "_request_approval", lambda scope, args: calls.append(scope) or '{"error": "shared refusal"}')
    monkeypatch.setattr(cu, "_dispatch", lambda *a, **kw: pytest.fail("dispatched"))
    assert json.loads(cu.handle_computer_use(
        {"action": "click", "coordinate": [1, 2]}, action_authorizer=None,
    )) == {"error": "shared refusal"}
    assert calls == ["click"]
