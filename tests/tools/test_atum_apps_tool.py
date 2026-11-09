import json

from tools import desktop_ui
from tools.atum_apps_tool import ATUM_APPS_SCHEMA, atum_apps


APPS = [
    {
        "id": "moon",
        "name": "Moon",
        "description": {"vi": "Chiêm tinh", "en": "Astrology"},
        "availability": "available",
    }
]


def test_list_returns_only_catalog_metadata(monkeypatch):
    monkeypatch.setattr(desktop_ui, "request", lambda *args, **kwargs: json.dumps({"apps": APPS}))

    assert json.loads(atum_apps("list")) == {"apps": APPS}


def test_open_validates_id_before_requesting_switch(monkeypatch):
    called = []
    monkeypatch.setattr(desktop_ui, "request", lambda *args, **kwargs: called.append((args, kwargs)))

    result = json.loads(atum_apps("open", "unknown"))

    assert result["error"]
    assert len(called) == 1
    assert called[0][0][0] == "atum.apps.list.request"


def test_open_returns_only_switch_confirmation(monkeypatch):
    responses = iter((json.dumps({"apps": APPS}), json.dumps({"switched": True})))
    monkeypatch.setattr(
        desktop_ui,
        "request",
        lambda event, payload, timeout: next(responses),
    )

    assert json.loads(atum_apps("open", "moon")) == {
        "switched": True,
        "app": {"id": "moon", "name": "Moon"},
    }


def test_list_surfaces_desktop_catalog_failure(monkeypatch):
    monkeypatch.setattr(desktop_ui, "request", lambda *args, **kwargs: json.dumps({"error": "account changed"}))

    assert "account changed" in json.loads(atum_apps("list"))["error"]


def test_invalid_operation_does_not_request_catalog(monkeypatch):
    called = []
    monkeypatch.setattr(desktop_ui, "request", lambda *args, **kwargs: called.append((args, kwargs)))

    assert json.loads(atum_apps("content"))["error"]
    assert called == []


def test_tool_surface_has_no_content_operation():
    operation = ATUM_APPS_SCHEMA["parameters"]["properties"]["operation"]

    assert operation["enum"] == ["list", "open"]
    assert not any(
        token in json.dumps(ATUM_APPS_SCHEMA).lower()
        for token in ("fetch", "history", "artifact", "message_content", "panel_target")
    )


def test_app_search_stays_local_and_matches_vietnamese(monkeypatch):
    calls = []
    monkeypatch.setattr(desktop_ui, "request", lambda event, payload, timeout: calls.append(payload) or json.dumps({"apps": APPS}))
    assert json.loads(atum_apps("list", query="chiem tinh")) == {"apps": APPS}
    assert calls == [{}]


def test_cloud_destination_does_not_claim_a_switch(monkeypatch):
    destination = {"switched": False, "destination": {"surface": "discover", "shelf": "apps", "appId": "moon"}}
    responses = iter((json.dumps({"apps": APPS}), json.dumps(destination)))
    monkeypatch.setattr(desktop_ui, "request", lambda *a, **kw: next(responses))
    assert json.loads(atum_apps("open", "moon")) == destination


def test_catalog_strips_non_listing_fields_before_filtering_or_returning(monkeypatch):
    monkeypatch.setattr(desktop_ui, "request", lambda *a, **kw: json.dumps({"apps": [{**APPS[0], "privateContent": "secret-marker"}]}))
    assert json.loads(atum_apps("list")) == {"apps": APPS}
    assert json.loads(atum_apps("list", query="secret-marker")) == {"apps": []}
