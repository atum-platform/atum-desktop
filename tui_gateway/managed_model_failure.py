"""Fail-closed projection of Atum managed-model failures for desktop clients.

Hermes deliberately owns the provider loop and its generic failure summaries.
This module is only a consumer boundary: it recognizes the frozen errors emitted
by the local managed proxy and platform reservation/completion endpoints, then
publishes bounded recovery metadata without leaking provider response bodies.
"""

from __future__ import annotations

import re
from typing import Any

VERSION = 1
MANAGED_ALIASES = frozenset({"binh-minh", "nguyet-thuc", "nhat-thuc"})

_POLICY: dict[str, tuple[str, str, bool, bool]] = {
    "authentication_expired": ("pre_dispatch", "reauthenticate", True, True),
    "rate_limited": ("pre_dispatch", "retry", True, True),
    "provider_rate_limited": ("post_dispatch", "retry", True, False),
    "provider_call_limit_exceeded": ("post_dispatch", "edit_request", False, False),
    "insufficient_protons": ("pre_dispatch", "review_access", False, True),
    "funding_required": ("pre_dispatch", "review_access", False, True),
    "managed_capacity_wait": ("pre_dispatch", "wait_for_turn", True, True),
    "managed_request_in_progress": ("unknown", "pause", False, False),
    "managed_request_outcome_unknown": ("unknown", "pause", False, False),
    "managed_request_cancelled": ("unknown", "pause", False, False),
    "invalid_managed_request_id": ("pre_dispatch", "repair", False, True),
    "training_managed_route_required": ("pre_dispatch", "edit_request", False, True),
    "execution_route_changed": ("pre_dispatch", "review_hiring", False, True),
    "model_requirements_conflict": ("pre_dispatch", "review_hiring", False, True),
    "model_spending_confirmation_required": ("pre_dispatch", "edit_request", False, True),
    "hire_task_required": ("pre_dispatch", "review_hiring", False, True),
    "hire_paused": ("pre_dispatch", "review_hiring", False, True),
    "training_required": ("pre_dispatch", "review_training", False, True),
    "training_unavailable": ("pre_dispatch", "retry", True, True),
    "training_task_invalid": ("pre_dispatch", "review_training", False, True),
    "training_context_unavailable": ("pre_dispatch", "edit_request", False, True),
    "managed_request_conflict": ("unknown", "pause", False, False),
    "managed_retry_exhausted": ("pre_dispatch", "retry", True, True),
    "managed_dispatch_rejected": ("pre_dispatch", "retry", True, True),
    "managed_response_expired": ("unknown", "pause", False, False),
    "managed_request_recovery_corrupt": ("unknown", "pause", False, False),
    "managed_request_recovery_unavailable": ("unknown", "review_account", False, False),
    "denied": ("pre_dispatch", "review_account", False, True),
    "model_reserved": ("pre_dispatch", "edit_request", False, True),
    "managed_model_disabled": ("pre_dispatch", "retry", True, True),
    "reconciliation_pending": ("pre_dispatch", "retry", True, True),
    "reservation_active": ("pre_dispatch", "wait_for_turn", True, True),
    "managed_turn_in_progress": ("pre_dispatch", "wait_for_turn", True, True),
    "managed_request_too_large": ("pre_dispatch", "edit_request", False, True),
    "invalid_managed_request": ("pre_dispatch", "edit_request", False, True),
    "unsupported_managed_parameter": ("pre_dispatch", "edit_request", False, True),
    "managed_model_transport_failed": ("unknown", "retry", True, False),
    "managed_model_invalid_response": ("post_dispatch", "retry", True, False),
    "managed_model_unavailable": ("unknown", "retry", True, False),
    "managed_proxy_authentication_required": ("pre_dispatch", "repair", False, True),
    "managed_proxy_unavailable": ("pre_dispatch", "repair", False, True),
}

_FALLBACK = {
    "auth": "authentication_expired",
    "auth_permanent": "authentication_expired",
    "rate_limit": "rate_limited",
    "upstream_rate_limit": "provider_rate_limited",
    "payload_too_large": "managed_request_too_large",
    "context_overflow": "managed_request_too_large",
    "format_error": "invalid_managed_request",
    "timeout": "managed_model_transport_failed",
    "server_error": "managed_model_transport_failed",
    "overloaded": "managed_model_transport_failed",
}


def managed_identity(session: dict[str, Any]) -> tuple[str, str] | None:
    """Return provider/alias only when the live session is unambiguously managed."""
    candidates: list[dict[str, Any]] = []
    agent = session.get("agent")
    if agent is not None:
        candidates.append(
            {
                "provider": getattr(agent, "requested_provider", None)
                or getattr(agent, "provider", None),
                "model": getattr(agent, "model", None),
            }
        )
    for key in ("model_override", "resume_runtime_overrides"):
        value = session.get(key)
        if isinstance(value, dict):
            candidates.append(value)
    for candidate in candidates:
        provider = str(candidate.get("provider") or "").strip().lower()
        model = str(candidate.get("model") or "").strip().lower()
        if provider == "atum-managed" and model in MANAGED_ALIASES:
            return "atum-managed", model
    return None


def project_managed_failure(
    session: dict[str, Any],
    *,
    text: Any = "",
    failure_reason: Any = "",
    forced_code: str | None = None,
) -> dict[str, Any] | None:
    """Project a known failure; unknown/non-managed inputs fail closed to None."""
    identity = managed_identity(session)
    if identity is None:
        return None
    raw = str(text or "")[:2048]
    code = forced_code if forced_code in _POLICY else None
    from agent.request_checkpoint import CheckpointUnavailable
    if code is None and (isinstance(text, CheckpointUnavailable) or re.search(r"(?<![a-z0-9_])task_checkpoint_[a-z_]+(?![a-z0-9_])", raw.lower())):
        code = ("managed_request_recovery_corrupt" if "task_checkpoint_invalid" in raw
                else "managed_request_conflict")
    explicit_code = code is not None
    if code is None and (
        re.search(r"[\"'](?:error|code)[\"']\s*:\s*[\"']denied[\"']", raw.lower())
        or re.search(r"(?<![a-z0-9_])owner_managed_denied(?![a-z0-9_])", raw.lower())
    ):
        # Bare English 'denied' also appears in local tool/OS failures. Only
        # structured wire errors (including the SDK's dict repr), the namespaced
        # platform error, or a trusted forced_code can select account recovery.
        code, explicit_code = "denied", True
    if code is None:
        matches: list[tuple[int, str]] = []
        for candidate in _POLICY:
            if candidate == "denied":
                continue
            match = re.search(rf"(?<![a-z0-9_]){re.escape(candidate)}(?![a-z0-9_])", raw.lower())
            if match:
                matches.append((match.start(), candidate))
        if matches:
            code = min(matches)[1]
            explicit_code = True
    if code is None and "response_format is not supported by atum managed models" in raw.lower():
        code = "unsupported_managed_parameter"
        explicit_code = True
    if code is None:
        code = _FALLBACK.get(str(failure_reason or "").strip().lower())
    if code is None:
        return None
    phase, recovery, transient, preserve_draft = _POLICY[code]
    # Hermes fallbacks are lossy summaries produced after an attempted call;
    # never inherit a proxy code's stronger pre-dispatch/draft claim.
    if not explicit_code and code in {"managed_request_too_large", "invalid_managed_request"}:
        phase, preserve_draft = "unknown", False
    return {
        "version": VERSION,
        "code": code,
        "access_alias": identity[1],
        "phase": phase,
        "recovery": recovery,
        "transient": transient,
        "preserve_draft": preserve_draft,
    }
