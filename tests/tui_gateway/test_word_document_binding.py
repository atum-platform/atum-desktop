import json
import time

from gateway.session_context import clear_session_vars, set_session_vars
from tools import desktop_ui, open_preview_tool, word_document_tool
from tui_gateway import desktop_ui_bridge, server, server_requests


def _open_word_request(monkeypatch, *, source="matrix", running=True, expires_at=None):
    transport = object()
    session = {
        "running": running,
        "active_turn_id": "turn",
        "source": source,
        "session_key": "durable",
        "transport": transport,
    }
    monkeypatch.setattr(server, "_sessions", {"live": session})
    monkeypatch.setattr(server, "current_transport", lambda: transport)
    monkeypatch.setattr(server_requests, "_open", {})
    request = server_requests.ServerRequest("live", "word.document", {
        "turn_id": "turn",
        "expires_at": expires_at if expires_at is not None else time.time() + 30,
        "action": "replace_text",
        "revision": "original",
        "find": "old",
        "replacement": "new",
    })
    server_requests._register(request, lambda _frame: None)
    return request, session


def test_matrix_word_resolution_is_pending_turn_and_transport_bound(monkeypatch):
    request, session = _open_word_request(monkeypatch)
    ref = {"request_id": request.id, "session_id": "live", "turn_id": "turn"}
    resolve = server._methods["word.document.resolve"]
    assert resolve(1, ref)["result"]["replacement"] == "new"
    assert resolve(1, ref)["result"]["durable_session_id"] == "durable"
    for forged in ({**ref, "session_id": "foreign"}, {**ref, "turn_id": "old"}):
        assert "error" in resolve(1, forged)
    assert resolve(1, {**ref, "find": "forged"})["result"]["find"] == "old"
    monkeypatch.setattr(server, "current_transport", object)
    assert "error" in resolve(1, ref)
    session["running"] = False
    assert "error" in resolve(1, ref)


def test_preview_tool_receives_runtime_turn_authority(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    session = {"running": True, "active_turn_id": "real-turn", "source": "desktop"}
    monkeypatch.setattr(server, "_sessions", {"live": session})
    monkeypatch.setattr(desktop_ui_bridge, "_wired", False)
    monkeypatch.setattr(desktop_ui, "_emit", None)
    monkeypatch.setattr(desktop_ui, "_request", None)
    events = []
    monkeypatch.setattr(server, "_emit", lambda *args: events.append(args))
    desktop_ui_bridge.wire()
    tokens = set_session_vars(session_key="durable", source="desktop", ui_session_id="live")
    try:
        for url in ("https://example.com", "/tmp/report.docx"):
            result = json.loads(open_preview_tool.open_preview_tool(url))
            assert result["success"]
            assert events[-1] == (
                "preview.open", "live", {"url": url, "label": "", "turn_id": "real-turn"})
        desktop_ui.emit("preview.open", {"url": "/tmp/report.docx", "turn_id": "forged"})
        assert events[-1][2]["turn_id"] == "real-turn"
        session["running"] = False
        desktop_ui.emit("preview.open", {"url": "https://example.com", "turn_id": "forged"})
        assert "turn_id" not in events[-1][2]
    finally:
        clear_session_vars(tokens)


def test_word_tool_uses_split_request_policy(monkeypatch):
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("ATUM_WORD_COMPANION", "1")
    monkeypatch.setattr(server, "_sessions", {"live": {
        "running": True, "active_turn_id": "turn", "source": "desktop", "session_key": "durable",
    }})
    calls = []
    monkeypatch.setitem(
        desktop_ui_bridge._SENDERS,
        "word.document",
        lambda sid, body, timeout: calls.append((sid, body, timeout)) or {"value": '{"applied":true}'},
    )
    monkeypatch.setattr(desktop_ui, "_request", desktop_ui_bridge._desktop_ui_request)
    tokens = set_session_vars(session_key="durable", source="desktop", ui_session_id="live")
    try:
        result = json.loads(word_document_tool.word_document("replace_text", "revision", "old", "new"))
    finally:
        clear_session_vars(tokens)
    assert result == {"applied": True}
    sid, body, timeout = calls[0]
    assert sid == "live" and timeout == 45
    assert body["turn_id"] == "turn"
    assert body["action"] == "replace_text"
    assert body["revision"] == "revision"
    assert body["find"] == "old" and body["replacement"] == "new"
    assert body["expires_at"] > time.time()


def test_cancelled_expired_non_desktop_requests_cannot_resolve(monkeypatch):
    request, session = _open_word_request(monkeypatch)
    assert server.word_document_request_scope(request.id, "live", "turn")
    session["running"] = False
    assert server.word_document_request_scope(request.id, "live", "turn") is None
    session.update(running=True, source="cli")
    assert server.word_document_request_scope(request.id, "live", "turn") is None
    session["source"] = "desktop"
    request.params["expires_at"] = 0
    assert server.word_document_request_scope(request.id, "live", "turn") is None


def test_invalid_text_and_missing_capability_do_not_reach_desktop(monkeypatch):
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("ATUM_WORD_COMPANION", "1")
    monkeypatch.setattr(desktop_ui, "request", lambda *a, **k: (_ for _ in ()).throw(AssertionError("native contacted")))
    for replacement in ("", "two\nparagraphs", "\ud800", "🌿" * 600, []):
        assert "error" in json.loads(word_document_tool.word_document("replace_text", "revision", "old", replacement))
    monkeypatch.delenv("ATUM_WORD_COMPANION")
    assert not word_document_tool.available()
    assert "error" in json.loads(word_document_tool.word_document("read"))
