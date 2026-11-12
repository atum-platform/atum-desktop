"""Behaviour contracts for O1 on the native profile tool/control bridge."""
import copy
import hashlib
import json

import pytest

from tools import desktop_ui
from tools.atum_agents_tool import ATUM_AGENTS_SCHEMA, atum_agents
from tools.registry import registry

TARGET = "00000000-0000-4000-8000-0000000000a1"
REQUEST = "00000000-0000-4000-8000-0000000000a2"
DEFINITION = {"schema_version": 1, "soul": "Research", "model_alias": "binh-minh", "reasoning": None, "skills": []}
PROFILE = {"principal": TARGET, "displayName": "Research", "isMain": False,
           "definitionRevision": 2, "identityRevision": 1, "avatarUrl": None, "soul": "Research"}
FENCE = {"target": TARGET, "expected_definition_revision": 0, "expected_identity_revision": 1}
CASES = [
    ("create", {"request_id": REQUEST, "display_name": "Research", "definition": DEFINITION},
     {"requestId": REQUEST, "displayName": "Research", "definition": DEFINITION}),
    ("set_model", {**FENCE, "model_alias": "nguyet-thuc"},
     {"target": TARGET, "expectedDefinitionRevision": 0, "expectedIdentityRevision": 1, "modelAlias": "nguyet-thuc"}),
    ("set_skills", {**FENCE, "skills": [{"name": "research/report", "sha256": "a" * 64}]},
     {"target": TARGET, "expectedDefinitionRevision": 0, "expectedIdentityRevision": 1, "skills": [{"name": "research/report", "sha256": "a" * 64}]}),
    ("set_tools", {**FENCE, "tools": []},
     {"target": TARGET, "expectedDefinitionRevision": 0, "expectedIdentityRevision": 1, "tools": []}),
    ("propose_retire", {**FENCE, "request_id": REQUEST},
     {"target": TARGET, "expectedDefinitionRevision": 0, "expectedIdentityRevision": 1, "requestId": REQUEST}),
    ("propose_hire", {"request_id": REQUEST, "offer_id": TARGET, "offer_version": 1},
     {"requestId": REQUEST, "offerId": TARGET, "offerVersion": 1}),
]


