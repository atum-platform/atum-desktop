"""The dormant Drive fetch bridge stamps live-turn authority in the gateway."""

from __future__ import annotations

import json
from tui_gateway import desktop_ui_bridge, server


def test_workspace_fetch_request_forwards_only_path_under_the_live_matrix_turn(monkeypatch):
    seen = {}
    server._sessions["workspace-session"] = {
        "running": True,
        "active_turn_id": "turn-1",
        "source": "matrix",
    }

    def send(sid, payload, timeout):
        seen.update(sid=sid, payload=payload, timeout=timeout)
        return {"value": json.dumps({"outcome": "fetched", "path": payload["path"]})}

    monkeypatch.setitem(desktop_ui_bridge._SENDERS, "atum.workspace.fetch", send)
    try:
        result = json.loads(desktop_ui_bridge._desktop_ui_request(
            "workspace-session",
            "atum.workspace.fetch.request",
            {"path": "reports/old.md", "destination": "reports/old.md", "owner": "forged", "credential": "forged"},
            300,
        ))
        assert result == {"outcome": "fetched", "path": "reports/old.md"}
        assert seen == {
            "sid": "workspace-session",
            "payload": {"path": "reports/old.md", "destination": "reports/old.md", "turn_id": "turn-1"},
            "timeout": 120,
        }
    finally:
        server._sessions.pop("workspace-session", None)


def test_workspace_fetch_request_refuses_invalid_scope_without_blocking(monkeypatch):
    send = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not send"))
    monkeypatch.setitem(desktop_ui_bridge._SENDERS, "atum.workspace.fetch", send)
    assert "live Matrix agent turn" in json.loads(desktop_ui_bridge._desktop_ui_request(
        "missing", "atum.workspace.fetch.request", {"path": "a.md"}, 30))["error"]
    for unavailable in (
        {"running": False, "active_turn_id": "turn-1", "source": "matrix"},
        {"running": True, "active_turn_id": "", "source": "matrix"},
        {"running": True, "active_turn_id": "turn-1", "source": "desktop"},
    ):
        server._sessions["workspace-session"] = unavailable
        assert "live Matrix agent turn" in json.loads(desktop_ui_bridge._desktop_ui_request(
            "workspace-session", "atum.workspace.fetch.request", {"path": "a.md"}, 30
        ))["error"]
    server._sessions["workspace-session"] = {"running": True, "active_turn_id": "turn-1", "source": "matrix"}
    try:
        for path in (
            "x" * 1025,
            "../escape",
            "a/../../b",
            "/absolute",
            "dir/",
            "a\\b",
            "a//b",
            "a/./b",
            "a/\x00b",
            "/".join(["deep"] * 17),
            "\ud800",
        ):
            assert json.loads(desktop_ui_bridge._desktop_ui_request(
                "workspace-session", "atum.workspace.fetch.request", {"path": path}, 30
            )) == {"outcome": "refused", "reason": "invalid"}
        assert json.loads(desktop_ui_bridge._desktop_ui_request(
            "workspace-session",
            "atum.workspace.fetch.request",
            {"path": "valid.md", "destination": "../escape"},
            30,
        )) == {"outcome": "refused", "reason": "invalid"}
    finally:
        server._sessions.pop("workspace-session", None)


def test_workspace_fetch_request_refuses_result_after_live_scope_changes(monkeypatch):
    session = {
        "running": True,
        "active_turn_id": "turn-1",
        "source": "matrix",
    }
    monkeypatch.setattr(server, "_sessions", {"workspace-session": session})

    for changed in (
        {"active_turn_id": "turn-2"},
        {"running": False},
    ):
        session.update(running=True, active_turn_id="turn-1")

        def change_scope(_sid, _payload, timeout):
            assert timeout == 30
            session.update(changed)
            return {"value": json.dumps({"outcome": "fetched", "path": "reports/old.md"})}

        monkeypatch.setitem(desktop_ui_bridge._SENDERS, "atum.workspace.fetch", change_scope)
        result = desktop_ui_bridge._desktop_ui_request(
            "workspace-session",
            "atum.workspace.fetch.request",
            {"path": "reports/old.md"},
            30,
        )

        assert "turn ended" in json.loads(result)["error"]


def test_workspace_fetch_response_size_is_bounded(monkeypatch):
    monkeypatch.setattr(
        server,
        "_sessions",
        {
            "workspace-session": {
                "running": True,
                "active_turn_id": "turn-1",
                "source": "matrix",
            }
        },
    )
    monkeypatch.setitem(
        desktop_ui_bridge._SENDERS,
        "atum.workspace.fetch",
        lambda *_args, **_kwargs: {"value": "x" * (desktop_ui_bridge._MAX_ANSWER_CHARS + 1)},
    )

    result = desktop_ui_bridge._desktop_ui_request(
        "workspace-session",
        "atum.workspace.fetch.request",
        {"path": "reports/old.md"},
        30,
    )

    assert "response was too large" in json.loads(result)["error"]
