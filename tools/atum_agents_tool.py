"""Identity-bound Atum agent profile management through the live Matrix host."""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

from tools import desktop_ui
from tools import atum_agent_management as management
from tools.registry import registry, tool_error

_PRINCIPAL = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
_MAX_AVATAR_BYTES = 2 * 1024 * 1024

# The host answers a refusal with one closed code and nothing else (agent-profile-management.ts).
# The code stays in ``error``; ``hint`` is what it means for the model to pass on in the
# person's own words, so a refused rename gets a plain reason and a request for another name.
# Only the result changes: the tool's schema, and so the cached prompt prefix, is untouched.
_REFUSALS = {
    "reserved": "That name is reserved, so an assistant can't take it. Tell the person plainly and ask for a different one.",
    "duplicate": "Another of the person's assistants already has that name. Tell the person and ask for a different one.",
    "invalid": "That isn't a usable assistant name. Tell the person and ask for a shorter, simpler one.",
    "locked": "This assistant's name can't be changed. Tell the person.",
    "conflict": "The profile changed after you read it. Read it again, then retry once with the new revisions.",
    "denied": "You aren't allowed to change that profile. Tell the person.",
    "missing": "That agent no longer exists. Tell the person.",
    "offline": "Atum can't be reached right now, so nothing changed. Tell the person and offer to try again later.",
    "unavailable": "Atum couldn't make that change right now, so nothing changed. Tell the person.",
}

_MODEL_FIELDS_BY_OPERATION = {
    "list": (),
    "read": ("target",),
    "update": (
        "target",
        "expected_definition_revision",
        "expected_identity_revision",
        "display_name",
        "soul",
    ),
    "avatar": ("target", "avatar_path", "remove_avatar"),
}


def _avatar(path: str) -> tuple[dict[str, str] | None, str | None]:
    if not isinstance(path, str) or not path.strip() or len(path) > 4096:
        return None, "avatar_path must name one JPEG, PNG, or WebP file."
    try:
        source = Path(path).expanduser().resolve(strict=True)
        if not source.is_file() or source.stat().st_size < 1 or source.stat().st_size > _MAX_AVATAR_BYTES:
            return None, "The avatar must be a file from 1 byte through 2 MiB."
        data = source.read_bytes()
    except (OSError, RuntimeError):
        return None, "The avatar file could not be read."

    mime = None
    if data.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif data.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        mime = "image/webp"
    if mime is None:
        return None, "The avatar file is not a supported JPEG, PNG, or WebP image."
    return {"type": mime, "base64": base64.b64encode(data).decode("ascii")}, None


def atum_agents(
    operation: str,
    target: str = "",
    expected_definition_revision: int | None = None,
    expected_identity_revision: int | None = None,
    display_name: str | None = None,
    soul: str | None = None,
    avatar_path: str = "",
    remove_avatar: bool = False,
    **management_fields,
) -> str:
    """List/read profiles or make one revision-fenced identity change."""
    if isinstance(operation, str) and operation in management.OPERATIONS:
        values = {"target": target, "expected_definition_revision": expected_definition_revision,
                  "expected_identity_revision": expected_identity_revision, "display_name": display_name,
                  "soul": soul, "avatar_path": avatar_path, "remove_avatar": remove_avatar}
        values = {key: value for key, value in values.items() if value is not None and value != "" and value is not False}
        return management.request(operation, {**values, **management_fields})
    if operation not in {"list", "read", "update", "avatar"}:
        return tool_error("operation must be list, read, update, or avatar.")
    if not isinstance(target, str) or target and not _PRINCIPAL.fullmatch(target):
        return tool_error("target must be an exact agent principal returned by list.")

    payload: dict[str, object] = {"operation": operation, **({"target": target} if target else {})}
    if operation == "list":
        if any(value not in (None, "", False) for value in (
            expected_definition_revision, expected_identity_revision, display_name, soul, avatar_path, remove_avatar
        )):
            return tool_error("list does not accept mutation fields.")
    elif operation == "read":
        if any(value not in (None, "", False) for value in (
            expected_definition_revision, expected_identity_revision, display_name, soul, avatar_path, remove_avatar
        )):
            return tool_error("read accepts only an optional target.")
    elif operation == "update":
        if isinstance(expected_definition_revision, bool) or not isinstance(expected_definition_revision, int) or expected_definition_revision < 0:
            return tool_error("update requires expected_definition_revision from read.")
        if isinstance(expected_identity_revision, bool) or not isinstance(expected_identity_revision, int) or expected_identity_revision < 1:
            return tool_error("update requires expected_identity_revision from read.")
        if display_name is None and soul is None:
            return tool_error("update requires display_name or soul.")
        if display_name is not None and (not isinstance(display_name, str) or len(display_name) > 4096):
            return tool_error("display_name must be a string of at most 4096 characters.")
        if soul is not None and (not isinstance(soul, str) or len(soul.encode("utf-8")) > 65536):
            return tool_error("soul must be at most 65536 UTF-8 bytes.")
        if avatar_path or remove_avatar:
            return tool_error("Use the avatar operation for a profile photo.")
        payload.update(expectedDefinitionRevision=expected_definition_revision,
                       expectedIdentityRevision=expected_identity_revision)
        if display_name is not None:
            payload["displayName"] = display_name
        if soul is not None:
            payload["soul"] = soul
    else:
        if display_name is not None or soul is not None or expected_definition_revision is not None or expected_identity_revision is not None:
            return tool_error("avatar accepts only target and one photo action.")
        if bool(avatar_path) == bool(remove_avatar):
            return tool_error("avatar requires exactly one of avatar_path or remove_avatar.")
        if remove_avatar:
            payload["avatar"] = None
        else:
            image, error = _avatar(avatar_path)
            if error:
                return tool_error(error)
            payload["avatar"] = image

    receipt = desktop_ui.request("atum.agents.request", payload, timeout=60 if operation == "avatar" else 30)
    if receipt is None:
        return tool_error("Agent profiles are available only through a live Atum agent turn.")
    if not receipt:
        return tool_error("The Atum host did not confirm the profile request.")
    try:
        result = json.loads(receipt)
    except (TypeError, ValueError):
        return tool_error("The Atum host returned an invalid profile response.")
    if not isinstance(result, dict):
        return tool_error("The Atum host returned an invalid profile response.")
    if result.get("error"):
        code = str(result["error"])
        hint = _REFUSALS.get(code)
        return tool_error(code, hint=hint) if hint else tool_error(code)
    if not (isinstance(result.get("agents"), list) ^ isinstance(result.get("profile"), dict)):
        return tool_error("The Atum host returned an invalid profile response.")
    return json.dumps(result, ensure_ascii=False)


