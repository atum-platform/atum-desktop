"""Terminal reads use the split server-request transport."""

from tui_gateway import server, server_requests


def test_terminal_read_callback_targets_the_current_ui_session(monkeypatch):
    monkeypatch.setattr(server, "_sessions", {"own": {"active_turn_id": "first"}})
    calls = []
    monkeypatch.setattr(
        server_requests,
        "send",
        lambda method, sid, params, *, timeout: calls.append((method, sid, params, timeout)) or {},
    )
    monkeypatch.setattr(server, "_load_interim_assistant_messages", lambda: False)
    callback = server._agent_cbs("own")["read_terminal_callback"]
    server._sessions["own"]["active_turn_id"] = "current"
    callback(start=2, count=3)
    assert calls == [("terminal.read", "own", {"start": 2, "count": 3}, 30)]
