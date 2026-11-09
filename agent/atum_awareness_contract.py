"""Frozen-v1 wire validation for the bounded Atum recall consumer.

This module intentionally implements only the three fixed messages used by the
consumer.  It is not a general schema engine: every accepted field is rebuilt
explicitly so callers never receive unvalidated wire objects.
"""

from __future__ import annotations

import re
from typing import NoReturn


class AwarenessContractError(ValueError):
    """Content-free failure raised for every invalid awareness wire value."""

    def __init__(self) -> None:
        super().__init__("invalid awareness contract")


_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_SOURCE_KINDS = frozenset(
    {
        "assistant_chat",
        "human_dm",
        "human_group",
        "app_exchange",
        "drive_file",
        "native_memory",
        "owner_statement",
    }
)
_OBJECT_KINDS = frozenset({"message", "edit", "redaction", "file_version", "memory_revision"})
_AUTHOR_KINDS = frozenset({"owner", "human", "agent", "app"})
_EPISTEMIC = frozenset(
    {
        "statement",
        "question",
        "quotation",
        "proposal",
        "decision",
        "commitment",
        "correction",
        "unknown",
    }
)
_COVERAGE_REASONS = frozenset(
    {
        "google_fence",
        "cloud_access_ended",
        "owner_paused",
        "keys_missing",
        "backfill_pending",
        "unsupported_media",
        "service_unavailable",
        "device_offline",
        "excluded_by_owner",
        "temporary_conversation",
    }
)
_COVERAGE_NON_READY = frozenset(
    {"catching_up", "partial", "offline", "excluded", "needs_keys", "paused", "error"}
)
_UNAVAILABLE_ERRORS = frozenset(
    {"service_unavailable", "index_unavailable", "model_unavailable", "key_unavailable", "timeout"}
)


def _fail() -> NoReturn:
    raise AwarenessContractError()


def _object(value: object) -> dict:
    if type(value) is not dict:
        _fail()
    return value


def _list(value: object) -> list:
    if type(value) is not list:
        _fail()
    return value


def _string(value: object, *, minimum: int = 0, maximum: int) -> str:
    if type(value) is not str or not minimum <= len(value) <= maximum:
        _fail()
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        _fail()
    return value


def _integer(value: object, *, minimum: int, maximum: int = _MAX_SAFE_INTEGER) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        _fail()
    return value


def _exact_keys(value: object, required: set[str], optional: set[str] | None = None) -> dict:
    parsed = _object(value)
    allowed = required | (optional or set())
    if set(parsed) != allowed and not (required <= set(parsed) <= allowed):
        _fail()
    return parsed


def _uuid(value: object) -> str:
    parsed = _string(value, maximum=36)
    if not _UUID.fullmatch(parsed):
        _fail()
    return parsed


def _sha256(value: object) -> str:
    parsed = _string(value, maximum=64)
    if not _SHA256.fullmatch(parsed):
        _fail()
    return parsed


def _ascii_ref(value: object) -> str:
    parsed = _string(value, minimum=1, maximum=1024)
    if any(ord(char) < 33 or ord(char) > 126 for char in parsed):
        _fail()
    return parsed


def _room_id(value: object) -> str:
    parsed = _string(value, minimum=2, maximum=1024)
    if not parsed.startswith("!") or any(ord(char) < 33 or ord(char) > 126 for char in parsed[1:]):
        _fail()
    return parsed


def _event_id(value: object) -> str:
    parsed = _string(value, minimum=2, maximum=1024)
    if not parsed.startswith("$") or any(ord(char) < 33 or ord(char) > 126 for char in parsed[1:]):
        _fail()
    return parsed


def _timestamp(value: object) -> int:
    return _integer(value, minimum=0)


def _utf8_length(value: str) -> int:
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError:
        _fail()


def _source_ref(value: object) -> dict:
    parsed = _exact_keys(value, {"kind", "id"}, {"agentPrincipal"})
    kind = _string(parsed["kind"], minimum=1, maximum=32)
    if kind not in _SOURCE_KINDS:
        _fail()
    normalized = {"kind": kind, "id": _ascii_ref(parsed["id"])}
    if "agentPrincipal" in parsed:
        normalized["agentPrincipal"] = _uuid(parsed["agentPrincipal"])
    return normalized


