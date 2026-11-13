"""O1 wire adapter for the existing profile tool; no consent or run authority."""

from __future__ import annotations

import json
import re

from tools import desktop_ui
from tools.registry import tool_error

OPERATIONS = {
    "create": ("request_id", "display_name", "definition"),
    "set_model": ("target", "expected_definition_revision", "expected_identity_revision", "model_alias"),
    "set_skills": ("target", "expected_definition_revision", "expected_identity_revision", "skills"),
    "set_tools": ("target", "expected_definition_revision", "expected_identity_revision", "tools"),
    "propose_retire": ("target", "expected_definition_revision", "expected_identity_revision", "request_id"),
    "propose_hire": ("request_id", "offer_id", "offer_version"),
}
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.IGNORECASE)
ALIASES = ["binh-minh", "nguyet-thuc", "nhat-thuc"]
EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
HINTS = {
    "run_denied": "This turn cannot manage agents. Ask the person to request it in their own chat.",
    "quota": "The agent creation limit has been reached. Tell the person.",
    "confirmation_required": "The person must confirm in the app. Nothing has been approved by this request.",
    "awaiting_funds": "The authorised action is waiting for funds. The person can top up in the app and retry the same action.",
    "terms_changed": "The terms changed. Nothing was charged or bound; the person needs a fresh proposal in the app.",
    "expired": "The proposal or authorisation expired. Request a fresh proposal; do not report completion.",
    "unavailable": "Agent management is unavailable. Tell the person; do not report a change.",
}


def _uuid(value):
    return isinstance(value, str) and UUID.fullmatch(value) is not None


def _revision(value, minimum=0):
    return type(value) is int and minimum <= value <= 9_007_199_254_740_991


def _skills(value):
    if not isinstance(value, list) or len(value) > 512:
        return False
    names = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {"name", "sha256"}:
            return False
        name, digest = item["name"], item["sha256"]
        if (not isinstance(name, str) or not 1 <= len(name) <= 200
                or re.search(r"[\\\x00-\x1f\x7f]", name)
                or any(part in {"", ".", ".."} for part in name.split("/"))
                or name in names or not isinstance(digest, str)
                or re.fullmatch(r"[a-f0-9]{64}", digest) is None):
            return False
        names.add(name)
    return True


def _definition(value):
    if not isinstance(value, dict) or set(value) != {"schema_version", "soul", "model_alias", "reasoning", "skills"}:
        return False
    reasoning = value["reasoning"]
    valid_reasoning = reasoning is None or (
        isinstance(reasoning, dict) and set(reasoning) == {"enabled", "effort"}
        and type(reasoning["enabled"]) is bool
        and ((reasoning["enabled"] and reasoning["effort"] in EFFORTS)
             or (not reasoning["enabled"] and reasoning["effort"] is None)))
    return (type(value["schema_version"]) is int and value["schema_version"] == 1
            and isinstance(value["soul"], str) and len(value["soul"].encode("utf-8")) <= 65536
            and value["model_alias"] in ALIASES and valid_reasoning and _skills(value["skills"]))


