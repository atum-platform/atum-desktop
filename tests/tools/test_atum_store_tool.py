import json

import pytest

from tools import desktop_ui
from tools.atum_store_tool import ATUM_STORE_SCHEMA, atum_store
from tools.registry import registry


def test_search_uses_host_catalog_without_authority_or_acquisition(monkeypatch):
    calls = []
    result = {"items": [{"itemId": "skill/focus", "offer": None}], "totalMatches": 1, "hasMore": False}
    monkeypatch.setattr(desktop_ui, "request", lambda event, payload, timeout: calls.append((event, payload, timeout)) or json.dumps(result))
    assert json.loads(atum_store(query="focus", kind="skill")) == result
    assert calls == [("atum.store.request", {"operation": "search", "query": "focus", "limit": 10, "kind": "skill"}, 30)]
    assert ATUM_STORE_SCHEMA["parameters"]["properties"]["operation"]["enum"] == ["search", "inspect"]


@pytest.mark.parametrize("args", [{"operation": []}, {"kind": {}}, {"query": "x" * 201}, {"limit": True},
                                  {"limit": 21}, {"operation": "inspect"}, {"item_id": []}, {"operation": "buy"}])
def test_invalid_input_never_contacts_host(monkeypatch, args):
    monkeypatch.setattr(desktop_ui, "request", lambda *a, **kw: pytest.fail("host contacted"))
    assert "error" in json.loads(atum_store(**args))


@pytest.mark.parametrize("receipt", [None, "", "oops", "[]", '{}', '{"error":"account changed"}'])
def test_unavailable_is_not_an_empty_catalog(monkeypatch, receipt):
    monkeypatch.setattr(desktop_ui, "request", lambda *a, **kw: receipt)
    assert "error" in json.loads(atum_store())


def test_empty_catalog_is_a_success(monkeypatch):
    monkeypatch.setattr(desktop_ui, "request", lambda *a, **kw: '{"items":[],"totalMatches":0,"hasMore":false}')
    assert json.loads(atum_store())["items"] == []


def test_inspect_drops_search_fields_and_forged_extra_keys(monkeypatch):
    calls = []
    monkeypatch.setattr(desktop_ui, "request", lambda event, payload, timeout: calls.append(payload) or '{"items":[]}')
    result = registry.dispatch("atum_store", {"operation": "inspect", "item_id": "skill/focus", "limit": 20,
                                              "kind": "skill", "owner": "forged", "url": "https://bad.test"})
    assert json.loads(result)["items"] == []
    assert calls == [{"operation": "inspect", "itemId": "skill/focus"}]


def test_catalog_content_does_not_change_tool_schema(monkeypatch):
    before = json.dumps(registry.get_schema("atum_store"), sort_keys=True)
    for items in ([], [{"itemId": "skill/focus"}], [{"itemId": "agent/other", "title": "new listing"}]):
        monkeypatch.setattr(desktop_ui, "request", lambda *a, **kw: json.dumps({"items": items}))
        atum_store()
        assert json.dumps(registry.get_schema("atum_store"), sort_keys=True) == before