ATUM_AGENTS_SCHEMA = {
    "name": "atum_agents",
    "description": (
        "List the owner's Atum agents, read your own profile, or update an authorized profile. "
        "Every agent may edit its own name, SOUL, and avatar. The current Main agent may also edit "
        "owned sibling agents; the host checks Main on every call. Read before update and pass both "
        "revisions. Use avatar only when the owner explicitly asks to publish or remove that photo. "
        "Main may create other owned agents, set_model, set_skills, set_tools, propose_hire, or "
        "propose_retire in an eligible owner turn. Create requires request_id, display_name, definition. "
        "Setting changes and retire require target and both read revisions; retire also needs request_id. "
        "Hire requires request_id, offer_id, offer_version. Model takes effect next turn; skills/tools next session. "
        "A confirmation_required result is only a proposal: the person must confirm in the app within 24 hours. "
        "Never claim a proposal completed. Charging remains unavailable until enabled by the platform. "
        "This cannot confirm, promote Main, change credentials, or manage another agent's files or memory."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "operation": {"type": "string", "enum": ["list", "read", "update", "avatar", *management.OPERATIONS]},
            "target": {"type": "string", "description": "Exact principal from list; omit for yourself."},
            "expected_definition_revision": {"type": "integer", "minimum": 0},
            "expected_identity_revision": {"type": "integer", "minimum": 1},
            "display_name": {"type": "string"},
            "soul": {"type": "string", "description": "Complete SOUL text, at most 65536 UTF-8 bytes."},
            "avatar_path": {"type": "string", "description": "Prepared JPEG, PNG, or WebP file, at most 2 MiB."},
            "remove_avatar": {"type": "boolean"},
            **management.MODEL_PROPERTIES,
        },
        "required": ["operation"],
    },
}


def _handle_atum_agents(args: object) -> str:
    if not isinstance(args, dict):
        return atum_agents(operation="")
    operation = args.get("operation", "")
    if isinstance(operation, str) and operation in management.OPERATIONS:
        return management.request(operation, {key: value for key, value in args.items() if key != "operation"})
    fields = (
        _MODEL_FIELDS_BY_OPERATION.get(operation, ())
        if isinstance(operation, str)
        else ()
    )
    selected = {
        field: args[field]
        for field in fields
        if field in args
    }
    return atum_agents(
        operation=operation,
        target=selected.get("target", ""),
        expected_definition_revision=selected.get("expected_definition_revision"),
        expected_identity_revision=selected.get("expected_identity_revision"),
        display_name=selected.get("display_name"),
        soul=selected.get("soul"),
        avatar_path=selected.get("avatar_path", ""),
        remove_avatar=selected.get("remove_avatar", False),
    )


registry.register(
    name="atum_agents",
    toolset="atum_agents",
    schema=ATUM_AGENTS_SCHEMA,
    handler=lambda args, **_kw: _handle_atum_agents(args),
    check_fn=desktop_ui.available,
    emoji="★",
)
