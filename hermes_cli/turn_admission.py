"""Opt-in whole-turn policy, independent of prompt construction and observer hooks.

A host pins plugin IDs in the administrator-managed config overlay ``plugins.required_admission``. This declaration
survives a deleted plugin directory. Plugins register ``pre_turn_admission`` with
``fail_closed=True`` and may also declare ``fail_closed_admission: true`` in plugin.yaml
so import/registration failures block even before the callback exists.
"""
from __future__ import annotations

import math
import uuid
from contextvars import ContextVar

admission_turn_id: ContextVar[str] = ContextVar("admission_turn_id", default="")
from typing import Any


def _policy():
    from hermes_cli.plugins import _delivery_manager, load_config_readonly

    from hermes_cli.config import FailedConfigRead, _deep_merge, _expand_env_vars
    from hermes_cli.managed_scope import load_managed_config

    loaded = load_config_readonly()
    if isinstance(loaded, FailedConfigRead) or not isinstance(loaded, dict):
        raise ValueError("Admission cannot establish policy from failed config read or backup")
    # The native overlay wins at each leaf. Admission additionally requires proof
    # that reading the administrator's policy succeeded.
    try:
        managed = load_managed_config(strict=True)
    except Exception as exc:
        raise ValueError("Managed admission config could not be read") from exc
    profile_required = (loaded.get("plugins") or {}).get("required_admission")

    config = _deep_merge(dict(loaded), _expand_env_vars(managed)).get("plugins") or {}
    if not isinstance(config, dict):
        raise ValueError("plugins must be a mapping")
    required = config.get("required_admission")
    if required is None:
        required = []
    if isinstance(profile_required, list) and isinstance(required, list):
        required = list(dict.fromkeys(profile_required + required))
    if not isinstance(required, list) or any(not isinstance(key, str) or not key for key in required):
        raise ValueError("plugins.required_admission must be a list of plugin IDs")
    manager = _delivery_manager()
    with manager._discovery_lock:
        required = set(required) | manager._admission_required
        for key in required:
            plugin = manager._plugins.get(key)
            if plugin and plugin.manifest.kind in {"exclusive", "model-provider"}:
                raise ValueError(f"Required admission plugin {key} has unsupported kind {plugin.manifest.kind}")
    if not required and not manager._admission_callbacks:
        return manager, required, 30
    try:
        timeout = float(config.get("admission_timeout", 30))
    except (TypeError, ValueError) as exc:
        raise ValueError("plugins.admission_timeout must be positive and at most 600 seconds; 0 is not no limit") from exc
    if not math.isfinite(timeout) or timeout <= 0 or timeout > 600:
        raise ValueError("plugins.admission_timeout must be positive and at most 600 seconds; 0 is not no limit")
    return manager, required, timeout


def _missing(manager, required):
    return sorted(key for key in required | manager._admission_required if not manager._admission_callbacks.get(key)
                  or key not in manager._plugins or not manager._plugins[key].enabled
                  or manager._plugins[key].error)


def admission_readiness() -> dict[str, Any]:
    """Report configured-but-unavailable policy without executing admission callbacks."""
    try:
        manager, required, _ = _policy()
        with manager._discovery_lock:
            missing = _missing(manager, required)
    except Exception as exc:
        return {"status": "unavailable", "code": "admission_unavailable", "reason": str(exc)}
    return {"status": "unavailable" if missing else "ok", "missing_plugins": missing}


def _refusal(code: str, plugin: str = "", reason: str = "") -> dict[str, Any]:
    from agent.i18n import t

    notice = t("turn_admission.refused", code=code)
    return {
        "final_response": notice, "messages": [], "failed": True, "completed": False,
        "error": f"turn admission {code}" + (f" ({plugin})" if plugin else "") + (f" — {reason}" if reason else ""),
        "turn_exit_reason": "admission_denied",
        "admission": {"code": code, "plugin": plugin, "reason": reason},
    }


def check_turn_admission(**context: Any) -> dict[str, Any] | None:
    """Return a native failed result on refusal. None admits the turn.

    A strict callback must explicitly return True or {allow: True}. Deny, invalid
    responses, exceptions and abandoned/suppressed workers all refuse execution.
    Legacy observers retain their fail-open exception semantics.
    """
    from hermes_cli.plugins_dispatch import _HOOK_SKIPPED

    try:
        manager, required, timeout = _policy()
        with manager._discovery_lock:
            missing = _missing(manager, required)
            policies = {key: tuple(values) for key, values in manager._admission_callbacks.items()}
            callbacks = tuple(manager._hooks.get("pre_turn_admission", []))
    except Exception as exc:
        return _refusal("admission_unavailable", reason=str(exc))
    if missing:
        return _refusal("plugin_unavailable", missing[0])
    payload = dict(context)
    payload["turn_id"] = context.get("turn_id") or admission_turn_id.get() or str(uuid.uuid4())
    strict = {id(callback): key for key, values in policies.items() for callback in values}
    for callback in callbacks:
        plugin = strict.get(id(callback), "")
        try:
            result = manager._run_hook_callback_bounded("pre_turn_admission", callback, payload, timeout)
        except (Exception, SystemExit) as exc:
            manager._report_hook_failure("pre_turn_admission", callback, payload, exc)
            if id(callback) in strict:
                return _refusal("hook_error", plugin)
            continue
        if result is _HOOK_SKIPPED:
            if id(callback) in strict:
                return _refusal("hook_timeout", plugin)
            continue
        if result is True or isinstance(result, dict) and result.get("allow") is True:
            continue
        if id(callback) in strict or result is False or isinstance(result, dict) and result.get("allow") is False:
            reason = result.get("reason", "") if isinstance(result, dict) else ""
            return _refusal("denied", plugin, str(reason)[:200])
    return None
