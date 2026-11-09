"""Surface adapter for durable Hermes requests under current Atum authority.

The request checkpoint itself is reusable. This adapter binds one real consumer:
accepted gateway submissions using Atum's idempotent managed-model transport.
"""
from contextlib import contextmanager
import json
import logging
import os
from pathlib import Path
import re
import threading

_startup_lock = threading.Lock()
_started_profiles = set()

from agent.request_checkpoint import (
    CheckpointSuperseded, CheckpointUnavailable, RequestCheckpoint, cancel_checkpoint, read_checkpoint,
)


def _scope(agent, home, receipt):
    from agent.workspace_route_guard import managed_backend_headers, read_route_authority
    from hermes_cli.atum_training import training_context
    from hermes_cli.profiles import assign_profile_identity

    owner = receipt.get("owner")
    if not isinstance(owner, dict) or owner.get("agent_id") != assign_profile_identity(Path(home)):
        raise CheckpointUnavailable("task_checkpoint_identity_changed")
    if (agent.provider != "atum-managed" or agent.api_mode != "chat_completions"
            or not managed_backend_headers(agent.base_url).get("x-atum-backend-token")):
        raise CheckpointUnavailable("task_checkpoint_route_changed")
    authority = read_route_authority()
    if not re.fullmatch(r"[0-9a-f]{64}", str(authority.get("accountKey", ""))):
        raise CheckpointUnavailable("task_checkpoint_account_unavailable")
    with_db = agent._session_db
    lineage = with_db.get_compression_lineage(agent.session_id)
    root = lineage[0] if lineage else agent.session_id
    if root != owner.get("conversation_id"):
        raise CheckpointUnavailable("task_checkpoint_conversation_changed")
    return {"account": authority["accountKey"], "backend_agent": authority.get("agentId"),
            "home": str(Path(home).resolve()), "assistant": owner["agent_id"],
            "conversation": root, "provider": agent.provider, "model": agent.model,
            "api_mode": agent.api_mode, "training": training_context(agent.session_id)}


@contextmanager
def bind_checkpoint(agent, handle, *, recover=False):
    enabled = (getattr(agent, "provider", None) == "atum-managed"
               and os.environ.get("ATUM_FILESYSTEM_CAPABILITY_REQUIRED") == "1")
    if not enabled:
        if recover:
            raise CheckpointUnavailable("task_checkpoint_route_changed")
        yield
        return
    from agent.turn_checkpoint import runtime_policy, validate_turn
    from tui_gateway.surface_context import context_db

    # Wrappers with their own effects keep normal execution. They need an
    # explicit continuation contract before this adapter can recover them.
    try:
        runtime_policy(agent)
    except CheckpointUnavailable:
        if recover:
            raise
        yield
        return
    with context_db(handle["home"]) as db:
        receipt = json.loads(db.get_meta(handle["key"]))
    db = getattr(agent, "_session_db", None)
    if db is None or not getattr(db, "db_path", None):
        raise CheckpointUnavailable("task_checkpoint_storage_unavailable")
    if Path(db.db_path).resolve() != (Path(handle["home"]) / "state.db").resolve():
        raise CheckpointUnavailable("task_checkpoint_identity_changed")
    if receipt.get("status") != "accepted":
        raise CheckpointUnavailable("task_checkpoint_submission_closed")
    scope = _scope(agent, handle["home"], receipt)
    if recover:
        record = read_checkpoint(db, handle["key"])
        if record is None or record.get("phase") != "pending":
            raise CheckpointUnavailable("task_checkpoint_not_recoverable")
        validate_turn(agent, record["payload"])
    checkpoint = RequestCheckpoint(db, handle["key"], scope, recover=recover)
    handle["checkpoint_owner"] = checkpoint.value["owner"]
    missing = object()
    prior = {name: getattr(agent, name, missing) for name in ("_request_checkpoint", "_request_resume")}
    agent._request_checkpoint = checkpoint
    agent._request_resume = checkpoint.value["payload"] if recover else None
    try:
        yield
    except CheckpointSuperseded:
        raise
    except Exception:
        try:
            checkpoint.finish(completed=False)
        except Exception:
            logging.getLogger(__name__).warning("Could not finalize paused task checkpoint", exc_info=True)
        raise
    finally:
        for name, value in prior.items():
            if value is missing:
                delattr(agent, name)
            else:
                setattr(agent, name, value)


def pending_submission(home, owner):
    """Discover one conversation's retained work, never scan other profiles."""
    from tui_gateway.surface_context import context_db, receipt_key
    import uuid

    prefix = receipt_key(owner, str(uuid.UUID(int=0))).rsplit(":", 1)[0]
    with context_db(home) as db:
        key = db.get_meta("desktop.managed.last.v1:" + prefix)
        if not key or not key.startswith(prefix + ":"):
            return None
        receipt = json.loads(db.get_meta(key))
        if receipt.get("status") != "accepted" or receipt.get("owner") != owner:
            return None
        try:
            record = read_checkpoint(db, key)
        except CheckpointUnavailable:
            # Let the normal turn adapter render a scoped recovery failure.
            # Retain the corrupt checkpoint verbatim for inspection.
            return {"home": str(home), "key": key}
        if record is None or record.get("phase") in {"completed", "paused", "cancelled"}:
            return None
        return {"home": str(home), "key": key}


