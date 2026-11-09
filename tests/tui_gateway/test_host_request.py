"""Session-less host requests use the split server-request registry."""

import json

import pytest

from tui_gateway import server, server_requests


def _request_state(monkeypatch, *, broadcast, emitted=None):
    emitted = [] if emitted is None else emitted
    monkeypatch.setattr(server_requests, "_open", {})
    server_requests.bind_sinks(
        lambda _frame: None,
        lambda event, sid, payload: emitted.append((event, sid, payload)),
        lambda _sid: True,
        broadcast=broadcast,
    )
    return emitted


def test_no_connected_host_answers_empty_at_once(monkeypatch):
    _request_state(monkeypatch, broadcast=lambda _frame: False)
    assert server_requests.request_host(
        "cron.delivery.request", {"room_id": "!r:x"}, timeout=30) == ""
    assert server_requests.open_request_count() == 0


def test_the_host_answers_through_standard_json_rpc_response(monkeypatch):
    receipt = json.dumps({"status": "delivered", "event_id": "$e"})
    frames = []

    def broadcast(frame):
        frames.append(frame)
        assert server_requests.resolve_response({
            "jsonrpc": "2.0", "id": frame["id"], "result": {"value": receipt},
        })
        return True

    _request_state(monkeypatch, broadcast=broadcast)
    assert server_requests.request_host(
        "cron.delivery.request", {"room_id": "!r:x", "text": "hi"}, timeout=5) == receipt
    assert frames[0]["method"] == "cron.delivery.request"
    assert frames[0]["params"] == {"session_id": "", "room_id": "!r:x", "text": "hi"}
    assert server_requests.open_request_count() == 0


def test_an_unanswered_request_expires(monkeypatch):
    frames = []
    emitted = _request_state(monkeypatch, broadcast=lambda frame: frames.append(frame) or True)
    assert server_requests.request_host(
        "cron.delivery.request", {"room_id": "!r:x"}, timeout=0) == ""
    assert emitted == [("request.cancel", "", {
        "id": frames[0]["id"], "method": "cron.delivery.request", "reason": "timeout",
    })]
    assert not server_requests.resolve_response({
        "jsonrpc": "2.0", "id": frames[0]["id"], "result": {"value": "{}"},
    })


def test_a_turns_host_named_chat_is_bound_without_a_platform(monkeypatch):
    """A Matrix room is turn context even without a gateway platform adapter."""
    from gateway.session_context import get_session_env

    monkeypatch.setattr(server, "_sessions", {
        "s1": {"session_key": "k1", "source": "matrix", "chat_id": "!alfred:x", "async_delivery": False},
    })
    tokens = server._set_session_context("k1")
    try:
        assert get_session_env("HERMES_SESSION_CHAT_ID") == "!alfred:x"
        assert get_session_env("HERMES_SESSION_PLATFORM", "") == ""
        assert get_session_env("HERMES_SESSION_SOURCE") == "matrix"
    finally:
        server._clear_session_context(tokens)


@pytest.mark.parametrize("chat_id", [5, "", "x" * 1025, "room\nnext"])
def test_prompt_submit_refuses_a_malformed_chat(monkeypatch, chat_id):
    monkeypatch.setattr(server, "_sessions", {
        "s1": {"session_key": "k1", "source": "matrix", "running": False},
    })
    response = server.handle_request({
        "id": "1", "method": "prompt.submit",
        "params": {"session_id": "s1", "text": "hi", "chat_id": chat_id},
    })
    assert response["error"]["code"] == 4004
    assert "chat_id" not in server._sessions["s1"]


def test_a_turn_without_a_chat_binds_none(monkeypatch):
    monkeypatch.setattr(server, "_sessions", {
        "s1": {"session_key": "k1", "source": "matrix", "chat_id": "!old:x", "running": False},
    })
    try:
        server.handle_request({
            "id": "1", "method": "prompt.submit", "params": {"session_id": "s1", "text": "hi"},
        })
    except Exception:
        pass
    assert "chat_id" not in server._sessions["s1"]