def _object_ref(value: object) -> dict:
    parsed = _exact_keys(value, {"kind", "id", "revision"})
    kind = _string(parsed["kind"], minimum=1, maximum=32)
    if kind not in _OBJECT_KINDS:
        _fail()
    return {
        "kind": kind,
        "id": _ascii_ref(parsed["id"]),
        "revision": _integer(parsed["revision"], minimum=1),
    }


def _author(value: object) -> dict:
    parsed = _exact_keys(value, {"kind", "id"})
    kind = _string(parsed["kind"], minimum=1, maximum=16)
    if kind not in _AUTHOR_KINDS:
        _fail()
    return {"kind": kind, "id": _ascii_ref(parsed["id"])}


def _filters(value: object) -> dict:
    parsed = _exact_keys(value, set(), {"sourceKinds", "since", "until"})
    normalized: dict = {}
    if "sourceKinds" in parsed:
        source_kinds = _list(parsed["sourceKinds"])
        if not 1 <= len(source_kinds) <= 7:
            _fail()
        result: list[str] = []
        for source_kind in source_kinds:
            parsed_kind = _string(source_kind, minimum=1, maximum=32)
            if parsed_kind not in _SOURCE_KINDS or parsed_kind in result:
                _fail()
            result.append(parsed_kind)
        normalized["sourceKinds"] = result
    if "since" in parsed:
        normalized["since"] = _timestamp(parsed["since"])
    if "until" in parsed:
        normalized["until"] = _timestamp(parsed["until"])
    if "since" in normalized and "until" in normalized and normalized["since"] > normalized["until"]:
        _fail()
    return normalized


def validate_recall_args(value: object) -> dict:
    """Validate model-selected recall arguments and rebuild their fixed shape."""
    parsed = _exact_keys(value, {"query"}, {"filters", "limit"})
    normalized: dict = {"query": _string(parsed["query"], minimum=1, maximum=2048)}
    if "filters" in parsed:
        normalized["filters"] = _filters(parsed["filters"])
    if "limit" in parsed:
        normalized["limit"] = _integer(parsed["limit"], minimum=1, maximum=20)
    return normalized


def validate_audience(value: object) -> dict:
    """Validate one exact v1 audience variant and rebuild it."""
    parsed = _object(value)
    audience_class = _string(parsed.get("class"), minimum=1, maximum=32)
    if audience_class in {"private_owner", "background_private"}:
        _exact_keys(parsed, {"class"})
        return {"class": _string(audience_class, minimum=1, maximum=32)}
    if audience_class == "shared_room":
        _exact_keys(parsed, {"class", "roomId"})
        return {"class": "shared_room", "roomId": _room_id(parsed["roomId"])}
    if audience_class == "partner":
        _exact_keys(parsed, {"class", "roomId", "appId"})
        return {
            "class": "partner",
            "roomId": _room_id(parsed["roomId"]),
            "appId": _uuid(parsed["appId"]),
        }
    _fail()


def _scope(value: object) -> dict:
    parsed = _object(value)
    kind = _string(parsed.get("kind"), minimum=1, maximum=16)
    if kind == "private":
        _exact_keys(parsed, {"kind"})
        return {"kind": "private"}
    if kind == "room":
        _exact_keys(parsed, {"kind", "roomId"})
        return {"kind": "room", "roomId": _room_id(parsed["roomId"])}
    _fail()


def _citation(value: object) -> dict:
    parsed = _object(value)
    kind = _string(parsed.get("kind"), minimum=1, maximum=32)
    if kind == "matrix_event":
        _exact_keys(parsed, {"kind", "roomId", "eventId"})
        return {
            "kind": "matrix_event",
            "roomId": _room_id(parsed["roomId"]),
            "eventId": _event_id(parsed["eventId"]),
        }
    if kind == "drive_file":
        _exact_keys(parsed, {"kind", "fileId", "version"})
        return {
            "kind": "drive_file",
            "fileId": _ascii_ref(parsed["fileId"]),
            "version": _ascii_ref(parsed["version"]),
        }
    if kind == "memory":
        _exact_keys(parsed, {"kind", "agentPrincipal", "revision"})
        return {
            "kind": "memory",
            "agentPrincipal": _uuid(parsed["agentPrincipal"]),
            "revision": _integer(parsed["revision"], minimum=1),
        }
    _fail()


