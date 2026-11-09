"""The cloud assistant's reach into the owner's Macs (S1 build plan §3.4).

Footprint rung 4: a bundled plugin, enabled only by the configuration the Atum cloud controller
writes into its task sandbox (``plugins.enabled: [atum-device]``). Every other Hermes surface
is unchanged.

At ``register`` it wraps six built-in tools (``terminal``, ``read_file``, ``write_file``,
``patch``, ``search_files``, ``computer_use``) with **the original schema plus one optional
``device`` property** (``terminal`` also gains ``needs``) and adds one tool,
``device_send_file``. The schema is fixed in code and every tool is always available, so the
tool list is identical on every turn of every conversation and the cached prompt prefix holds.
Which Macs are online reaches the model in the turn context, never in a schema.

A call goes to the controller as a Hermes reverse request (``atum.device.request`` through the
desktop UI bridge, answered by ``atum.device.respond``). The controller resolves the target and
answers:

- ``cloud``: run the original tool here, in the sandbox (``computer_use`` never runs here);
- ``ok``: the tool's own result, produced on the Mac;
- ``device="list"`` on any of them: the owner's Macs, which are on, and what works on each
  (the controller answers; nothing runs);
- anything else (``offline``, ``pending_device``, ``refused``, ``stopped``, ...): a short error
  the model can act on.

A ``terminal`` command bound for a Mac first passes Hermes's own unconditional floor (the
hardline list, the sudo-stdin guard and the owner's deny rules), so those approvals keep
working wherever the command runs.
"""

from __future__ import annotations

import copy
import inspect
import json
import logging
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

DEVICE_TOOLS = ("terminal", "read_file", "write_file", "patch", "search_files", "computer_use")
PROTECTED_CAPABILITIES = [
    "ssh_agent", "keychain", "browser_store", "cloud_cli", "persistence", "network_new_host", "sudo",
    "other_agent_write", "exec_downloaded", "bulk_destructive", "gui_upload",
]
DEVICE_PROPERTY = {
    "type": "string",
    "description": (
        "Where to run. Omit: the device this message came from (the cloud when it came from a "
        "phone or a schedule). Or a device name from the turn context, or \"cloud\". "
        "\"list\" shows the owner's Macs, which are on, and what works on each; nothing runs."
    ),
}
NEEDS_PROPERTY = {
    "type": "array",
    "items": {"type": "string", "enum": PROTECTED_CAPABILITIES},
    "description": (
        "Protected things on the Mac this command needs (for example ssh_agent for git over SSH). "
        "Name them up front so the owner is asked once; anything unnamed that touches them fails."
    ),
}
SEND_FILE_SCHEMA = {
    "name": "device_send_file",
    "description": (
        "Send a file from one of the owner's Macs into this chat as an encrypted attachment "
        "(8 MB or less). If that Mac is offline, the request waits and runs when it is back."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "device": {
                "type": "string",
                "description": "The Mac to take the file from: a device name from the turn context, or \"list\" to see the owner's Macs.",
            },
            "path": {"type": "string", "description": "The file's path on that Mac."},
            "caption": {"type": "string", "description": "Optional words to send with the file."},
        },
        "required": ["device", "path"],
    },
}
ANSWER_STATUSES = {
    "ok", "cloud", "refused", "approval_denied", "approval_timeout", "offline", "pending_device", "stopped",
    "unknown", "unavailable",
}
DEFAULT_TOOL_TIMEOUT_S = 180
MAX_REQUEST_S = 900
# A protected call waits for the owner's Touch ID on the Mac (DEVICE_APPROVAL_WAIT_MS, 10 minutes) before
# it runs; the request has to outlive that wait or the call ends "without an answer" while the sheet is up.
APPROVAL_WAIT_S = 600


def _always() -> bool:
    """Every device tool is always offered: a schema that comes and goes would break the cache."""
    return True


def device_schema(name: str, schema: dict[str, Any]) -> dict[str, Any]:
    """The original schema plus the optional ``device`` property (and ``needs`` for terminal)."""
    wrapped = copy.deepcopy(schema)
    parameters = wrapped.setdefault("parameters", {"type": "object", "properties": {}})
    properties = parameters.setdefault("properties", {})
    properties["device"] = copy.deepcopy(DEVICE_PROPERTY)
    if name == "terminal":
        properties["needs"] = copy.deepcopy(NEEDS_PROPERTY)
    return wrapped


def _tool_call_id() -> str:
    try:
        from tools.approval_context import _approval_tool_call_id

        return str(_approval_tool_call_id.get("") or "")[:128]
    except Exception:
        return ""


def _request(tool: str, device: Optional[str], args: dict[str, Any], needs: Optional[list], timeout_s: float) -> dict[str, Any]:
    """Ask the controller where and how this call runs. ``None`` from the bridge means no
    controller is listening (any other Hermes): the call simply runs here."""
    from tools import desktop_ui

    payload: dict[str, Any] = {"tool": tool, "device": device, "args": args, "tool_call_id": _tool_call_id()}
    if needs:
        payload["needs"] = list(needs)
    raw = desktop_ui.request("atum.device.request", payload, timeout_s)
    if raw is None:
        return {"status": "cloud", "message": "No device bridge here."}
    if raw == "":
        return {"status": "stopped", "message": "The device call ended without an answer."}
    try:
        answer = json.loads(raw)
    except (TypeError, ValueError):
        return {"status": "unknown", "message": "The device answer could not be read."}
    if not isinstance(answer, dict) or answer.get("status") not in ANSWER_STATUSES:
        return {"status": "unknown", "message": "The device answer could not be read."}
    return answer


