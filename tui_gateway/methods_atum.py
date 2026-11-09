"""Atum adapters bound onto the split TUI gateway facade.

Hermes owns sessions, request cancellation/replay, and durable submission
receipts. This module supplies only product authority projection and bounded
HTTP/native bridge lookups.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()
method = _registry.method


@method("runtime.quiesce")
def _runtime_quiesce(rid, params: dict) -> dict:
    """Wait briefly for post-turn review so an exported home includes what the turn learned."""
    try:
        timeout = max(0.0, min(float(params.get("timeout_ms", 60_000)) / 1000.0, 60.0))
    except (TypeError, ValueError):
        return _err(rid, 4009, "invalid quiesce timeout")
    deadline = time.monotonic() + timeout
    for thread in [item for item in threading.enumerate() if item.name == "bg-review"]:
        thread.join(max(0.0, deadline - time.monotonic()))
    pending = sorted({
        item.name
        for item in threading.enumerate()
        if item.name == "bg-review" and item.is_alive()
    })
    return _ok(rid, {"drained": not pending, "pending": pending})


@method("heartbeat.ensure")
def _heartbeat_ensure(rid, params: dict) -> dict:
    """Seed the default assistant's sealed local check-in ticker."""
    try:
        from cron.check_ins import ensure_job

        return _ok(rid, ensure_job(force=params.get("force") is True))
    except Exception as exc:
        logger.warning("check-in job not seeded: %s", type(exc).__name__)
        return _err(rid, 5000, "check-ins unavailable")


@method("cron.run_claimed")
def _cron_run_claimed(rid, params: dict) -> dict:
    try:
        from tui_gateway.native_cloud_job import run_claimed_native_job

        return _ok(rid, run_claimed_native_job(params))
    except ValueError:
        return _err(rid, 4009, "invalid native cloud job")
    except Exception as exc:
        logger.warning("native cloud job unavailable: %s", type(exc).__name__)
        return _err(rid, 5032, "native cloud job unavailable")


@method("cron.run_claimed_desktop")
def _cron_run_claimed_desktop(rid, params: dict) -> dict:
    try:
        from tui_gateway.native_cloud_job import run_claimed_desktop_job

        return _ok(rid, run_claimed_desktop_job(params))
    except ValueError:
        return _err(rid, 4009, "invalid native desktop job")
    except Exception as exc:
        logger.warning("native desktop job unavailable: %s", type(exc).__name__)
        return _err(rid, 5032, "native desktop job unavailable")


@method("context.capabilities")
def _context_capabilities(rid, params: dict) -> dict:
    from tui_gateway.surface_context import capabilities

    session = None
    if params.get("session_id"):
        session, err = _sess_nowait(params, rid)
        if err:
            return err
    try:
        return _ok(rid, capabilities(_hermes_home, session, _profile_home(params.get("profile"))))
    except Exception:
        return _err(rid, 5030, "stable context identity unavailable")


@method("prompt.submission_status")
def _submission_status(rid, params: dict) -> dict:
    from tui_gateway.surface_context import capabilities, submission_status

    session, err = _sess_nowait(params, rid)
    if err:
        return err
    try:
        owner = capabilities(_hermes_home, session)
        return _ok(rid, submission_status(
            session.get("profile_home") or _hermes_home, owner, params.get("submission_id")))
    except (ValueError, TypeError):
        return _err(rid, 4004, "invalid submission identity")
    except Exception:
        return _err(rid, 5030, "submission receipt unavailable")


@method("prompt.managed_cancel")
def _managed_cancel(rid, params: dict) -> dict:
    from tui_gateway.surface_context import capabilities, cancel_managed_submission

    session, err = _sess_nowait(params, rid)
    if err:
        return err
    if session.get("running"):
        return _err(rid, 4009, "Stop the running task before clearing its recovery state")
    try:
        owner = capabilities(_hermes_home, session)
        return _ok(rid, cancel_managed_submission(
            session.get("profile_home") or _hermes_home, owner))
    except Exception:
        return _err(
            rid,
            5030,
            "Atum retried but could not stop this task. Check whether it is still running, then try Stop task again.",
        )


@method("store.runtime.reconcile")
def _store_runtime_reconcile(rid, params: dict) -> dict:
    try:
        from hermes_cli.atum_store_runtime import reconcile_store_runtime

        return _ok(rid, reconcile_store_runtime(params))
    except Exception as exc:
        from hermes_cli.atum_store_runtime import StoreRuntimeError

        code = (
            str(exc)
            if isinstance(exc, StoreRuntimeError)
            else "store_runtime_unavailable"
        )
        return _err(rid, 5026, code)


