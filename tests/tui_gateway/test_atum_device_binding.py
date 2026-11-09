"""The gateway's side of the cloud brain's device calls (S1 build plan §3.4) and the quiesce step.

A device call is bound to the live Matrix turn by the runtime (turn and expiry), never by the
tool's arguments; only the controller's scoped answer releases it; an interrupt or a timeout is a
stop; and ``runtime.quiesce`` waits for the turn's background review before the second export.
"""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from gateway.session_context import clear_session_vars, set_session_vars
from tools import desktop_ui
from tui_gateway import desktop_ui_bridge, server, server_requests


def _live(monkeypatch, source="matrix"):
    transport = object()
    session = {"running": True, "active_turn_id": "turn-1", "source": source, "session_key": "durable", "transport": transport}
    monkeypatch.setattr(server, "_sessions", {"live": session})
    monkeypatch.setattr(server, "current_transport", lambda: transport)
    frames = []
    cancellations = []
    emitted = threading.Event()
    monkeypatch.setattr(server_requests, "_write", lambda frame: (frames.append(frame), emitted.set(), True)[-1])
    monkeypatch.setattr(server_requests, "_emit", lambda *args: cancellations.append(args))
    monkeypatch.setattr(server_requests, "_answerable", lambda _sid: True)
    server_requests.reset_for_tests()
    return session, frames, cancellations, emitted


def test_a_device_call_is_bound_to_the_live_turn_and_released_only_by_its_scoped_answer(monkeypatch):
    _session, frames, _cancellations, emitted = _live(monkeypatch)
    request = {"tool": "terminal", "device": "MacBook Pro", "args": {"command": "ls"}, "tool_call_id": "call-1",
               "turn_id": "forged", "expires_at": 1, "request_id": "forged"}
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(desktop_ui_bridge._desktop_ui_request, "live", "atum.device.request", request, 60)
        assert emitted.wait(2)
        frame = frames[0]
        assert frame["method"] == "atum.device"
        payload = frame["params"]
        assert payload["session_id"] == "live"
        # The runtime stamps the turn and the expiry; the tool's own values never survive.
        assert payload["turn_id"] == "turn-1"
        assert frame["id"] != "forged" and "request_id" not in payload
        assert time.time() * 1000 < payload["expires_at"] <= (time.time() + 61) * 1000
        assert {k: payload[k] for k in ("tool", "device", "args", "tool_call_id")} == {
            "tool": "terminal", "device": "MacBook Pro", "args": {"command": "ls"}, "tool_call_id": "call-1"}
        answer = json.dumps({"status": "ok", "result": {"output": "hello.txt"}, "message": "done"})
        assert server_requests.resolve_response({"id": frame["id"], "result": {"value": answer}})
        assert json.loads(pending.result(2)) == {"status": "ok", "result": {"output": "hello.txt"}, "message": "done"}
    assert server_requests.open_requests("live") == []


def test_only_a_live_matrix_turn_can_make_a_device_call(monkeypatch):
    session, frames, _cancellations, _ = _live(monkeypatch, source="desktop")
    assert "error" in json.loads(desktop_ui_bridge._desktop_ui_request(
        "live", "atum.device.request", {"tool": "terminal", "args": {}}, 30))
    session["source"] = "matrix"
    session["running"] = False
    assert "error" in json.loads(desktop_ui_bridge._desktop_ui_request(
        "live", "atum.device.request", {"tool": "terminal", "args": {}}, 30))
    session["running"] = True
    assert json.loads(desktop_ui_bridge._desktop_ui_request(
        "live", "atum.device.request", {"tool": "rm_rf", "args": {}}, 30))["status"] == "refused"
    assert frames == []


def test_an_interrupt_withdraws_the_native_request_and_stops_the_call(monkeypatch):
    _session, frames, cancellations, emitted = _live(monkeypatch)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(desktop_ui_bridge._desktop_ui_request, "live", "atum.device.request", {"tool": "terminal", "args": {"command": "sleep 60"}}, 60)
        assert emitted.wait(2)
        server._clear_pending("live")  # what session.interrupt does
        assert pending.result(2) == ""
    assert frames[0]["method"] == "atum.device"
    assert cancellations == [("request.cancel", "live", {
        "id": frames[0]["id"], "method": "atum.device", "reason": "interrupted"})]


