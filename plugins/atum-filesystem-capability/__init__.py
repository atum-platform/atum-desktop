"""Atum's account-scoped consent adapter for Hermes tool dispatch.

Hermes owns consent. Every Atum-mediated tool call goes through Hermes's own
approval gate (``tools.approval.request_tool_approval``) under a stable,
account-scoped rule key, so "Always allow" persists in Hermes's
``command_allowlist`` and the session, yolo, and ``approvals.mode: off``
bypasses behave exactly as they do for any other Hermes approval.

Electron main keeps only the narrow native adapter: it describes an operation
(capability, human wording, scope, rule key), binds an approved operation to
the signed-in account as a one-operation lease, revokes at safe boundaries,
executes and publishes workspace text writes, and keeps a redacted audit.
Possession of the per-process broker token is the Hermes-runtime authority;
main re-validates every operation and never treats a reported approval as
proof of a human click.

Everything outside the two mediated classes (interaction tools and workspace
``write_file``) runs exactly as Hermes ships it. Hermes's hardline blocklist
and user deny rules remain the only unconditional limits, and they cover
terminal command strings only. This bundled hook is active only for a
desktop-managed backend carrying the internal required marker. It adds no tool
schema and therefore does not invalidate a conversation's cached prompt when
consents change.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from hermes_cli.atum_filesystem_guard import (
    capability_required,
    is_interaction_tool,
)

_URL_ENV = "ATUM_FILESYSTEM_BROKER_URL"
_TOKEN_ENV = "ATUM_FILESYSTEM_BROKER_TOKEN"
_HTTP_TIMEOUT_SECONDS = 1.5
# `/request-write` performs an already-approved anchored write plus desktop
# publication. Consent has already been settled through the Hermes gate, so
# this bound covers disk and IPC work only, never a human decision.
_WRITE_TIMEOUT_SECONDS = 15.0
_INTERACTION_DURATION_MS = 2 * 60_000
_HERMES_APPROVAL = {"authority": "hermes"}
_TRANSPORT_ERRORS = (OSError, RuntimeError, TimeoutError, ValueError, urllib.error.URLError)
# Deliberate "not one of ours" answers from main's describe-write. Only these
# hand a write_file back to plain Hermes. CAPABILITY_DENIED is NOT among them:
# main maps every unexpected failure to it, and an unexpected failure must
# block rather than let a workspace write slip past consent.
_WRITE_PASS_THROUGH_CODES = {
    "CAPABILITY_SCOPE_ESCAPE",  # outside the account workspace
    "CAPABILITY_UNSUPPORTED_TYPE",  # not a text file the desktop outcome covers
    "CAPABILITY_TOO_LARGE",
}


class _BrokerHttpError(RuntimeError):
    """Main answered with a non-200 status (401/400/403/5xx)."""

    def __init__(self, route: str, status: int):
        super().__init__(f"filesystem_broker_http_{status}:{route}")
        self.route = route
        self.status = status


_interaction_lock = threading.Lock()
_active_interactions: Dict[tuple[str, str], str] = {}
_interaction_overrides: Dict[tuple[str, str], str] = {}


def _required() -> bool:
    return capability_required()


def _block(code: str = "CAPABILITY_DENIED", message: str = "") -> Dict[str, str]:
    safe_message = (
        message.strip()
        if isinstance(message, str) and message.strip()
        else "Atum filesystem authority refused this tool call"
    )
    return {
        "action": "block",
        "authority": "atum-filesystem",
        "message": f"{code}: {safe_message}",
    }


def _allow() -> Dict[str, str]:
    """Attest that Atum looked and has nothing to bind: Hermes runs the tool."""
    return {"action": "atum_filesystem_allow", "authority": "atum-filesystem"}


def _interaction_block(code: str, message: str = "") -> Dict[str, str]:
    safe_message = message if isinstance(message, str) and message.strip() else "Atum refused this action"
    return {
        "action": "block",
        "authority": "atum-filesystem",
        "message": f"{code}: {safe_message}",
    }


def _handoff() -> Dict[str, str]:
    return {
        "action": "block",
        "authority": "atum-filesystem",
        "message": (
            "CAPABILITY_HANDOFF: Atum completed this approved file write and "
            "published its desktop outcome; do not retry"
        ),
    }


def _request_json(method: str, route: str, body: Optional[Dict[str, Any]] = None) -> Any:
    base_url = os.environ.get(_URL_ENV, "").rstrip("/")
    token = os.environ.get(_TOKEN_ENV, "")
    if not base_url or not token:
        raise RuntimeError("filesystem_broker_unavailable")

    payload = (
        None
        if body is None
        else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    request = urllib.request.Request(
        f"{base_url}{route}",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    timeout_seconds = (
        _WRITE_TIMEOUT_SECONDS
        if route == "/v1/filesystem/request-write"
        else _HTTP_TIMEOUT_SECONDS
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status != 200:
                raise _BrokerHttpError(route, int(response.status))
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise _BrokerHttpError(route, int(error.code)) from error


def _request_hermes_approval(tool_name: str, intended_effect: str, rule_key: str) -> Dict[str, Any]:
    """Ask Hermes's own approval gate under a stable, account-scoped rule key.

    The default choice set (once / session / always / deny) and the default
    bypass behavior apply, so a durable "Always allow" lands in Hermes's
    ``command_allowlist`` and the status-bar zap silences this consent like
    any other. Hermes owns the card, the timeout, and interrupt handling; the
    agent thread blocks here until the user answers.
    """
    from tools.approval import request_tool_approval

    return request_tool_approval(tool_name, intended_effect, rule_key=rule_key)


def _valid_authority(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    account = value.get("account")
    actor = value.get("actor")
    return bool(
        isinstance(account, dict)
        and isinstance(account.get("accountId"), str)
        and account.get("accountId")
        and isinstance(account.get("accountGeneration"), int)
        and account.get("accountGeneration") > 0
        and isinstance(actor, dict)
        and actor.get("kind") == "personal"
        and isinstance(actor.get("personalAgentId"), str)
        and actor.get("personalAgentId")
    )


def _valid_description(value: Any) -> bool:
    return bool(
        isinstance(value, dict)
        and value.get("ok") is True
        and isinstance(value.get("ruleKey"), str)
        and value["ruleKey"].strip()
        and isinstance(value.get("intendedEffect"), str)
        and value["intendedEffect"].strip()
    )


def _failure_fields(value: Any, default_code: str) -> tuple[str, str]:
    code = value.get("code") if isinstance(value, dict) else None
    message = value.get("rendererMessage") if isinstance(value, dict) else None
    return (
        code if isinstance(code, str) and code else default_code,
        message if isinstance(message, str) else "",
    )


def _gate_interaction(
    tool_name: str,
    args: Any,
    tool_call_id: str,
    session_id: str,
) -> Dict[str, str]:
    if not isinstance(args, dict) or not tool_call_id or not session_id.strip():
        return _interaction_block("CAPABILITY_DENIED")

    try:
        authority = _request_json("GET", "/v1/filesystem/authority")
        if not _valid_authority(authority):
            return _interaction_block("CAPABILITY_REVOKED")

        described = _request_json(
            "POST",
            "/v1/interaction/describe",
            {
                "account": authority["account"],
                "actor": authority["actor"],
                "runtimeSessionId": session_id,
                "toolName": tool_name,
                "toolArgs": args,
            },
        )
        if not _valid_description(described):
            code, message = _failure_fields(described, "CAPABILITY_INVALID")
            return _interaction_block(code, message)

        approval = _request_hermes_approval(tool_name, described["intendedEffect"], described["ruleKey"])
        if not isinstance(approval, dict) or approval.get("approved") is not True:
            message = approval.get("message") if isinstance(approval, dict) else None
            return _interaction_block(
                "CAPABILITY_DENIED",
                message if isinstance(message, str) else "Atum refused this action",
            )

        # Hermes has settled consent (a fresh answer, a session cache hit, a
        # durable allowlist entry, or a bypass). Main now binds this exact
        # operation to the signed-in account as a one-operation lease; it
        # re-derives the descriptor and validates every field itself.
        decision = _request_json(
            "POST",
            "/v1/interaction/request-use",
            {
                "account": authority["account"],
                "actor": authority["actor"],
                "operationId": tool_call_id,
                "runtimeSessionId": session_id,
                "toolName": tool_name,
                "toolArgs": args,
                "durationMs": _INTERACTION_DURATION_MS,
                "approval": dict(_HERMES_APPROVAL),
            },
        )
        if (
            not isinstance(decision, dict)
            or decision.get("allowed") is not True
            or not isinstance(decision.get("grantId"), str)
            or not decision["grantId"]
            or decision.get("operationId") != tool_call_id
        ):
            code, message = _failure_fields(decision, "CAPABILITY_DENIED")
            return _interaction_block(code, message)

        with _interaction_lock:
            _active_interactions[(session_id, tool_call_id)] = decision["grantId"]
        return _allow()
    except _TRANSPORT_ERRORS:
        return _interaction_block("CAPABILITY_DENIED")


def _gate_workspace_write(args: Any, tool_call_id: str, session_id: str) -> Dict[str, str]:
    """Route a write inside the account workspace through Hermes consent and
    Electron main's anchored write; leave every other write to Hermes."""
    if (
        not isinstance(args, dict)
        or not isinstance(args.get("path"), str)
        or not args["path"]
        or not isinstance(args.get("content"), str)
        or not tool_call_id
        or not session_id.strip()
    ):
        return _allow()

    content = args["content"]
    try:
        try:
            authority = _request_json("GET", "/v1/filesystem/authority")
        except _BrokerHttpError as error:
            if error.status == 403:
                # No signed-in Atum account: there is no workspace to bind
                # this write to, so it is an ordinary Hermes write.
                return _allow()
            raise
        if not _valid_authority(authority):
            return _block("CAPABILITY_REVOKED")

        described = _request_json(
            "POST",
            "/v1/filesystem/describe-write",
            {
                "account": authority["account"],
                "actor": authority["actor"],
                "operationId": tool_call_id,
                "resourcePath": args["path"],
                "contentByteSize": len(content.encode("utf-8")),
                "sessionId": session_id,
            },
        )
    except _TRANSPORT_ERRORS:
        # Authentication failure, a malformed request (contract mismatch),
        # a main-side fault, invalid JSON, or an unreachable broker: fail
        # closed rather than let a workspace write slip past consent.
        return _block()

    if not _valid_description(described):
        # Only main's explicit "not one of ours" answers hand the write back
        # to plain Hermes: outside the workspace, an unsupported type, or too
        # large for the desktop outcome. Anything else blocks.
        code = described.get("code") if isinstance(described, dict) else None
        if (
            isinstance(described, dict)
            and described.get("ok") is False
            and isinstance(code, str)
            and code in _WRITE_PASS_THROUGH_CODES
        ):
            return _allow()
        return _block(code if isinstance(code, str) and code else "CAPABILITY_DENIED")

    approval = _request_hermes_approval("write_file", described["intendedEffect"], described["ruleKey"])
    if not isinstance(approval, dict) or approval.get("approved") is not True:
        message = approval.get("message") if isinstance(approval, dict) else None
        return _block("CAPABILITY_DENIED", message if isinstance(message, str) else "")

    try:
        result = _request_json(
            "POST",
            "/v1/filesystem/request-write",
            {
                "account": authority["account"],
                "actor": authority["actor"],
                "content": content,
                "operationId": tool_call_id,
                "resourcePath": args["path"],
                "sessionId": session_id,
                "approval": dict(_HERMES_APPROVAL),
            },
        )
    except _TRANSPORT_ERRORS:
        return _block()

    if not isinstance(result, dict) or result.get("ok") is not True:
        message = result.get("rendererMessage") if isinstance(result, dict) else None
        return _block("CAPABILITY_DENIED", message if isinstance(message, str) else "")
    # Electron main owns the anchored write and the desktop outcome. The
    # unchanged Hermes write_file implementation never touches the path.
    return _handoff()