def _floor(command: str) -> Optional[dict[str, Any]]:
    """Hermes's own unconditional floor for a command bound for a Mac (tools/approval.py)."""
    try:
        from tools import approval

        is_hardline, description = approval.detect_hardline_command(command)
        if is_hardline:
            return approval._hardline_block_result(description)
        is_guess, guess = approval._check_sudo_stdin_guard(command)
        if is_guess:
            return approval._sudo_stdin_block_result(guess)
        pattern = approval._match_user_deny_rule(command)
        if pattern is not None:
            return approval._user_deny_block_result(pattern)
    except Exception:
        logger.warning("atum-device: the command floor could not be checked; refusing", exc_info=False)
        return {"approved": False, "message": "This command could not be checked, so it was not sent to your Mac."}
    return None


def _list(tool: str, timeout_s: float = 30) -> str:
    """The owner's Macs and what works on each (``device="list"``); nothing runs."""
    answer = _request(tool, "list", {}, None, timeout_s)
    if answer.get("status") == "ok":
        return _as_result(answer)
    if answer.get("status") in ("cloud", "unavailable"):
        return json.dumps({"macs": [], "message": "No Mac is reachable from here."})
    return _as_error(answer)


def _is_list(device: Any) -> bool:
    return isinstance(device, str) and device.strip().lower() == "list"


def _as_result(answer: dict[str, Any]) -> str:
    result = answer.get("result")
    if isinstance(result, str):
        return result
    return json.dumps(result if result is not None else {"success": True}, ensure_ascii=False)


def _as_error(answer: dict[str, Any]) -> str:
    error: dict[str, Any] = {"error": str(answer.get("message") or answer.get("status") or "device call failed")[:500],
                             "status": answer.get("status")}
    device = answer.get("device")
    if isinstance(device, dict) and isinstance(device.get("name"), str):
        error["device"] = device["name"][:64]
    return json.dumps(error, ensure_ascii=False)


def wrap(name: str, original: Callable[..., Any]) -> Callable[..., Any]:
    """The routed handler for one built-in tool."""

    def handler(args: dict[str, Any], **kwargs: Any) -> Any:
        args = dict(args or {})
        device = args.pop("device", None)
        if _is_list(device):
            return _list(name)
        device = device.strip() if isinstance(device, str) and device.strip() else None
        needs = args.pop("needs", None) if name == "terminal" else None
        if needs is not None and (not isinstance(needs, list) or any(n not in PROTECTED_CAPABILITIES for n in needs)):
            return json.dumps({"error": "needs names something Atum does not protect.", "status": "refused"})
        if name == "terminal" and device != "cloud":
            blocked = _floor(str(args.get("command") or ""))
            if blocked is not None:
                return json.dumps(blocked, ensure_ascii=False)
        try:
            tool_timeout = float(args.get("timeout") or DEFAULT_TOOL_TIMEOUT_S) if name == "terminal" else DEFAULT_TOOL_TIMEOUT_S
        except (TypeError, ValueError):
            tool_timeout = DEFAULT_TOOL_TIMEOUT_S
        answer = _request(name, device, args, needs, min(tool_timeout + 30 + APPROVAL_WAIT_S, MAX_REQUEST_S))
        status = answer.get("status")
        if status in ("cloud", "unavailable"):
            if name == "computer_use":
                return json.dumps({"error": "Computer control runs on a Mac. Name a Mac that is online.", "status": "refused"})
            result = original(args, **kwargs)
            if inspect.iscoroutine(result):
                from model_tools import _run_async

                result = _run_async(result)
            return result
        if status == "ok":
            return _as_result(answer)
        return _as_error(answer)

    handler.__name__ = f"atum_device_{name}"
    return handler


def send_file(args: dict[str, Any], **_kwargs: Any) -> str:
    args = dict(args or {})
    device = args.get("device")
    path = args.get("path")
    if _is_list(device):
        return _list("device_send_file")
    if not isinstance(device, str) or not device.strip() or not isinstance(path, str) or not path.strip():
        return json.dumps({"error": "Name the Mac and the file's path.", "status": "refused"})
    request_args: dict[str, Any] = {"path": path}
    if isinstance(args.get("caption"), str) and args["caption"].strip():
        request_args["caption"] = args["caption"][:1000]
    answer = _request("device_send_file", device.strip(), request_args, None, DEFAULT_TOOL_TIMEOUT_S + 30)
    if answer.get("status") == "ok":
        return _as_result(answer)
    if answer.get("status") in ("cloud", "unavailable"):
        return json.dumps({"error": "Files are sent from a Mac. Name a Mac that is online.", "status": "refused"})
    return _as_error(answer)


def register(ctx) -> None:
    # The headless ``hermes serve`` process can discover plugins before its
    # first AIAgent import.  Make this wrapper independent of that import
    # order: without the built-ins in the registry, the loop below silently
    # skips every routed tool and the manager's idempotent discovery prevents
    # a later repair.
    from tools.registry import discover_builtin_tools, registry

    discover_builtin_tools()

    for name in DEVICE_TOOLS:
        entry = registry.get_entry(name)
        if entry is None:
            continue
        ctx.register_tool(
            name=name,
            toolset=entry.toolset,
            schema=device_schema(name, entry.schema),
            handler=wrap(name, entry.handler),
            check_fn=_always,
            requires_env=list(entry.requires_env or []),
            is_async=False,  # the wrapper itself is synchronous; it runs an async original to completion
            description=entry.description,
            emoji=entry.emoji,
            override=True,
            max_result_size_chars=entry.max_result_size_chars,
        )
    ctx.register_tool(name="device_send_file", toolset="atum_device", schema=SEND_FILE_SCHEMA, handler=send_file,
                      check_fn=_always, emoji="📎")
