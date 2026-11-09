"""Behavioral tests for the frozen-v1 Atum awareness wire parser."""

from __future__ import annotations

from copy import deepcopy

import pytest

from agent.atum_awareness_contract import (
    AwarenessContractError,
    validate_audience,
    validate_recall_args,
    validate_retrieval_response,
)


REQUEST_ID = "00000000-0000-1000-8000-986c0dc956dc"
AGENT_ID = "00000000-0000-1000-8000-d48df04d882b"
EVIDENCE_ID = "00000000-0000-1000-8000-fb62ead39108"
ROOM_ID = "!room:example.org"


def _request(audience: dict | None = None, *, max_items: int = 20, max_content_bytes: int = 32768) -> dict:
    return {
        "requestId": REQUEST_ID,
        "audience": audience or {"class": "private_owner"},
        "agentPrincipal": AGENT_ID,
        "query": "current plan",
        "limits": {"maxItems": max_items, "maxContentBytes": max_content_bytes},
        "filters": {"sourceKinds": ["owner_statement"], "since": 3, "until": 4},
    }


def _item(*, scope: dict | None = None, citation: dict | None = None, provenance: bool = False) -> dict:
    item = {
        "evidenceId": EVIDENCE_ID,
        "source": {"kind": "owner_statement", "id": "owner-1", "agentPrincipal": AGENT_ID},
        "object": {"kind": "message", "id": "message-1", "revision": 1},
        "author": {"kind": "owner", "id": "owner-1"},
        "eventTime": 3,
        "observedTime": 4,
        "policyEpoch": 1,
        "scope": scope or {"kind": "private"},
        "epistemic": "statement",
        "derivation": {
            "parents": [],
            "sourceRefs": [{"kind": "message", "id": "message-0", "revision": 1}],
        },
        "digest": "a" * 64,
        "citation": citation or {"kind": "memory", "agentPrincipal": AGENT_ID, "revision": 1},
        "content": "é",
        "untrustedInput": True,
    }
    if provenance:
        item["provenance"] = {"google": True}
    return item


def _response(request: dict, *, status: str = "ok", items: list[dict] | None = None, content_bytes: int = 2) -> dict:
    return {
        "requestId": request["requestId"],
        "audience": deepcopy(request["audience"]),
        "status": status,
        "items": [_item()] if items is None else items,
        "coverage": {
            "source": {"kind": "owner_statement", "id": "owner-1"},
            "state": "ready",
            "reasons": [],
            "asOf": 4,
        },
        "contentBytes": content_bytes,
    }


def _with_coverage_list(response: dict) -> dict:
    response["coverage"] = [response["coverage"]]
    return response


def _assert_rejected(callable_, *args) -> None:
    with pytest.raises(AwarenessContractError) as caught:
        callable_(*args)
    assert str(caught.value) == "invalid awareness contract"


def test_recall_arguments_allow_only_narrowing_filters_and_are_copied():
    source = {"query": "find é", "limit": 2, "filters": {"sourceKinds": ["human_dm"], "since": 2, "until": 2}}

    parsed = validate_recall_args(source)

    assert parsed == source
    assert parsed is not source
    assert parsed["filters"] is not source["filters"]
    source["filters"]["sourceKinds"].append("owner_statement")
    assert parsed["filters"]["sourceKinds"] == ["human_dm"]


@pytest.mark.parametrize(
    "value",
    [
        {"query": "ok", "limit": True},
        {"query": "ok", "filters": {"since": 9, "until": 8}},
        {"query": "ok", "filters": {"sourceKinds": ["human_dm", "human_dm"]}},
        {"query": "\ud800"},
        {"query": "ok", "extra": "not allowed"},
    ],
)
def test_recall_arguments_reject_non_wire_and_non_narrowing_values(value):
    _assert_rejected(validate_recall_args, value)


@pytest.mark.parametrize(
    "value",
    [
        {"class": "private_owner", "roomId": ROOM_ID},
        {"class": "shared_room", "roomId": " room"},
        {"class": "partner", "roomId": ROOM_ID, "appId": AGENT_ID.upper()},
        {"class": "public"},
    ],
)
def test_audience_variants_are_exact_and_lowercase(value):
    _assert_rejected(validate_audience, value)