def test_only_the_sessions_own_client_can_answer_a_device_call(monkeypatch):
    """A response frame settles a request by id alone upstream; a device answer must also come from a
    client attached to the request's own session (a forged session), never through ``request.answer``
    from another one, and an answer after the turn moved on (a forged turn) is a stop, not a result."""
    session, frames, _cancellations, emitted = _live(monkeypatch)
    owner, stranger = session["transport"], object()
    monkeypatch.setattr(server_requests, "_clients", lambda sid: [owner] if sid == "live" else [stranger])
    answer = json.dumps({"status": "ok", "result": {"output": "secret.txt"}})
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(desktop_ui_bridge._desktop_ui_request, "live", "atum.device.request",
                              {"tool": "terminal", "args": {"command": "ls"}}, 60)
        assert emitted.wait(2)
        rid = frames[0]["id"]
        frame = {"jsonrpc": "2.0", "id": rid, "result": {"value": answer}}
        # Another session's client knows the id: refused, the call is still waiting.
        assert server_requests.resolve_response(frame, stranger) is False
        monkeypatch.setattr(server, "current_transport", lambda: stranger)
        assert server._methods["request.answer"](1, {"id": rid, "result": {"value": answer}})["result"] == {"status": "expired"}
        assert [request["id"] for request in server_requests.open_requests("live")] == [rid]
        assert not pending.done()
        # The session's own client is answered, but the turn moved on meanwhile: the late answer is dropped.
        session["active_turn_id"] = "turn-2"
        assert server_requests.resolve_response(frame, owner) is True
        assert "error" in json.loads(pending.result(2))


def test_a_device_call_that_times_out_is_withdrawn_and_answers_nothing(monkeypatch):
    _session, frames, cancellations, emitted = _live(monkeypatch)
    result = desktop_ui_bridge._desktop_ui_request("live", "atum.device.request", {"tool": "terminal", "args": {"command": "ls"}}, 1)
    assert emitted.is_set() and frames[0]["method"] == "atum.device"
    assert result == ""
    assert cancellations == [("request.cancel", "live", {"id": frames[0]["id"], "method": "atum.device", "reason": "timeout"})]
    # A late answer revives nothing.
    assert server_requests.resolve_response({"id": frames[0]["id"], "result": {"value": "{}"}}) is False


def test_the_plugin_reaches_the_controller_through_the_real_bridge(monkeypatch):
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("atum_device_bridge_test", Path(__file__).parents[2] / "plugins" / "atum-device" / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    _session, frames, _cancellations, emitted = _live(monkeypatch)
    monkeypatch.setattr(desktop_ui, "_request", desktop_ui_bridge._desktop_ui_request)
    terminal = plugin.wrap("terminal", lambda args, **kw: "ran in the sandbox")

    def from_turn():
        tokens = set_session_vars(session_key="durable", source="matrix", ui_session_id="live")
        try:
            return terminal({"command": "ls ~/Downloads"})
        finally:
            clear_session_vars(tokens)

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(from_turn)
        assert emitted.wait(2)
        frame = frames[0]
        sid, payload = frame["params"]["session_id"], frame["params"]
        assert payload["device"] is None and payload["args"] == {"command": "ls ~/Downloads"}
        assert sid == "live"
        server_requests.resolve_response({"id": frame["id"], "result": {
            "value": json.dumps({"status": "cloud", "message": "Runs in the cloud."})}})
        assert pending.result(2) == "ran in the sandbox"


def test_quiesce_waits_for_background_review_and_reports_what_is_still_running():
    release = threading.Event()
    review = threading.Thread(target=lambda: release.wait(5), name="bg-review", daemon=True)
    review.start()
    quiesce = server._methods["runtime.quiesce"]
    started = time.monotonic()
    still = quiesce(1, {"timeout_ms": 200})["result"]
    assert still == {"drained": False, "pending": ["bg-review"]}
    assert time.monotonic() - started < 2
    release.set()
    review.join(2)
    assert quiesce(1, {"timeout_ms": 1000})["result"] == {"drained": True, "pending": []}
    assert "error" in quiesce(1, {"timeout_ms": "soon"})
    assert "runtime.quiesce" in server._LONG_HANDLERS


def test_quiesce_with_no_wait_is_a_probe_that_answers_at_once_and_waits_for_nothing():
    # The desktop's background checkpoint asks this of a running agent before it captures the agent's home: has the
    # post-answer review finished writing? It must not wait for it (a checkpoint never holds an agent's reply up) and
    # must not disturb it (the review goes on, and the answer is the same the next time it is asked).
    release = threading.Event()
    review = threading.Thread(target=lambda: release.wait(5), name="bg-review", daemon=True)
    quiesce = server._methods["runtime.quiesce"]
    assert quiesce(1, {"timeout_ms": 0})["result"] == {"drained": True, "pending": []}

    review.start()
    try:
        started = time.monotonic()
        assert quiesce(1, {"timeout_ms": 0})["result"] == {"drained": False, "pending": ["bg-review"]}
        assert quiesce(1, {"timeout_ms": 0})["result"] == {"drained": False, "pending": ["bg-review"]}
        assert time.monotonic() - started < 1
        assert review.is_alive()
    finally:
        release.set()
        review.join(2)

    assert quiesce(1, {"timeout_ms": 0})["result"] == {"drained": True, "pending": []}
