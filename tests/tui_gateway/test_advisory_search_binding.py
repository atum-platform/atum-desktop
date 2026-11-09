import json
from tui_gateway import desktop_ui_bridge, server, server_requests


def test_turn_budget_is_shared_by_parallel_requests_and_resets_next_turn(monkeypatch):
    session = {"running": True, "active_turn_id": "runtime-turn", "source": "desktop"}
    monkeypatch.setattr(server, "_sessions", {"live": session})
    sent = []
    monkeypatch.setitem(
        desktop_ui_bridge._SENDERS,
        "atum.advisory.search",
        lambda sid, body, timeout: sent.append(body) or {"value": '{"status":"empty"}'},
    )
    for _ in range(4):
        assert json.loads(desktop_ui_bridge._desktop_ui_request(
            "live", "atum.advisory.search.request", {"turn_id": "forged"}, 1))["status"] == "empty"
    assert json.loads(desktop_ui_bridge._desktop_ui_request(
        "live", "atum.advisory.search.request", {}, 1))["status"] == "limit"
    assert len(sent) == 4
    assert all(body["turn_id"] == "runtime-turn" for body in sent)
    session["active_turn_id"] = "next-turn"
    assert json.loads(desktop_ui_bridge._desktop_ui_request(
        "live", "atum.advisory.search.request", {}, 1))["status"] == "empty"


def test_cancelled_turn_does_not_receive_late_data(monkeypatch):
    session = {"running": True, "active_turn_id": "turn", "source": "desktop"}
    monkeypatch.setattr(server, "_sessions", {"live": session})
    def fetch(*args, **kwargs):
        session["running"] = False
        return {"value": '{"status":"ok","text":"late data"}'}
    monkeypatch.setitem(desktop_ui_bridge._SENDERS, "atum.advisory.search", fetch)
    result = desktop_ui_bridge._desktop_ui_request("live", "atum.advisory.search.request", {}, 1)
    assert "late data" not in result
    assert json.loads(result)["status"] == "unavailable"


def test_remote_reference_never_probes_local_profiles(monkeypatch):
    from tools import atum_advisory_search as search
    from tools import session_search_tool

    monkeypatch.setattr(
        session_search_tool,
        "_resolve_profile_db",
        lambda *a: (_ for _ in ()).throw(AssertionError("private profile opened")),
    )
    monkeypatch.setattr(desktop_ui_bridge, "_wired", True)
    monkeypatch.setattr("tools.desktop_ui.available", lambda: True)
    monkeypatch.setattr(
        "tools.desktop_ui.request",
        lambda *a, **k: '{"status":"ok","results":[]}',
    )
    for reference in ("atum-advisory:valid", "atum-advisory:bad/profile",
                      "other/atum-advisory:remote", "@session:atum-advisory:remote",
                      "ATUM-ADVISORY:x", "other/ATUM-ADVISORY:x"):
        result = search.search(reference=reference)
        assert result["status"] in {"ok", "denied"}


def test_main_scope_comes_from_live_profile_not_request_identity(monkeypatch, tmp_path):
    (tmp_path / "profile.yaml").write_text("identity_id: 00000000-0000-4000-8000-d9f59d29173c\n")
    session = {"running": True, "active_turn_id": "turn", "source": "desktop",
               "profile_home": str(tmp_path), "session_key": "durable"}
    monkeypatch.setattr(server, "_sessions", {"live": session})
    monkeypatch.setattr(server_requests, "_open", {})
    request = server_requests.ServerRequest("live", "atum.advisory.search", {"turn_id": "turn"})
    server_requests._register(request, lambda _frame: None)
    result = server.advisory_search_request_scope(request.id, "live", "turn")
    assert result["identity_id"] == "00000000-0000-4000-8000-d9f59d29173c"
    assert result["durable_session_id"] == "durable"
    assert server.advisory_search_request_scope(request.id, "other", "turn") is None
    assert server.advisory_search_request_scope(request.id, "live", "other") is None
    session["running"] = False
    assert server.advisory_search_request_scope(request.id, "live", "turn") is None


def test_non_desktop_source_cannot_request_advisory_history(monkeypatch):
    monkeypatch.setattr(server, "_sessions", {"live": {
        "running": True, "active_turn_id": "turn", "source": "cli",
    }})
    monkeypatch.setitem(
        desktop_ui_bridge._SENDERS,
        "atum.advisory.search",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("source contacted")),
    )
    assert json.loads(desktop_ui_bridge._desktop_ui_request(
        "live", "atum.advisory.search.request", {}, 1))["status"] == "unavailable"