def _on_pre_tool_call(
    tool_name: str = "",
    args: Any = None,
    tool_call_id: str = "",
    **_: Any,
) -> Optional[Dict[str, str]]:
    if tool_name in {"read_file", "search_files"}:
        from tools.atum_source_policy import source_enabled

        if not source_enabled("folders"):
            return _block("SOURCE_DISABLED", "Folder access is disabled in Atum settings")

        from tools.atum_source_policy import folder_refusal

        # Resolved like the tool resolves it (task cwd, symlinks, case); an omitted
        # search path is the task cwd.
        refusal = folder_refusal(args.get("path") if isinstance(args, dict) else None,
                                 str(_.get("task_id") or "default"))
        if refusal:
            return _block("SOURCE_DISABLED", refusal)
    if not _required():
        return None
    session_id = str(_.get("session_id") or "")
    if is_interaction_tool(tool_name):
        return _gate_interaction(tool_name, args, tool_call_id, session_id)
    if tool_name == "write_file":
        return _gate_workspace_write(args, tool_call_id, session_id)
    return None


def _on_post_tool_call(
    tool_name: str = "",
    tool_call_id: str = "",
    status: str = "error",
    **_: Any,
) -> None:
    if not is_interaction_tool(tool_name) or not tool_call_id:
        return None
    session_id = str(_.get("session_id") or "")
    with _interaction_lock:
        grant_id = _active_interactions.pop((session_id, tool_call_id), None)
    if not grant_id:
        return None

    try:
        result = _request_json(
            "POST",
            "/v1/interaction/finish-use",
            {
                "operationId": tool_call_id,
                "runtimeSessionId": session_id,
                "completedOperation": status == "ok",
            },
        )
        if isinstance(result, dict) and result.get("allowed") is False:
            override = json.dumps(
                {
                    "error": result.get("code", "CAPABILITY_REVOKED"),
                    "safeBoundary": result.get("safeBoundary", "partial_effects"),
                    "completedOperation": result.get("completedOperation", status == "ok"),
                    "message": result.get(
                        "rendererMessage",
                        "Permission changed while this action was running.",
                    ),
                },
                ensure_ascii=False,
            )
            with _interaction_lock:
                _interaction_overrides[(session_id, tool_call_id)] = override
    except _TRANSPORT_ERRORS:
        with _interaction_lock:
            _interaction_overrides[(session_id, tool_call_id)] = json.dumps(
                {
                    "error": "CAPABILITY_REVOKED",
                    "safeBoundary": "partial_effects",
                    "completedOperation": status == "ok",
                    "message": "Permission could not be revalidated at the safe boundary.",
                }
            )
    return None


def _on_transform_tool_result(
    tool_name: str = "",
    tool_call_id: str = "",
    **_: Any,
) -> Optional[str]:
    if not is_interaction_tool(tool_name) or not tool_call_id:
        return None
    session_id = str(_.get("session_id") or "")
    with _interaction_lock:
        return _interaction_overrides.pop((session_id, tool_call_id), None)


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("transform_tool_result", _on_transform_tool_result)


__all__ = ["_on_post_tool_call", "_on_pre_tool_call", "_on_transform_tool_result", "register"]