def latch_stop(home, owner):
    """Persist Stop before interrupting a process; never resurrect it on restart.

    Provider cancellation/settlement remains the managed proxy's responsibility.
    This fences execution only, and preserves uncertain monetary evidence.
    """
    from tui_gateway.surface_context import context_db, receipt_key
    import uuid

    prefix = receipt_key(owner, str(uuid.UUID(int=0))).rsplit(":", 1)[0]
    with context_db(home) as db:
        key = db.get_meta("desktop.managed.last.v1:" + prefix)
        if not key or not key.startswith(prefix + ":"):
            return
        # Recording the provider request and Stop can race on the same accepted
        # receipt. Re-read that harmless CAS race until Stop closes the current
        # accepted version; a terminal or foreign receipt remains untouched.
        while True:
            raw = db.get_meta(key)
            receipt = json.loads(raw)
            if receipt.get("owner") != owner or receipt.get("status") != "accepted":
                return
            receipt["status"] = "interrupted"
            if db.compare_meta(key, raw, json.dumps(receipt)):
                break
        try:
            cancel_checkpoint(db, key)
        except CheckpointUnavailable:
            # The closed receipt remains authoritative. Never erase corruption.
            pass


def pending_conversations(home):
    """Use the current profile's receipt index; never enumerate other employees."""
    from tui_gateway.surface_context import capabilities, context_db

    owner = capabilities(home)
    prefix = f"desktop.managed.last.v1:desktop.submission.v1:{owner['backend_id']}:{owner['agent_id']}:"
    with context_db(home) as db:
        indexed = db.list_meta_prefix(prefix)
    for indexed_row in indexed:
        index = indexed_row[0] if isinstance(indexed_row, tuple) else indexed_row
        if not isinstance(index, str):
            continue
        conversation = index[len(prefix):]
        try:
            pending = conversation and pending_submission(home, {**owner, "conversation_id": conversation})
        except (ValueError, TypeError):
            logging.getLogger(__name__).warning("Pending task receipt is unreadable for %s", conversation)
            continue
        if pending:
            yield conversation


def start_profile_recovery(server, transport=None):
    """Resume accepted work once after an authenticated backend connection.

    The existing session resume handler owns lineage, construction and isolation.
    Each accepted task is still checked against fresh account/agent authority at
    execution. A failed authority read leaves the next connection free to retry.
    """
    if os.environ.get("ATUM_FILESYSTEM_CAPABILITY_REQUIRED") != "1":
        return None
    from agent.workspace_route_guard import read_route_authority
    from tui_gateway.transport import bind_transport, reset_transport
    import uuid

    home = str(Path(server._hermes_home).resolve())
    with _startup_lock:
        if home in _started_profiles:
            return None
        _started_profiles.add(home)

    def run():
        token = bind_transport(transport)
        try:
            authority = read_route_authority()
            if not re.fullmatch(r"[0-9a-f]{64}", str(authority.get("accountKey", ""))):
                raise CheckpointUnavailable("task_checkpoint_account_unavailable")
            for conversation in pending_conversations(home):
                result = server.handle_request({"jsonrpc": "2.0", "id": "recover-" + uuid.uuid4().hex,
                                                "method": "session.resume",
                                                "params": {"session_id": conversation}})
                if result and result.get("error"):
                    server.logger.warning("Pending task attachment failed for %s", conversation)
        except Exception:
            server.logger.warning("Pending task startup recovery is unavailable", exc_info=True)
            with _startup_lock:
                _started_profiles.discard(home)
        finally:
            reset_transport(token)

    thread = threading.Thread(target=run, name="atum-task-recovery", daemon=True)
    thread.start()
    return thread


def resume_pending(server, sid, session):
    """Attach retained work through the gateway's normal isolated/inline path.

    Called after a cold session attachment or a confirmed compute-host death.
    It never navigates a window, fabricates a user prompt, or bypasses isolation.
    """
    if os.environ.get("ATUM_FILESYSTEM_CAPABILITY_REQUIRED") != "1":
        return False
    if session.get("async_delivery") is False:
        return False  # its client drives every turn and never expects a surprise recovery turn
    from tui_gateway.surface_context import capabilities
    import threading
    import uuid

    with session["history_lock"]:
        if session.get("running") or session.get("_turn_cancel_requested"):
            return False
    home = session.get("profile_home") or server._hermes_home
    try:
        owner = capabilities(server._hermes_home, session)
        handle = pending_submission(home, owner)
    except Exception:
        server.logger.warning("Pending task could not be recovered for %s", sid)
        return False
    if handle is None:
        return False
    with session["history_lock"]:
        if session.get("running") or session.get("_turn_cancel_requested"):
            return False
        session["running"] = True
        server._start_inflight_turn(session, "")
    rid = "recover-" + uuid.uuid4().hex
    context = {"submission_receipt": handle, "resume_request": True}
    cfg = server._load_dashboard_process_isolation_config()
    if server._session_uses_compute_host(session, cfg):
        result = server._submit_prompt_to_compute_host(rid, sid, session, "", **context)
        if result.get("error"):
            with session["history_lock"]:
                session["running"] = False
                server._clear_inflight_turn(session)
            return False
        return True
    server._start_agent_build(sid, session)

    def run():
        # Reuse normal gateway construction's bounded readiness policy.
        build_error = server._wait_agent(session, rid)
        if build_error or session.get("agent") is None:
            with session["history_lock"]:
                session["running"] = False
                server._clear_inflight_turn(session)
            server._emit("error", sid, {"message": "This task is paused because its employee could not reconnect."})
            return
        with session["history_lock"]:
            if session.get("_turn_cancel_requested") or not session.get("running"):
                return
        server._run_prompt_submit(rid, sid, session, "", **context)

    thread = threading.Thread(target=run, daemon=True)
    session["_run_thread"] = thread
    thread.start()
    return True
