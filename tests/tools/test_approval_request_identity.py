"""An approval occurrence is not its reusable allowlist pattern."""
import tools.approval as approval
import tools.approval_context as approval_context
import tools.approval_gateway_wait as approval_gateway_wait


def setup(monkeypatch):
    # Patch the split owners the gateway wait reads at call time (v0.22.5 approval split).
    monkeypatch.setattr(approval, "_gateway_queues", {})
    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 0)
    monkeypatch.setattr(approval_gateway_wait, "is_interrupted", lambda: False)
    monkeypatch.setattr(approval_context, "_fire_approval_hook", lambda *a, **k: None)


def test_expired_occurrence_cannot_approve_later_same_pattern(monkeypatch):
    setup(monkeypatch)
    captured = []
    payload = {"pattern_key": "same-rule", "command": "fixture", "description": "fixture"}
    expired = approval._await_gateway_decision("session", captured.append, payload)
    assert expired["resolved"] is False
    old_id = captured[0]["request_id"]
    assert "request_id" not in payload

    def respond(data):
        assert data["request_id"] != old_id
        assert approval.resolve_gateway_approval("session", "once", request_id=old_id) == 0
        assert approval.resolve_gateway_approval("other", "once", request_id=data["request_id"]) == 0
        assert approval.resolve_gateway_approval("session", "once", request_id=data["request_id"], pattern_key="other") == 0
        assert approval.resolve_gateway_approval("session", "deny", request_id=data["request_id"]) == 1
        assert approval.resolve_gateway_approval("session", "once", request_id=data["request_id"]) == 0

    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 1)
    result = approval._await_gateway_decision("session", respond, payload)
    assert result["resolved"] is True
    assert result["choice"] == "deny"
    assert not approval._gateway_queues


def test_exact_occurrence_does_not_resolve_other_parallel_approval(monkeypatch):
    setup(monkeypatch)
    first = approval_gateway_wait._ApprovalEntry({"pattern_key": "same"})
    second = approval_gateway_wait._ApprovalEntry({"pattern_key": "same"})
    approval._gateway_queues["s"] = [first, second]
    assert approval.resolve_gateway_approval("s", "once", resolve_all=True, request_id=second.data["request_id"]) == 1
    assert second.event.is_set() and second.result == "once"
    assert not first.event.is_set()
    # Older integrations still use their existing FIFO/pattern contract.
    assert approval.resolve_gateway_approval("s", "deny", pattern_key="same") == 1
    assert first.result == "deny"


def test_gateway_forwards_occurrence_id(monkeypatch):
    import tui_gateway.server as server
    setup(monkeypatch)
    entry = approval_gateway_wait._ApprovalEntry({"pattern_key": "same"})
    approval._gateway_queues["s"] = [entry]
    monkeypatch.setattr(server, "_sess", lambda params, rid: ({"session_key": "s"}, None))
    respond = server._methods["approval.respond"]
    assert respond(1, {"session_id": "live", "choice": "once", "request_id": "expired"})["result"] == {"resolved": 0}
    assert not entry.event.is_set()
    assert respond(2, {"session_id": "live", "choice": "once", "request_id": entry.data["request_id"]})["result"] == {"resolved": 1}