def _derivation(value: object) -> dict:
    parsed = _exact_keys(value, {"parents", "sourceRefs"})
    parents = _list(parsed["parents"])
    source_refs = _list(parsed["sourceRefs"])
    if len(parents) > 32 or len(source_refs) > 32:
        _fail()
    normalized_parents: list[str] = []
    for parent in parents:
        parsed_parent = _uuid(parent)
        if parsed_parent in normalized_parents:
            _fail()
        normalized_parents.append(parsed_parent)
    return {
        "parents": normalized_parents,
        "sourceRefs": [_object_ref(source_ref) for source_ref in source_refs],
    }


def _provenance(value: object) -> dict:
    parsed = _exact_keys(value, {"google"})
    if type(parsed["google"]) is not bool or parsed["google"] is not True:
        _fail()
    return {"google": True}


def _evidence_item(value: object, *, private_audience: bool) -> dict:
    optional = {"expiresAt"} | ({"provenance"} if private_audience else set())
    parsed = _exact_keys(
        value,
        {
            "evidenceId",
            "source",
            "object",
            "author",
            "eventTime",
            "observedTime",
            "policyEpoch",
            "scope",
            "epistemic",
            "derivation",
            "digest",
            "citation",
            "content",
            "untrustedInput",
        },
        optional,
    )
    epistemic = _string(parsed["epistemic"], minimum=1, maximum=16)
    if epistemic not in _EPISTEMIC:
        _fail()
    if type(parsed["untrustedInput"]) is not bool or parsed["untrustedInput"] is not True:
        _fail()
    normalized = {
        "evidenceId": _uuid(parsed["evidenceId"]),
        "source": _source_ref(parsed["source"]),
        "object": _object_ref(parsed["object"]),
        "author": _author(parsed["author"]),
        "eventTime": _timestamp(parsed["eventTime"]),
        "observedTime": _timestamp(parsed["observedTime"]),
        "policyEpoch": _integer(parsed["policyEpoch"], minimum=1),
        "scope": _scope(parsed["scope"]),
        "epistemic": epistemic,
        "derivation": _derivation(parsed["derivation"]),
        "digest": _sha256(parsed["digest"]),
        "citation": _citation(parsed["citation"]),
        "content": _string(parsed["content"], maximum=8192),
        "untrustedInput": True,
    }
    if "expiresAt" in parsed:
        normalized["expiresAt"] = _timestamp(parsed["expiresAt"])
    if "provenance" in parsed:
        normalized["provenance"] = _provenance(parsed["provenance"])
    return normalized


def _backfill(value: object) -> dict:
    parsed = _exact_keys(value, {"priorityWindowDays", "complete"}, {"oldestIndexedAt"})
    if _integer(parsed["priorityWindowDays"], minimum=30, maximum=30) != 30:
        _fail()
    if type(parsed["complete"]) is not bool:
        _fail()
    normalized = {"priorityWindowDays": 30, "complete": parsed["complete"]}
    if "oldestIndexedAt" in parsed:
        normalized["oldestIndexedAt"] = _timestamp(parsed["oldestIndexedAt"])
    return normalized


def _coverage_entry(value: object) -> dict:
    parsed = _exact_keys(value, {"source", "state", "reasons", "asOf"}, {"processedThrough", "backfill"})
    state = _string(parsed["state"], minimum=1, maximum=16)
    reasons = _list(parsed["reasons"])
    if state == "ready":
        if reasons:
            _fail()
    elif state in _COVERAGE_NON_READY:
        if not 1 <= len(reasons) <= 10:
            _fail()
    else:
        _fail()
    normalized_reasons: list[str] = []
    for reason in reasons:
        parsed_reason = _string(reason, minimum=1, maximum=32)
        if parsed_reason not in _COVERAGE_REASONS or parsed_reason in normalized_reasons:
            _fail()
        normalized_reasons.append(parsed_reason)
    normalized = {
        "source": _source_ref(parsed["source"]),
        "state": state,
        "reasons": normalized_reasons,
        "asOf": _timestamp(parsed["asOf"]),
    }
    if "processedThrough" in parsed:
        normalized["processedThrough"] = _timestamp(parsed["processedThrough"])
    if "backfill" in parsed:
        normalized["backfill"] = _backfill(parsed["backfill"])
    return normalized


