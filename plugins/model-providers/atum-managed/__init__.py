"""Atum's app-managed inference provider.

The desktop process owns the signed-in Atum session and exposes a random,
loopback-only OpenAI-compatible proxy to its managed Hermes child. The real
provider credential and the user's Atum bearer never enter the Python runtime.
"""

import re

from providers import register_provider
from providers.base import ProviderProfile


class AtumManagedProfile(ProviderProfile):
    """Keep managed request shaping on the registered provider's real path."""

    @staticmethod
    def classify_api_error(error, *, error_code="", message="", body=None, **_context):
        """Treat the managed route's daily allowance as a terminal billing limit.

        This provider-scoped seam may safely use the proxy's message fallback:
        it cannot misclassify another provider merely mentioning the code.
        """
        fields = [error_code, message]
        if isinstance(body, dict):
            nested = body.get("error")
            for scope in (body, nested):
                if isinstance(scope, dict):
                    fields.extend(scope.get(key) for key in ("code", "type", "message", "detail"))
            if isinstance(nested, str):
                fields.append(nested)
        if not any(
            isinstance(value, str) and "daily_cap_exhausted" in value.lower()
            for value in fields
        ):
            return None
        return {
            "reason": "billing",
            "retryable": False,
            "should_rotate_credential": False,
            "should_fallback": False,
            "error_context": {"atum_daily_cap": True},
        }

    def build_api_kwargs_extras(self, *, reasoning_config=None, **context):
        enabled = not (isinstance(reasoning_config, dict) and reasoning_config.get("enabled") is False)
        top_level = {}
        if enabled:
            levels = {"minimal": "low", "low": "low", "medium": "high", "high": "high",
                      "xhigh": "max", "max": "max", "ultra": "max"}
            top_level["reasoning_effort"] = levels.get((reasoning_config or {}).get("effort"), "high")
        session_id = context.get("session_id")
        if isinstance(session_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", session_id):
            top_level["extra_headers"] = {"x-atum-session-id": session_id}
        from agent.workspace_route_guard import managed_backend_headers
        headers = managed_backend_headers(context.get("base_url"), session_id)
        if headers:
            top_level.setdefault("extra_headers", {}).update(headers)
        return {"thinking": {"type": "enabled" if enabled else "disabled"}}, top_level


atum_managed = AtumManagedProfile(
    name="atum-managed",
    display_name="Atum",
    description="Included with Atum",
    env_vars=(
        "ATUM_MANAGED_MODEL_PROXY_TOKEN",
        "ATUM_MANAGED_MODEL_BASE_URL",
    ),
    base_url="",
    fallback_models=("binh-minh", "nguyet-thuc", "nhat-thuc"),
    classify_api_error=AtumManagedProfile.classify_api_error,
    supports_health_check=False,
    supports_vision=False,
    default_max_tokens=8192,
)

register_provider(atum_managed)