@pytest.fixture
def host(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    calls = []
    response = {"value": {"error": "unavailable"}}

    def handle(sid, event, payload, timeout):
        calls.append((event, copy.deepcopy(payload), timeout))
        return json.dumps(response["value"])

    desktop_ui.set_requester(handle)
    try:
        yield calls, response
    finally:
        desktop_ui.set_requester(None)


@pytest.mark.parametrize("operation,args,wire", CASES)
def test_semantic_operations_use_existing_bridge_and_keep_switch_off(host, operation, args, wire):
    calls, _ = host
    result = json.loads(registry.dispatch("atum_agents", {"operation": operation, **args}))
    assert result["error"] == "unavailable"
    assert calls == [("atum.agents.request", {"operation": operation, **wire}, 30)]
    assert json.loads(atum_agents(operation, **args))["error"] == "unavailable"


@pytest.mark.parametrize("authority", ["runId", "run_id", "owner", "role", "confirmed", "hireConfirmed", "sessionToken", "proposalId"])
def test_agent_cannot_supply_authority_or_consume_proposal(host, authority):
    calls, _ = host
    assert json.loads(registry.dispatch("atum_agents", {"operation": "propose_retire", **FENCE,
        "request_id": REQUEST, authority: True}))["error"] == "invalid"
    assert calls == []


@pytest.mark.parametrize("operation,args", [
    ("create", {"request_id": REQUEST, "display_name": "x", "definition": {**DEFINITION, "reasoning": {"enabled": True, "effort": None}}}),
    ("create", {"request_id": REQUEST, "display_name": "x", "definition": {**DEFINITION, "owner": TARGET}}),
    ("create", {"request_id": REQUEST, "display_name": "x" * 41, "definition": DEFINITION}),
    ("set_model", {**FENCE, "model_alias": "arbitrary-provider"}),
    ("set_model", {**FENCE, "target": "self", "model_alias": "binh-minh"}),
    ("set_model", {**FENCE, "expected_definition_revision": True, "model_alias": "binh-minh"}),
    ("set_skills", {**FENCE, "skills": [{"name": "../secret", "sha256": "a" * 64}]}),
    ("set_skills", {**FENCE, "skills": [{"name": "x", "sha256": "a" * 64}] * 2}),
    ("set_tools", {**FENCE, "tools": ["../shell"]}),
    ("set_tools", {**FENCE, "tools": ["shell"] * 129}),
    ("propose_hire", {"request_id": REQUEST, "offer_id": TARGET, "offer_version": 0}),
    ("propose_retire", FENCE),
])
def test_invalid_management_never_contacts_host(host, operation, args):
    calls, _ = host
    assert json.loads(registry.dispatch("atum_agents", {"operation": operation, **args}))["error"] == "invalid"
    assert calls == []


def test_proposal_reference_is_not_consent_or_completion(host):
    calls, response = host
    response["value"] = {"status": "confirmation_required", "proposalId": REQUEST}
    for _ in range(2):
        assert json.loads(atum_agents("propose_retire", **FENCE, request_id=REQUEST)) == response["value"]
    assert calls[0] == calls[1]  # Same idempotency key; no confirm call.
    response["value"]["quote"] = {"amountMicroProtons": 60000000000}
    assert json.loads(atum_agents("propose_retire", **FENCE, request_id=REQUEST))["error"] == "unavailable"


@pytest.mark.parametrize("code", ["run_denied", "quota", "awaiting_funds", "terms_changed", "expired", "confirmation_required"])
def test_closed_lifecycle_errors_never_gain_completion_or_metadata(host, code):
    _, response = host
    response["value"] = {"error": code, "creation": {"username": "host-private"}}
    result = json.loads(atum_agents("create", **CASES[0][1]))
    assert result["error"] == code and result["hint"]
    assert "host-private" not in json.dumps(result)


@pytest.mark.parametrize("receipt", [None, {}, [], {"status": "provisioning", "requestId": REQUEST, "creation": {"username": "private"}},
    {"status": "finished", "creation": {"username": "private"}},
    {"status": "updated", "effective": "next_turn", "profile": PROFILE, "runId": REQUEST}])
def test_host_only_or_malformed_receipts_fail_closed(host, receipt):
    _, response = host
    response["value"] = receipt
    result = json.loads(atum_agents("set_model", **CASES[1][1]))
    assert result["error"] == "unavailable"
    assert "private" not in json.dumps(result)


def test_completed_create_requires_host_projection(host):
    _, response = host
    response["value"] = {"status": "finished", "profile": PROFILE}
    assert json.loads(atum_agents("create", **CASES[0][1])) == response["value"]


def test_setting_changes_preserve_schema_and_apply_only_at_contract_boundary(host):
    _, response = host
    schema_before = hashlib.sha256(json.dumps(ATUM_AGENTS_SCHEMA, sort_keys=True).encode()).digest()
    for operation, args, _ in CASES[1:4]:
        effective = "next_turn" if operation == "set_model" else "next_session"
        response["value"] = {"status": "updated", "effective": effective, "profile": PROFILE}
        assert json.loads(atum_agents(operation, **args)) == response["value"]
        response["value"]["effective"] = "immediate"
        assert json.loads(atum_agents(operation, **args))["error"] == "unavailable"
    assert hashlib.sha256(json.dumps(ATUM_AGENTS_SCHEMA, sort_keys=True).encode()).digest() == schema_before


def test_no_bridge_is_unavailable_and_no_schema_description_names_other_tools():
    desktop_ui.set_requester(None)
    assert json.loads(atum_agents("create", **CASES[0][1]))["error"] == "unavailable"
    descriptions = []

    def walk(value):
        if isinstance(value, dict):
            descriptions.extend([value["description"]] if "description" in value else [])
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(ATUM_AGENTS_SCHEMA)
    for name in ("atum_agent_tasks", "terminal", "web_search", "read_file"):
        assert all(name not in description for description in descriptions)
