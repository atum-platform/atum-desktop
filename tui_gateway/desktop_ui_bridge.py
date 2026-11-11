"""Atum Desktop's renderer bridge: the policy layer over S4's generic server-request seam.

:mod:`tui_gateway.server_requests` owns the transport (open request → client response frame →
settlement). This module owns the Atum rules on top: which request kinds a live turn may make,
which tool-supplied keys are allowed through, what the runtime stamps (turn id, expiry), and how
large a question or answer may be. ``set_emitter`` / ``set_requester`` are S4's two seams;
:func:`wire` installs this policy before an agent freezes its tool list
(``tui_gateway/agent_callbacks.py::_agent_cbs``).

Authority always comes from the live session record — never from the tool arguments. A cloud
brain's device call is bound to the Matrix turn the runtime is running; a Desktop window answers
for its own session. A request whose turn ended while it waited never receives the old answer.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass

from tui_gateway import server_requests

# Sources allowed to ask each channel. Agent profiles and task hand-offs are Matrix-only (the
# cloud brain talks to the owner's controller); catalog discovery also serves a Desktop window.
_APPS_SOURCES = frozenset({"desktop", "matrix"})
_MATRIX_SOURCES = frozenset({"matrix"})
_ADVISORY_SOURCES = frozenset({"desktop", "atum-private-advisory"})

_MAX_ANSWER_CHARS = 1_048_576
_ADVISORY_MAX_ANSWER_CHARS = 6000
_ADVISORY_TURN_REQUESTS = 4
_ATUM_DEVICE_TOOLS = frozenset(
    {"terminal", "read_file", "write_file", "patch", "search_files", "computer_use", "device_send_file", "atum_mac"}
)
_NATIVE_CLOUD_CHANNELS = frozenset({
    "atum.apps.list", "atum.apps.open", "atum.store", "atum.agents", "atum.agent_tasks",
    "atum.routines", "atum.chats", "atum.device",
})
_UUID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")


@dataclass(frozen=True)
class _Channel:
    sources: frozenset[str]
    allowed: tuple[str, ...]
    max_timeout: float
    max_request_bytes: int
    unavailable: str
    ended: str


_CHANNELS = {
    "atum.apps.list": _Channel(
        _APPS_SOURCES, (), 30, 16_000,
        "App switching requires a live Atum turn.", "The catalog request's turn ended."),
    "atum.apps.open": _Channel(
        _APPS_SOURCES, ("app_id",), 30, 16_000,
        "App switching requires a live Atum turn.", "The catalog request's turn ended."),
    "atum.store": _Channel(
        _APPS_SOURCES, ("operation", "query", "kind", "itemId", "limit"), 30, 16_000,
        "Store discovery requires a live Atum turn.", "The catalog request's turn ended."),
    "atum.agents": _Channel(
        _MATRIX_SOURCES,
        ("operation", "target", "expectedDefinitionRevision", "expectedIdentityRevision",
         "displayName", "soul", "avatar"),
        60, 2_900_000,
        "Agent profiles require a live Matrix agent turn.",
        "The agent profile request's turn ended."),
    "atum.agent_tasks": _Channel(
        _MATRIX_SOURCES, ("operation", "target", "taskId", "prompt", "text", "timeoutMinutes"),
        90, 70_000,
        "Agent tasks require a live Matrix agent turn.", "The agent task request's turn ended."),
    "atum.routines": _Channel(
        _MATRIX_SOURCES,
        ("profile", "operation", "routineId", "expectedRevision", "title", "instruction", "schedule",
         "timezone", "enabled", "notifications"),
        60, 70_000,
        "Scheduling requires a live Matrix agent turn.", "The schedule request's turn ended."),
    "atum.chats": _Channel(
        _MATRIX_SOURCES, ("op", "unreadOnly", "sinceMs", "limit", "id", "before", "query"),
        60, 16_000,
        "Chats require a live Matrix agent turn.", "The chat request's turn ended."),
    "atum.mac": _Channel(
        _MATRIX_SOURCES, ("op", "days", "limit", "id", "browser", "mode", "precision"),
        60, 4096,
        "Mac sources require a live Matrix agent turn.", "The Mac request's turn ended."),
    "atum.workspace.fetch": _Channel(
        _MATRIX_SOURCES, ("path", "destination"), 120, 4096,
        "Workspace fetch requires a live Matrix agent turn.", "The workspace request's turn ended."),
    "atum.device": _Channel(
        _MATRIX_SOURCES, ("tool", "device", "args", "tool_call_id", "needs"), 900, 2_900_000,
        "Device calls require a live Matrix agent turn.", "The device request's turn ended."),
    "word.document": _Channel(
        _APPS_SOURCES, ("action", "revision", "find", "replacement"), 45, 16_000,
        "Word documents require a live Atum turn.", "The Word request's turn ended."),
}

# One literal per request method: server_requests.send validates the frame against
# tui_gateway/contracts, and tests/tui_gateway/contracts/test_generated.py scans these literals to
# prove no declared contract is orphaned.
_SENDERS = {
    "atum.apps.list": lambda sid, params, timeout: server_requests.send(
        "atum.apps.list", sid, params, timeout=timeout),
    "atum.apps.open": lambda sid, params, timeout: server_requests.send(
        "atum.apps.open", sid, params, timeout=timeout),
    "atum.store": lambda sid, params, timeout: server_requests.send(
        "atum.store", sid, params, timeout=timeout),
    "atum.agents": lambda sid, params, timeout: server_requests.send(
        "atum.agents", sid, params, timeout=timeout),
    "atum.agent_tasks": lambda sid, params, timeout: server_requests.send(
        "atum.agent_tasks", sid, params, timeout=timeout),
    "atum.routines": lambda sid, params, timeout: server_requests.send(
        "atum.routines", sid, params, timeout=timeout),
    "atum.chats": lambda sid, params, timeout: server_requests.send(
        "atum.chats", sid, params, timeout=timeout),
    "atum.mac": lambda sid, params, timeout: server_requests.send(
        "atum.mac", sid, params, timeout=timeout),
    "atum.workspace.fetch": lambda sid, params, timeout: server_requests.send(
        "atum.workspace.fetch", sid, params, timeout=timeout),
    "atum.device": lambda sid, params, timeout: server_requests.send(
        "atum.device", sid, params, timeout=timeout),
    "word.document": lambda sid, params, timeout: server_requests.send(
        "word.document", sid, params, timeout=timeout),
    "atum.advisory.search": lambda sid, params, timeout: server_requests.send(
        "atum.advisory.search", sid, params, timeout=timeout),
}

_wire_lock = threading.Lock()
_wired = False


def _answered_by_its_session(request, transport) -> bool:
    """A device call reaches the owner's Mac or the cloud controller through its session's client
    only; a client of another session that learnt the id (or ``request.answer`` from one) cannot
    settle it. ``None`` is an in-process relay (the compute-host owner), already behind this check."""
    return transport is None or transport in server_requests._clients(request.sid)


server_requests.gate_answers("atum.device", _answered_by_its_session)
_advisory_budget_lock = threading.Lock()


def _live_session(sid: str, sources: frozenset[str]) -> dict | None:
    """The live session *sid* if its current turn may use *sources*, else None."""
    from tui_gateway import server

    with server._sessions_lock:
        session = server._sessions.get(sid)
    if (not session or not session.get("running") or not session.get("active_turn_id")
            or session.get("source") not in sources):
        return None
    return session


def _send(event: str, sid: str, params: dict, timeout: float) -> str:
    """Serialized renderer answer. ``None`` (timeout / cancelled / unanswerable) reads as ""."""
    sender = _SENDERS.get(event)
    result = sender(sid, params, timeout) if sender is not None else None
    if result is None:
        return ""
    value = result.get("value")
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def _native_cloud_execution_id(sid: str) -> str | None:
    """The platform-claimed native job currently running without a UI session.

    Native cron deliberately clears ``HERMES_UI_SESSION_ID``.  Its tools still need the same
    controller-owned Atum bridges as an ordinary cloud turn, so bind those requests to Hermes's
    already-won cron execution identity and broadcast them to the connected controller.  A local
    or standalone cron job never satisfies this guard and keeps the ordinary desktop-only result.
    """
    if sid or os.environ.get("ATUM_TASK_WORKSPACE") != "/task/workspace":
        return None
    try:
        from cron.execution_identity import current_cron_execution

        execution = current_cron_execution()
    except Exception:
        return None
    if execution is None or execution.source != "atum" or not _UUID.fullmatch(execution.execution_id):
        return None
    return execution.execution_id


def _bounded(payload: dict, channel: _Channel) -> tuple[dict, str | None]:
    """Only the channel's own keys; an oversized request is refused, never truncated."""
    bound = {key: payload[key] for key in channel.allowed if key in payload}
    try:
        size = len(json.dumps(bound, separators=(",", ":"), ensure_ascii=True).encode("utf-8"))
    except (TypeError, ValueError):
        return {}, "The host request could not be read."
    if size > channel.max_request_bytes:
        return {}, "The host request was too large."
    return bound, None


