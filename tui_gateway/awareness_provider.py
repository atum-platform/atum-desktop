"""Construction seam for Atum's native-bound awareness provider.

The binding is internal session state installed by a trusted host adapter before
agent construction. It is deliberately not inferred from model arguments or
ambient process state. Until a host installs that binding, ordinary Hermes
sessions build exactly the upstream memory stack.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any


def build_memory_manager(session: dict | None, sid: str, session_id: str):
    binding_data = (session or {}).get("_atum_awareness_binding")
    if not isinstance(binding_data, dict):
        return None
    expected = {"audience", "destination", "account_fence_active", "generation"}
    if set(binding_data) != expected or not isinstance(binding_data.get("generation"), str):
        raise ValueError("invalid awareness binding")
    frozen = copy.deepcopy(binding_data)
    home = Path((session or {}).get("profile_home") or _current_home()).expanduser().resolve()

    from hermes_cli.profiles import assign_profile_identity
    from agent.atum_awareness import AtumAwarenessProvider, AwarenessRunBinding
    from agent.memory_manager import MemoryManager

    principal = assign_profile_identity(home)

    def current() -> bool:
        live = _live_session(sid)
        return bool(
            live is session
            and live.get("_atum_awareness_binding") == frozen
            and not live.get("_closing")
            and not live.get("_turn_cancel_requested")
        )

    def retrieve(request: dict[str, Any], cancelled) -> Any:
        if cancelled.is_set() or not current():
            raise RuntimeError("awareness_fresh_session_required")
        live = _live_session(sid)
        turn_id = str((live or {}).get("active_turn_id") or "")
        if not turn_id or not (live or {}).get("running"):
            raise RuntimeError("awareness_fresh_session_required")
        from tui_gateway import server_requests
        result = server_requests.send(
            "atum.awareness.retrieve", sid,
            {"turn_id": turn_id, "request": request}, timeout=1.5)
        value = (result or {}).get("value")
        if cancelled.is_set() or not current() or not isinstance(value, str):
            raise RuntimeError("awareness_fresh_session_required")
        return json.loads(value)

    def mark_google() -> bool:
        if frozen["destination"] != "local" or not current():
            return False
        from agent.atum_google_fence import mark_holding
        mark_holding()
        return True

    def invalidate() -> None:
        live = _live_session(sid)
        if live is None:
            return
        live["_turn_cancel_requested"] = True
        agent = live.get("agent")
        if agent is not None and hasattr(agent, "interrupt"):
            try:
                agent.interrupt("awareness authority changed")
            except Exception:
                pass

    provider = AtumAwarenessProvider(
        AwarenessRunBinding(
            session_id=session_id,
            hermes_home=str(home),
            agent_principal=principal,
            audience=frozen["audience"],
            account_fence_active=frozen["account_fence_active"],
            destination=frozen["destination"],
        ),
        retrieve=retrieve,
        is_current=current,
        mark_google_derived=mark_google,
        invalidate_run=invalidate,
    )
    manager = MemoryManager()
    manager.add_provider(provider)
    manager.initialize_all(session_id=session_id, hermes_home=str(home), agent_identity=principal)
    return manager if manager.providers else None


def _current_home() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


def _live_session(sid: str) -> dict | None:
    from tui_gateway import server
    with server._sessions_lock:
        return server._sessions.get(sid)