def test_all_wire_branch_discriminators_reject_non_string_values_with_closed_error():
    _assert_rejected(validate_audience, {"class": []})

    request = _request()
    unhashable_status = _with_coverage_list(_response(request))
    unhashable_status["status"] = []
    _assert_rejected(validate_retrieval_response, unhashable_status, request)

    invalid_scope = _with_coverage_list(_response(request, items=[_item(scope={"kind": []})]))
    _assert_rejected(validate_retrieval_response, invalid_scope, request)

    invalid_citation = _with_coverage_list(_response(request, items=[_item(citation={"kind": []})]))
    _assert_rejected(validate_retrieval_response, invalid_citation, request)


def test_private_response_validates_utf8_accounting_and_deep_copies_google_provenance():
    request = _request(max_content_bytes=2)
    source = _with_coverage_list(_response(request, items=[_item(provenance=True)]))

    parsed = validate_retrieval_response(source, request)

    assert parsed == source
    assert parsed is not source
    assert parsed["items"][0] is not source["items"][0]
    source["items"][0]["provenance"]["google"] = False
    assert parsed["items"][0]["provenance"] == {"google": True}


def test_shared_response_requires_room_scoped_evidence_and_matrix_citations():
    audience = {"class": "shared_room", "roomId": ROOM_ID}
    request = _request(audience)
    good_item = _item(
        scope={"kind": "room", "roomId": ROOM_ID},
        citation={"kind": "matrix_event", "roomId": ROOM_ID, "eventId": "$event:example.org"},
    )
    parsed = validate_retrieval_response(_with_coverage_list(_response(request, items=[good_item])), request)
    assert parsed["items"][0]["scope"]["roomId"] == ROOM_ID

    private_scope = deepcopy(good_item)
    private_scope["scope"] = {"kind": "private"}
    _assert_rejected(validate_retrieval_response, _with_coverage_list(_response(request, items=[private_scope])), request)

    cross_room = deepcopy(good_item)
    cross_room["citation"]["roomId"] = "!other:example.org"
    _assert_rejected(validate_retrieval_response, _with_coverage_list(_response(request, items=[cross_room])), request)

    google_item = deepcopy(good_item)
    google_item["provenance"] = {"google": True}
    _assert_rejected(validate_retrieval_response, _with_coverage_list(_response(request, items=[google_item])), request)


def test_response_binds_identity_and_requested_item_and_content_bounds():
    request = _request(max_items=1, max_content_bytes=2)
    source = _with_coverage_list(_response(request))
    source["requestId"] = EVIDENCE_ID
    _assert_rejected(validate_retrieval_response, source, request)

    too_many = _with_coverage_list(_response(request, items=[_item(), _item()]))
    too_many["contentBytes"] = 4
    _assert_rejected(validate_retrieval_response, too_many, request)

    wrong_bytes = _with_coverage_list(_response(request, content_bytes=1))
    _assert_rejected(validate_retrieval_response, wrong_bytes, request)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda request: request.update(agentPrincipal=AGENT_ID.upper()),
        lambda request: request.update(query=""),
        lambda request: request["limits"].update(maxItems=True),
        lambda request: request["limits"].update(maxContentBytes=32769),
        lambda request: request["filters"].update(since=5, until=4),
        lambda request: request["audience"].update(extra="not allowed"),
    ],
)
def test_response_rejects_malformed_full_request_before_matching_response(mutate):
    request = _request()
    unavailable = {
        "requestId": REQUEST_ID,
        "audience": {"class": "private_owner"},
        "status": "unavailable",
        "items": [],
        "coverage": [],
        "contentBytes": 0,
        "errors": ["timeout"],
    }
    malformed_request = deepcopy(request)
    mutate(malformed_request)

    _assert_rejected(validate_retrieval_response, unavailable, malformed_request)


def test_unavailable_requires_no_items_zero_bytes_and_known_errors():
    request = _request()
    unavailable = {
        "requestId": REQUEST_ID,
        "audience": {"class": "private_owner"},
        "status": "unavailable",
        "items": [],
        "coverage": [],
        "contentBytes": 0,
        "errors": ["timeout", "service_unavailable"],
    }
    parsed = validate_retrieval_response(unavailable, request)
    assert parsed == unavailable

    with_item = deepcopy(unavailable)
    with_item["items"] = [_item()]
    _assert_rejected(validate_retrieval_response, with_item, request)

    unknown_error = deepcopy(unavailable)
    unknown_error["errors"] = ["outage"]
    _assert_rejected(validate_retrieval_response, unknown_error, request)

    boolean_bytes = deepcopy(unavailable)
    boolean_bytes["contentBytes"] = False
    _assert_rejected(validate_retrieval_response, boolean_bytes, request)