@method("training.status")
def _training_status(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    try:
        from hermes_cli.atum_training import _training_state
        from tui_gateway.managed_model_failure import managed_identity
        from tui_gateway.surface_context import capabilities

        owner = capabilities(_hermes_home, session)
        state = _training_state(
            owner["conversation_id"],
            session.get("profile_home") or _hermes_home,
        )
        return _ok(rid, {
            "managed": managed_identity(session) is not None,
            "can_bind": not (
                session.get("history")
                or session.get("display_history_prefix")
                or session.get("running")
                or session.get("inflight_turn")
            ),
            "agent_id": owner["agent_id"],
            "conversation_id": owner["conversation_id"],
            "task": state[2] if state else None,
        })
    except (ValueError, TypeError, OSError):
        return _err(rid, 4004, "training task binding unavailable")


@method("training.bind")
def _training_bind(rid, params: dict) -> dict:
    session, err = _sess_nowait(params, rid)
    if err:
        return err
    try:
        from hermes_cli.atum_training import bind_task
        from tui_gateway.managed_model_failure import managed_identity
        from tui_gateway.surface_context import capabilities

        if managed_identity(session) is None:
            raise ValueError("training requires an Atum managed task")
        with session["history_lock"]:
            if (
                session.get("history")
                or session.get("display_history_prefix")
                or session.get("running")
                or session.get("inflight_turn")
            ):
                raise ValueError("start a new conversation to use different training")
            owner = capabilities(_hermes_home, session)
            return _ok(
                rid,
                bind_task(
                    session.get("profile_home") or _hermes_home,
                    owner,
                    params.get("task"),
                ),
            )
    except (ValueError, TypeError, OSError):
        return _err(rid, 4004, "training task binding unavailable")


def word_document_request_scope(request_id: str, sid: str, turn_id: str) -> dict | None:
    """The live authority of one open Word request, without exposing waiter state."""
    from tui_gateway import server_requests

    request = server_requests.open_request(request_id)
    with _sessions_lock:
        session = _sessions.get(sid)
    params = request.get("params") if isinstance(request, dict) else None
    if (not request or request.get("method") != "word.document" or not isinstance(params, dict)
            or params.get("session_id") != sid or params.get("turn_id") != turn_id
            or float(params.get("expires_at") or 0) <= time.time()
            or not session or session.get("source") not in {"desktop", "matrix"}
            or not session.get("running") or session.get("active_turn_id") != turn_id):
        return None
    return {**params, "session_id": sid, "durable_session_id": session["session_key"]}


@method("word.document.resolve")
def _word_document_resolve(rid, params: dict) -> dict:
    sid = params.get("session_id", "")
    turn_id = params.get("turn_id", "")
    request_id = params.get("request_id", "")
    if any(not isinstance(value, str) or not value or len(value) > 256
           for value in (request_id, sid, turn_id)):
        return _err(rid, 4009, "invalid Word request")
    with _sessions_lock:
        session = _sessions.get(sid)
        if (not session or session.get("source") != "matrix"
                or session.get("transport") is not (current_transport() or _stdio_transport)):
            return _err(rid, 4009, "Word request scope mismatch")
    scope = word_document_request_scope(request_id, sid, turn_id)
    return _ok(rid, scope) if scope else _err(rid, 4009, "Word request unavailable")


def advisory_search_request_scope(request_id: str, sid: str, turn_id: str) -> dict | None:
    """Resolve one still-open advisory read through the authenticated backend."""
    from hermes_cli.profiles import assign_profile_identity
    from tui_gateway import server_requests

    request = server_requests.open_request(request_id)
    params = request.get("params") if isinstance(request, dict) else None
    with _sessions_lock:
        session = _sessions.get(sid)
    if (not request or request.get("method") != "atum.advisory.search" or not isinstance(params, dict)
            or params.get("session_id") != sid or params.get("turn_id") != turn_id
            or not session or not session.get("running") or session.get("active_turn_id") != turn_id):
        return None
    home = Path(session.get("profile_home") or get_hermes_home())
    try:
        identity = assign_profile_identity(home)
    except Exception:
        return None
    return {**params, "identity_id": identity, "session_id": sid,
            "durable_session_id": session["session_key"], "source": session.get("source")}


def register(server):
    bind_module(globals(), server)
    server._LONG_HANDLERS = server._LONG_HANDLERS | {
        "runtime.quiesce",
        "cron.run_claimed",
        "cron.run_claimed_desktop",
    }
