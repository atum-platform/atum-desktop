import json
from tui_gateway import desktop_ui_bridge, server


def test_mac_request_is_live_matrix_only_and_strips_authority(monkeypatch):
    session = {
        "source": "matrix",
        "running": True,
        "active_turn_id": "turn",
    }
    calls = []

    def send(sid, payload, timeout):
        calls.append((sid, payload, timeout))
        return {"value": '{"error":"disabled"}'}

    monkeypatch.setattr(server, "_sessions", {"session": session})
    monkeypatch.setitem(desktop_ui_bridge._SENDERS, "atum.mac", send)
    result = desktop_ui_bridge._desktop_ui_request(
        "session",
        "atum.mac.request",
        {
            "op": "browser.history",
            "browser": "all",
            "days": 30,
            "limit": 100,
            "mode": "recent",
            "owner": "forged",
            "background": False,
            "turn_id": "old",
        },
        60,
    )

    assert calls == [
        (
            "session",
            {
                "op": "browser.history",
                "browser": "all",
                "days": 30,
                "limit": 100,
                "mode": "recent",
                "turn_id": "turn",
            },
            60,
        )
    ]
    assert json.loads(result) == {"error": "disabled"}


def test_mac_request_refuses_non_matrix_and_stale_turns(monkeypatch):
    monkeypatch.setattr(
        server,
        "_sessions",
        {"session": {"source": "desktop", "running": True, "active_turn_id": "turn"}},
    )
    monkeypatch.setitem(
        desktop_ui_bridge._SENDERS,
        "atum.mac",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError()),
    )
    assert "live Matrix agent turn" in json.loads(
        desktop_ui_bridge._desktop_ui_request(
            "session", "atum.mac.request", {"op": "location.current"}, 60
        )
    )["error"]


def test_shared_rooms_disable_mac_sources():
    assert "atum_mac" in server.SHARED_ROOM_DISABLED_TOOLSETS