def request(operation, args):
    """Validate only semantic inputs, then use the host's existing control event."""
    fields = OPERATIONS[operation]
    if set(args) != set(fields):
        return tool_error("invalid", hint="Pass exactly the fields required for this operation. Authority and confirmation fields are not accepted.")
    for key, value in args.items():
        valid = True
        if key in {"target", "request_id", "offer_id"}:
            valid = _uuid(value)
        elif key in {"expected_definition_revision", "expected_identity_revision", "offer_version"}:
            valid = _revision(value, 0 if key == "expected_definition_revision" else 1)
        elif key == "display_name":
            valid = isinstance(value, str) and 1 <= len(value) <= 40
        elif key == "definition":
            valid = _definition(value)
        elif key == "model_alias":
            valid = value in ALIASES
        elif key == "skills":
            valid = _skills(value)
        elif key == "tools":
            valid = (isinstance(value, list) and len(value) <= 128
                     and all(isinstance(item, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", item) for item in value))
        if not valid:
            return tool_error("invalid", hint=f"Invalid {key}; use the operation's documented shape.")
    wire_names = {"request_id": "requestId", "display_name": "displayName", "model_alias": "modelAlias",
                  "expected_definition_revision": "expectedDefinitionRevision", "expected_identity_revision": "expectedIdentityRevision",
                  "offer_id": "offerId", "offer_version": "offerVersion"}
    payload = {"operation": operation, **{wire_names.get(key, key): value for key, value in args.items()}}
    raw = desktop_ui.request("atum.agents.request", payload, timeout=30)
    if raw is None:
        return tool_error("unavailable", hint=HINTS["unavailable"])
    try:
        result = json.loads(raw)
    except (TypeError, ValueError):
        result = None
    if not isinstance(result, dict):
        return tool_error("unavailable", hint="The host did not return a valid management receipt. Do not assume completion; retry with the same request ID.")
    if isinstance(result.get("error"), str):
        # Do not echo arbitrary host metadata into the model.
        code = result["error"]
        if code not in {*HINTS, "conflict", "denied", "duplicate", "invalid", "locked", "missing", "offline", "reserved"}:
            code = "unavailable"
        return tool_error(code, **({"hint": HINTS[code]} if code in HINTS else {}))
    status = result.get("status")
    if operation in {"create", "propose_retire", "propose_hire"} and status == "confirmation_required" and set(result) == {"status", "proposalId"} and _uuid(result["proposalId"]):
        return json.dumps(result, ensure_ascii=False)
    # Provisioning records are explicitly host-only in the contract. The host must
    # finish provisioning and project a profile before returning to the model.
    if status in {"updated", "finished"} and isinstance(result.get("profile"), dict):
        profile = result["profile"]
        keys = {"principal", "displayName", "isMain", "definitionRevision", "identityRevision", "avatarUrl", "soul"}
        if (set(profile) == keys and _uuid(profile["principal"])
                and isinstance(profile["displayName"], str) and len(profile["displayName"]) <= 4096
                and type(profile["isMain"]) is bool and _revision(profile["definitionRevision"])
                and _revision(profile["identityRevision"], 1)
                and (profile["avatarUrl"] is None or isinstance(profile["avatarUrl"], str) and len(profile["avatarUrl"]) <= 2048)
                and isinstance(profile["soul"], str) and len(profile["soul"].encode("utf-8")) <= 65536):
            if status == "finished" and operation == "create" and set(result) == {"status", "profile"}:
                return json.dumps(result, ensure_ascii=False)
            effective = "next_turn" if operation == "set_model" else "next_session"
            if (status == "updated" and operation in {"set_model", "set_skills", "set_tools"}
                    and result.get("effective") == effective and set(result) == {"status", "effective", "profile"}):
                return json.dumps(result, ensure_ascii=False)
    return tool_error("unavailable", hint="The host has not supplied a safe completion receipt. Do not report completion; retry with the same request ID when applicable.")


_SKILL_SCHEMA = {"type": "array", "maxItems": 512, "items": {"type": "object", "additionalProperties": False,
    "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 200},
                   "sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"}}, "required": ["name", "sha256"]}}
MODEL_PROPERTIES = {
    "request_id": {"type": "string", "format": "uuid", "description": "Stable random UUID for create or proposal. Reuse it after a timeout or retry."},
    "model_alias": {"type": "string", "enum": ALIASES},
    "skills": _SKILL_SCHEMA,
    "tools": {"type": "array", "maxItems": 128, "items": {"type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$"}},
    "offer_id": {"type": "string", "format": "uuid"},
    "offer_version": {"type": "integer", "minimum": 1},
    "definition": {"type": "object", "additionalProperties": False, "required": ["schema_version", "soul", "model_alias", "reasoning", "skills"],
        "properties": {"schema_version": {"type": "integer", "enum": [1]}, "soul": {"type": "string"},
            "model_alias": {"type": "string", "enum": ALIASES}, "skills": _SKILL_SCHEMA,
            "reasoning": {"anyOf": [{"type": "null"}, {"type": "object", "additionalProperties": False,
                "properties": {"enabled": {"type": "boolean"}, "effort": {"enum": [None, *EFFORTS]}},
                "required": ["enabled", "effort"]}]}}},
}