def _workspace_path_ok(value: object) -> bool:
    """One bounded workspace-relative file path; never a host path or traversal."""
    if (not isinstance(value, str) or not value or value.startswith("/") or value.endswith("/")
            or "\\" in value):
        return False
    try:
        if len(value.encode("utf-8")) > 1024:
            return False
    except UnicodeEncodeError:
        return False
    segments = value.split("/")
    return (len(segments) <= 16 and all(part not in ("", ".", "..") for part in segments)
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def _advisory_search(sid: str, payload: dict, timeout: float) -> str:
    """One bounded read; the per-turn budget lives on the session the runtime owns."""
    session = _live_session(sid, _ADVISORY_SOURCES)
    if session is None:
        return json.dumps({"status": "unavailable", "results": [], "error": "turn_unavailable"},
                          ensure_ascii=False)
    turn = session["active_turn_id"]
    with _advisory_budget_lock:
        budget = session.setdefault("advisory_search_budget", {"turn": turn, "requests": 0})
        if budget["turn"] != turn:
            budget = session["advisory_search_budget"] = {"turn": turn, "requests": 0}
        if budget["requests"] >= _ADVISORY_TURN_REQUESTS:
            return json.dumps({"status": "limit", "results": [], "error": "turn_source_limit"},
                              ensure_ascii=False)
        budget["requests"] += 1
    bound = {key: payload[key] for key in ("query", "reference", "limit") if key in payload}
    bound["turn_id"] = turn
    result = _send("atum.advisory.search", sid, bound, max(1.0, min(float(timeout or 0), 30)))
    if session.get("active_turn_id") != turn or not session.get("running"):
        return json.dumps({"status": "unavailable", "results": [], "error": "turn_expired"},
                          ensure_ascii=False)
    if len(result) > _ADVISORY_MAX_ANSWER_CHARS:
        return json.dumps({"status": "unavailable", "results": [],
                           "error": "source_response_too_large"}, ensure_ascii=False)
    return result


def _desktop_ui_request(sid: str, event: str, payload: dict, timeout: float) -> str:
    """Answer one Atum host request, or a typed refusal when the turn cannot make it."""
    # Compatibility with the pre-server-request tool adapters. E6 rewires the
    # shipped tools to the declared method names; catalog plugins may continue
    # to carry the old notification suffix for one transition window.
    event = event.removesuffix(".request")
    if event == "atum.advisory.search":
        return _advisory_search(sid, payload, timeout)
    channel = _CHANNELS.get(event)
    if channel is None:
        return json.dumps({"error": "unsupported desktop request"}, ensure_ascii=False)
    native_execution_id = _native_cloud_execution_id(sid)
    native = native_execution_id is not None and event in _NATIVE_CLOUD_CHANNELS
    session = None if native else _live_session(sid, channel.sources)
    if session is None and not native:
        return json.dumps({"error": channel.unavailable}, ensure_ascii=False)
    turn = native_execution_id if native else session["active_turn_id"]
    bound, problem = _bounded(payload, channel)
    if problem is not None:
        return json.dumps({"error": problem}, ensure_ascii=False)
    if event == "atum.device" and (
        bound.get("tool") not in _ATUM_DEVICE_TOOLS or not isinstance(bound.get("args"), dict)
    ):
        return json.dumps({"status": "refused", "message": "That device request is not one Atum can run."})
    if event == "atum.workspace.fetch" and (
        not _workspace_path_ok(bound.get("path"))
        or ("destination" in bound and not _workspace_path_ok(bound["destination"]))
    ):
        return json.dumps({"outcome": "refused", "reason": "invalid"}, ensure_ascii=False)
    bound["turn_id"] = turn
    wait = max(1.0, min(float(timeout or 0), channel.max_timeout))
    if event == "atum.device":
        bound["expires_at"] = int((time.time() + wait) * 1000)
    elif event == "word.document":
        bound["expires_at"] = time.time() + wait
    result = (server_requests.request_host(event, bound, timeout=wait) if native
              else _send(event, sid, bound, wait))
    if not native and (session.get("active_turn_id") != turn or not session.get("running")):
        return json.dumps({"error": channel.ended}, ensure_ascii=False)
    if len(result) > _MAX_ANSWER_CHARS:
        return json.dumps({"error": "The host response was too large."}, ensure_ascii=False)
    return result


def _desktop_ui_emit(sid: str, event: str, payload: dict) -> None:
    """Attach live runtime authority to previews, never trust tool-supplied ids."""
    from tui_gateway import server

    if event == "preview.open":
        payload = {key: payload[key] for key in ("url", "label") if key in payload}
        session = _live_session(sid, _APPS_SOURCES)
        if session is not None:
            payload["turn_id"] = session["active_turn_id"]
    server._emit(event, sid, payload)


def wire() -> None:
    """Install the renderer bridge once, before an agent freezes its tool list.

    Idempotent. Importing the advisory helper registers its ``session_search`` source, so a
    Desktop-wired process can enrich history results without core importing Atum code.
    """
    global _wired
    with _wire_lock:
        if _wired:
            return
        from tools import atum_advisory_search  # side effect: registers the history source
        from tools import desktop_ui

        desktop_ui.set_emitter(_desktop_ui_emit)
        desktop_ui.set_requester(_desktop_ui_request)
        _wired = True
        from tools.registry import invalidate_check_fn_cache

        invalidate_check_fn_cache()
        from model_tools import _clear_tool_defs_cache

        _clear_tool_defs_cache()