def _request(value: object) -> dict:
    parsed = _exact_keys(value, {"requestId", "audience", "agentPrincipal", "query", "limits"}, {"filters"})
    limits = _exact_keys(parsed["limits"], {"maxItems", "maxContentBytes"})
    normalized = {
        "requestId": _uuid(parsed["requestId"]),
        "audience": validate_audience(parsed["audience"]),
        "agentPrincipal": _uuid(parsed["agentPrincipal"]),
        "query": _string(parsed["query"], minimum=1, maximum=2048),
        "limits": {
            "maxItems": _integer(limits["maxItems"], minimum=1, maximum=20),
            "maxContentBytes": _integer(limits["maxContentBytes"], minimum=1, maximum=32768),
        },
    }
    if "filters" in parsed:
        normalized["filters"] = _filters(parsed["filters"])
    return normalized


def _shared_item_invariants(item: dict, audience: dict) -> None:
    room_id = audience["roomId"]
    if item["scope"].get("kind") != "room" or item["scope"].get("roomId") != room_id:
        _fail()
    citation = item["citation"]
    if citation["kind"] == "matrix_event" and citation["roomId"] != room_id:
        _fail()


def validate_retrieval_response(value: object, request: object) -> dict:
    """Validate and copy one exact frozen-v1 retrieval response for *request*."""
    normalized_request = _request(request)
    parsed = _object(value)
    status = _string(parsed.get("status"), minimum=1, maximum=16)
    if status == "unavailable":
        parsed = _exact_keys(
            parsed,
            {"requestId", "audience", "status", "items", "coverage", "contentBytes", "errors"},
        )
    elif status in {"ok", "degraded"}:
        parsed = _exact_keys(parsed, {"requestId", "audience", "status", "items", "coverage", "contentBytes"})
    else:
        _fail()

    request_id = _uuid(parsed["requestId"])
    audience = validate_audience(parsed["audience"])
    if request_id != normalized_request["requestId"] or audience != normalized_request["audience"]:
        _fail()
    items = _list(parsed["items"])
    coverage = _list(parsed["coverage"])
    if len(items) > normalized_request["limits"]["maxItems"] or len(coverage) > 200:
        _fail()

    if status == "unavailable":
        if items or _integer(parsed["contentBytes"], minimum=0, maximum=0) != 0:
            _fail()
        errors = _list(parsed["errors"])
        if not 1 <= len(errors) <= 5:
            _fail()
        normalized_errors: list[str] = []
        for error in errors:
            parsed_error = _string(error, minimum=1, maximum=32)
            if parsed_error not in _UNAVAILABLE_ERRORS or parsed_error in normalized_errors:
                _fail()
            normalized_errors.append(parsed_error)
        return {
            "requestId": request_id,
            "audience": audience,
            "status": "unavailable",
            "items": [],
            "coverage": [_coverage_entry(entry) for entry in coverage],
            "contentBytes": 0,
            "errors": normalized_errors,
        }

    private_audience = audience["class"] in {"private_owner", "background_private"}
    normalized_items = [_evidence_item(item, private_audience=private_audience) for item in items]
    if not private_audience:
        for item in normalized_items:
            _shared_item_invariants(item, audience)
    content_bytes = _integer(parsed["contentBytes"], minimum=0, maximum=32768)
    computed_content_bytes = sum(_utf8_length(item["content"]) for item in normalized_items)
    if content_bytes != computed_content_bytes or content_bytes > normalized_request["limits"]["maxContentBytes"]:
        _fail()
    return {
        "requestId": request_id,
        "audience": audience,
        "status": status,
        "items": normalized_items,
        "coverage": [_coverage_entry(entry) for entry in coverage],
        "contentBytes": content_bytes,
    }


__all__ = ["AwarenessContractError", "validate_audience", "validate_recall_args", "validate_retrieval_response"]
