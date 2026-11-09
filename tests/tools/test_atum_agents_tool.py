import json

import pytest

from tools import desktop_ui
from tools.atum_agents_tool import ATUM_AGENTS_SCHEMA, atum_agents
from tools.registry import registry


def test_read_and_revision_fenced_update_use_the_host_without_role_claims(monkeypatch):
    calls = []
    receipt = {"originPrincipal": "00000000-0000-4000-8000-11e594f48195", "originIsMain": False,
               "profile": {"principal": "00000000-0000-4000-8000-11e594f48195"}}
    monkeypatch.setattr(desktop_ui, "request", lambda event, payload, timeout: calls.append((event, payload, timeout)) or json.dumps(receipt))
    assert json.loads(atum_agents("read")) == receipt
    atum_agents("update", expected_definition_revision=2, expected_identity_revision=3, soul="# Me")
    assert calls == [
        ("atum.agents.request", {"operation": "read"}, 30),
        ("atum.agents.request", {"operation": "update", "expectedDefinitionRevision": 2,
                                 "expectedIdentityRevision": 3, "soul": "# Me"}, 30),
    ]
    assert "role" not in ATUM_AGENTS_SCHEMA["parameters"]["properties"]


@pytest.mark.parametrize("kwargs", [
    {"operation": "other"},
    {"operation": "read", "target": "not-a-principal"},
    {"operation": "update", "expected_definition_revision": 1, "expected_identity_revision": 1},
    {"operation": "avatar"},
    {"operation": "avatar", "avatar_path": "x", "remove_avatar": True},
])
def test_invalid_request_never_contacts_host(monkeypatch, kwargs):
    monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: pytest.fail("host contacted"))
    assert "error" in json.loads(atum_agents(**kwargs))


def test_host_failure_is_not_reported_as_an_empty_roster(monkeypatch):
    monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: None)
    assert "error" in json.loads(atum_agents("list"))


def test_registry_list_drops_irrelevant_all_fields_values(monkeypatch):
    calls = []
    monkeypatch.setattr(
        desktop_ui,
        "request",
        lambda event, payload, timeout: calls.append((event, payload, timeout))
        or '{"agents":[]}',
    )

    result = registry.dispatch(
        "atum_agents",
        {
            "operation": "list",
            "target": "placeholder",
            "expected_definition_revision": 0,
            "expected_identity_revision": 1,
            "display_name": "placeholder",
            "soul": "placeholder",
            "avatar_path": "placeholder",
            "remove_avatar": True,
        },
    )

    assert json.loads(result) == {"agents": []}
    assert calls == [("atum.agents.request", {"operation": "list"}, 30)]


# ── Conversational rename: the person says what to call the assistant, the assistant renames
# itself through this same tool (read, then one revision-fenced update with only display_name).

MAIN = "00000000-0000-4000-8000-11e594f48195"


def _profile(name, definition=7, identity=3):
    return {"originPrincipal": MAIN, "originIsMain": True,
            "profile": {"principal": MAIN, "displayName": name, "isMain": True, "definitionRevision": definition,
                        "identityRevision": identity, "avatarUrl": None, "soul": ""}}


def test_a_rename_is_one_read_then_one_update_that_carries_only_the_name(monkeypatch):
    calls = []

    def host(event, payload, timeout):
        calls.append((event, payload))
        return json.dumps(_profile("Atum Bot") if payload["operation"] == "read" else _profile("Bông", 8, 4))

    monkeypatch.setattr(desktop_ui, "request", host)
    read = json.loads(atum_agents("read"))["profile"]
    renamed = json.loads(atum_agents(
        "update", expected_definition_revision=read["definitionRevision"],
        expected_identity_revision=read["identityRevision"], display_name="Bông"))

    assert renamed["profile"]["displayName"] == "Bông"
    assert calls == [
        ("atum.agents.request", {"operation": "read"}),
        # No target (itself), no soul, no avatar: nothing but the name changes, fenced by both revisions.
        ("atum.agents.request", {"operation": "update", "expectedDefinitionRevision": 7,
                                 "expectedIdentityRevision": 3, "displayName": "Bông"}),
    ]


@pytest.mark.parametrize("code", ["reserved", "duplicate", "invalid", "locked", "conflict", "denied", "missing",
                                  "offline", "unavailable"])
def test_every_closed_refusal_keeps_its_code_and_says_what_to_tell_the_person(monkeypatch, code):
    monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: json.dumps({"error": code}))
    refused = json.loads(atum_agents("update", expected_definition_revision=1, expected_identity_revision=1,
                                     display_name="Atum"))

    assert refused["error"] == code
    assert refused["hint"].strip()
    # The hint says what to do next in plain words; it never leaks a rule list or an internal name.
    assert "assistant_name" not in refused["hint"] and "SQL" not in refused["hint"]


def test_a_refused_name_asks_for_another_and_a_conflict_asks_for_a_fresh_read(monkeypatch):
    def refuse(code):
        monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: json.dumps({"error": code}))
        return json.loads(atum_agents("update", expected_definition_revision=1, expected_identity_revision=1,
                                      display_name="x"))["hint"].lower()

    for code in ("reserved", "duplicate", "invalid"):
        assert "different" in refuse(code) or "another" in refuse(code) or "simpler" in refuse(code)
    assert "read it again" in refuse("conflict")


def test_a_code_the_host_never_sends_is_passed_on_bare(monkeypatch):
    monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: json.dumps({"error": "something_new"}))
    assert json.loads(atum_agents("read")) == {"error": "something_new"}


def test_a_rename_without_the_revisions_never_reaches_the_host(monkeypatch):
    monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: pytest.fail("host contacted"))
    for kwargs in ({"expected_identity_revision": 1}, {"expected_definition_revision": 1},
                   {"expected_definition_revision": -1, "expected_identity_revision": 1},
                   {"expected_definition_revision": 1, "expected_identity_revision": 0}):
        assert "error" in json.loads(atum_agents("update", display_name="Bông", **kwargs))


def test_the_host_not_answering_leaves_the_name_alone_and_says_so(monkeypatch):
    # "" is the gateway's way of saying the turn ended or timed out before the host answered.
    monkeypatch.setattr(desktop_ui, "request", lambda *_a, **_kw: "")
    refused = json.loads(atum_agents("update", expected_definition_revision=1, expected_identity_revision=1,
                                     display_name="Bông"))
    assert "did not confirm" in refused["error"]
