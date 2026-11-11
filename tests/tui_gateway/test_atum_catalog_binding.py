import json
import pytest

from gateway.session_context import clear_session_vars, set_session_vars
from cron.execution_identity import enter_cron_execution, exit_cron_execution
from tools import desktop_ui
from tools.atum_store_tool import atum_store
from tui_gateway import desktop_ui_bridge, server


def test_store_tool_roundtrip_uses_split_runtime_bridge(monkeypatch):
    monkeypatch.setattr(server, "_sessions", {"session": {
        "running": True, "active_turn_id": "actual", "source": "matrix",
    }})
    calls = []

    def send(sid, payload, timeout):
        calls.append((sid, payload, timeout))
        receipt = {"items": [{"itemId": "skill/focus"}], "totalMatches": 1, "hasMore": False}
        return {"value": json.dumps(receipt)}

    monkeypatch.setitem(desktop_ui_bridge._SENDERS, "atum.store", send)
    monkeypatch.setattr(desktop_ui, "_request", desktop_ui_bridge._desktop_ui_request)
    tokens = set_session_vars(session_key="durable", source="matrix", ui_session_id="session")
    try:
        result = json.loads(atum_store(query="focus"))
    finally:
        clear_session_vars(tokens)
    assert result["items"] == [{"itemId": "skill/focus"}]
    assert calls == [("session", {
        "operation": "search", "query": "focus", "limit": 10, "turn_id": "actual",
    }, 30)]


def test_runtime_strips_forged_catalog_authority_and_rejects_expired_turn(monkeypatch):
    session = {"running": True, "active_turn_id": "real", "source": "matrix"}
    monkeypatch.setattr(server, "_sessions", {"session": session})
    calls = []

    def send(sid, payload, timeout):
        calls.append((sid, payload, timeout))
        session["active_turn_id"] = "successor"
        return {"value": '{"items":[]}'}

    monkeypatch.setitem(desktop_ui_bridge._SENDERS, "atum.store", send)
    result = desktop_ui_bridge._desktop_ui_request("session", "atum.store.request", {
        "operation": "search", "query": "focus", "turn_id": "forged", "owner": "other",
        "role": "main", "url": "https://bad.test",
    }, 30)
    assert calls == [("session", {
        "operation": "search", "query": "focus", "turn_id": "real",
    }, 30)]
    assert "turn ended" in json.loads(result)["error"]


def test_platform_claimed_native_job_uses_the_sessionless_host_bridge(monkeypatch):
    execution_id = "22800000-0000-4000-8000-00000000a228"
    calls = []
    monkeypatch.setenv("ATUM_TASK_WORKSPACE", "/task/workspace")
    monkeypatch.setattr(
        desktop_ui_bridge.server_requests,
        "request_host",
        lambda method, body, timeout: calls.append((method, body, timeout)) or '{"rooms":[]}',
    )
    token = enter_cron_execution(
        {"id": "brief", "name": "Morning brief"},
        execution_id,
        {"source": "atum"},
    )
    try:
        result = desktop_ui_bridge._desktop_ui_request(
            "",
            "atum.chats.request",
            {"op": "list", "limit": 5, "turn_id": "forged", "owner": "forged"},
            60,
        )
    finally:
        exit_cron_execution(token)
    assert json.loads(result) == {"rooms": []}
    assert calls == [("atum.chats", {
        "op": "list", "limit": 5, "turn_id": execution_id,
    }, 60)]


@pytest.mark.parametrize(
    "method,payload,expected,timeout",
    [
        (
            "atum.agents",
            {"operation": "read", "target": "00000000-0000-4000-8000-11e594f48195",
             "role": "main", "owner": "forged", "turn_id": "old"},
            {"operation": "read", "target": "00000000-0000-4000-8000-11e594f48195", "turn_id": "turn"},
            30,
        ),
        (
            "atum.agent_tasks",
            {"operation": "stop", "taskId": "00000000-0000-4000-8000-bd7662a5eeb4",
             "role": "main", "owner": "forged", "turn_id": "old"},
            {"operation": "stop", "taskId": "00000000-0000-4000-8000-bd7662a5eeb4", "turn_id": "turn"},
            90,
        ),
        (
            "atum.routines",
            {"profile": "atum.agent-routine-command/1", "operation": "update",
             "routineId": "00000000-0000-4000-8000-bd7662a5eeb4", "expectedRevision": 3,
             "enabled": False, "requestId": "forged", "executorId": "forged",
             "agentPrincipal": "forged", "expr": "* * * * *", "turn_id": "old"},
            {"profile": "atum.agent-routine-command/1", "operation": "update",
             "routineId": "00000000-0000-4000-8000-bd7662a5eeb4", "expectedRevision": 3,
             "enabled": False, "turn_id": "turn"},
            60,
        ),
        (
            "atum.chats",
            {"op": "list", "unreadOnly": True, "limit": 10, "role": "main",
             "owner": "forged", "turn_id": "old"},
            {"op": "list", "unreadOnly": True, "limit": 10, "turn_id": "turn"},
            60,
        ),
    ],
)
def test_matrix_requests_are_turn_bound_and_strip_authority(
    monkeypatch, method, payload, expected, timeout,
):
    monkeypatch.setattr(server, "_sessions", {"session": {
        "source": "matrix", "running": True, "active_turn_id": "turn",
    }})
    calls = []
    monkeypatch.setitem(
        desktop_ui_bridge._SENDERS,
        method,
        lambda sid, body, wait: calls.append((sid, body, wait)) or {"value": '{"error":"denied"}'},
    )
    result = desktop_ui_bridge._desktop_ui_request("session", f"{method}.request", payload, timeout)
    assert calls == [("session", expected, timeout)]
    assert json.loads(result) == {"error": "denied"}


@pytest.mark.parametrize("source,running", [("desktop", True), ("matrix", False)])
def test_routines_request_needs_a_live_matrix_turn(monkeypatch, source, running):
    monkeypatch.setattr(server, "_sessions", {"session": {
        "source": source, "running": running, "active_turn_id": "turn",
    }})
    monkeypatch.setitem(
        desktop_ui_bridge._SENDERS,
        "atum.routines",
        lambda *args: pytest.fail("must not reach the host"),
    )
    result = desktop_ui_bridge._desktop_ui_request(
        "session", "atum.routines.request", {"operation": "list"}, 60)
    assert "live Matrix agent turn" in json.loads(result)["error"]


@pytest.mark.parametrize("source,workspace,sid", [
    ("direct", "/task/workspace", ""), ("builtin", "/task/workspace", ""),
    ("atum", "", ""), ("atum", "/task/workspace", "foreign"),
])
def test_native_bridge_requires_cloud_claim_without_a_ui_session(monkeypatch, source, workspace, sid):
    monkeypatch.setenv("ATUM_TASK_WORKSPACE", workspace)
    monkeypatch.setattr(server, "_sessions", {})
    def unexpected(*args, **kwargs):
        pytest.fail("unclaimed request reached host")
    monkeypatch.setattr(desktop_ui_bridge.server_requests, "request_host", unexpected)
    token = enter_cron_execution({"id": "brief"}, "22800000-0000-4000-8000-00000000a228", {"source": source})
    try:
        assert "error" in json.loads(desktop_ui_bridge._desktop_ui_request(sid, "atum.chats", {"op": "list"}, 60))
    finally:
        exit_cron_execution(token)
