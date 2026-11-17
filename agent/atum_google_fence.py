"""Atum's Google fence (launch item G2-19): where an assistant holding Google data may send it.

Atum Desktop sets ``ATUM_GOOGLE_FENCE_ROUTE`` only in the launch of its default
assistant when that assistant has Google tools or may already hold Google data
(Gmail, Calendar or Drive results in its history or memory). Its value is the
desktop's loopback model proxy, which sends every request of a latched assistant
to the gateway's protected route: zero data retention, never used for training
(Google's Limited Use policy). While it is set:

- every model call this process makes (the main loop, helper calls such as
  compression and vision, delegated children, fallbacks) must go to exactly that
  address with the OpenAI chat format, and external memory providers do not
  start. Anything else is refused before a request is built;
- holding Google data does not restrict tool use, including cloud or local
  speech. A turn whose Google content looked like a prompt injection still
  limits tools through ``agent.atum_google_injection.refusal``, including the
  owner-chats policy mapping. The tool list stays unchanged for prompt caching.

Ordinary Hermes installs never set the variable and never enter this path. An
unusable value keeps the fence on and refuses every route: a misconfiguration
must never open it.

Native host-authority source bindings scope newly read Google data to their own
execution, shared by its copied worker contexts. They do not latch the whole
gateway or another session. Legacy Desktop reads and the launch latch keep their
existing process/home-wide protection; model-route enforcement is unchanged.
"""

from __future__ import annotations

import logging
import os
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Callable, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

ROUTE_ENV = "ATUM_GOOGLE_FENCE_ROUTE"
MODEL_BASE_ENV = "ATUM_MODEL_BASE_URL"
#: Set by Atum when the assistant's home already holds Google data (its latch).
LATCHED_ENV = "ATUM_GOOGLE_LATCHED"

#: Egress tools limited by the prompt-injection policy on a tainted turn.
EGRESS_TOOLS = frozenset(
    {
        "web_search",
        "web_extract",
        "x_search",
        "image_generate",
        "text_to_speech",
        "send_message",
        "atum_agents",
        "atum_agent_tasks",
        "kanban_create",
        "kanban_comment",
        "kanban_attach",
        "kanban_attach_url",
        "kanban_link",
        "kanban_complete",
        "kanban_block",
        "kanban_unblock",
        "kanban_heartbeat",
    }
)
EGRESS_PREFIXES = ("browser_",)

_holding_lock = threading.Lock()
_holding = False
_execution_holding: ContextVar[tuple[Callable[[], bool], threading.Event] | None] = ContextVar(
    "atum_google_execution_holding", default=None,
)


@contextmanager
def scoped_source_holding(session_matches: Callable[[], bool]):
    """One trusted source execution; workers share the marker, not a global latch."""
    previous = _execution_holding.get()
    if previous is not None and previous[0]():
        # A nested binding for the same session cannot clear its existing fence.
        yield
        return
    token = _execution_holding.set((session_matches, threading.Event()))
    try:
        yield
    finally:
        _execution_holding.reset(token)

#: Memory providers that keep everything on this Mac: the built-in files and the
#: local brain, which applies the Google fence itself (spec/awareness/v1 §4.6).
LOCAL_MEMORY_PROVIDERS = frozenset({"builtin", "atum_awareness"})

MESSAGE = (
    "This assistant has your Gmail, Calendar or Drive information, so it only uses "
    "Atum's protected model. Nothing was sent to any other model."
)


class GoogleFenceRouteRequired(RuntimeError):
    """A model call would leave the protected route of an assistant that may hold Google data.

    ``status_code`` 400 makes the agent loop treat it as a non-retryable client
    error: it stops instead of retrying the same refused route.
    """

    status_code = 400

    def __init__(self, message: str = MESSAGE):
        super().__init__(message)


def _loopback_v1(value: Any) -> Optional[str]:
    """``http://127.0.0.1:<port>/v1`` for exactly that shape, else None."""
    try:
        parsed = urlparse(str(value or "").strip())
        if (
            parsed.scheme == "http"
            and parsed.hostname == "127.0.0.1"
            and parsed.port
            and not parsed.username
            and not parsed.password
            and parsed.path.rstrip("/") == "/v1"
            and not parsed.query
            and not parsed.fragment
        ):
            return f"http://127.0.0.1:{parsed.port}/v1"
    except ValueError:
        pass
    return None


def _http_v1(value: Any) -> Optional[str]:
    """A credential-free plain-HTTP broker ``/v1`` URL, normalized, else None."""
    try:
        parsed = urlparse(str(value or "").strip())
        if (
            parsed.scheme == "http"
            and parsed.hostname
            and parsed.port
            and not parsed.username
            and not parsed.password
            and parsed.path.rstrip("/") == "/v1"
            and not parsed.query
            and not parsed.fragment
        ):
            return f"http://{parsed.hostname}:{parsed.port}/v1"
    except ValueError:
        pass
    return None


def _protected_v1(value: Any) -> Optional[str]:
    """Desktop loopback, or exactly the cloud task's controller model broker."""
    loopback = _loopback_v1(value)
    if loopback:
        return loopback
    candidate = _http_v1(value)
    model_broker = _http_v1(os.environ.get(MODEL_BASE_ENV))
    return candidate if candidate and candidate == model_broker else None


def broker_origin(value: Any) -> Optional[str]:
    """A desktop loopback origin, or exactly ``ATUM_MODEL_BASE_URL``'s cloud origin.

    Cloud Google is full-power after platform migration 0290: it uses the current turn's
    controller broker without activating the legacy protected-route fence.
    """
    try:
        parsed = urlparse(str(value or "").strip())
        if (
            parsed.scheme == "http"
            and parsed.hostname
            and parsed.port
            and not parsed.username
            and not parsed.password
            and parsed.path in ("", "/")
            and not parsed.query
            and not parsed.fragment
        ):
            origin = f"http://{parsed.hostname}:{parsed.port}"
            protected = _protected_v1(f"{origin}/v1")
            configured = _protected_v1(os.environ.get(ROUTE_ENV))
            model_broker = _protected_v1(os.environ.get(MODEL_BASE_ENV))
            if parsed.hostname == "127.0.0.1" or (
                protected and protected in (configured, model_broker)
            ):
                return origin
    except ValueError:
        pass
    return None


def fence_active() -> bool:
    return bool(os.environ.get(ROUTE_ENV, "").strip())


def fence_route() -> Optional[str]:
    """None when the fence is off; "" when it is on but names no usable route."""
    if not fence_active():
        return None
    return _protected_v1(os.environ.get(ROUTE_ENV)) or ""


def native_selection() -> dict:
    """Read the host-owned selection at decision time, including atomic stage writes."""
    import json
    from hermes_cli.managed_scope import get_managed_dir, load_managed_config
    managed = load_managed_config() or {}
    if os.environ.get("ATUM_NATIVE_MODEL_CONFIG") and not managed and (get_managed_dir() is not None or os.environ.get("HERMES_MANAGED_DIR")):
        raise GoogleFenceRouteRequired()
    selected = managed.get("atum_native_selection")
    if selected is None:
        selected = json.loads(os.environ.get("ATUM_NATIVE_MODEL_CONFIG", "{}"))
    if not isinstance(selected, dict):
        raise GoogleFenceRouteRequired()
    return selected


def native_protected() -> bool:
    selected = native_selection()
    return selected.get("native_protected") is True and selected.get("model") != "google-protected"


def relay_latched() -> bool:
    """Host-certified ChatGPT selection; request admission remains the host's job."""
    selected = native_selection()
    relay = selected.get("chatgpt_relay")
    confirmation = selected.get("chatgpt_google")
    return (selected.get("google_latched") is True
            and selected.get("provider") == "openai-codex"
            and not selected.get("native_protected")
            and isinstance(relay, dict) and isinstance(confirmation, dict)
            and isinstance(relay.get("connection_id"), str) and bool(relay["connection_id"])
            and type(relay.get("revision")) is int and relay["revision"] >= 0
            and confirmation.get("current") is True
            and confirmation.get("wording_version") == "chatgpt-google-v1"
            and confirmation.get("connection_id") == relay["connection_id"]
            and type(confirmation.get("revision")) is int and confirmation["revision"] >= 0)


def route_allowed(base_url: Any, api_mode: Optional[str] = None) -> bool:
    if native_protected():
        return str(base_url).rstrip("/") == "https://openrouter.ai/api/v1" and api_mode in (None, "", "chat_completions")
    if native_selection().get("google_latched"):
        if not relay_latched() or api_mode not in (None, "", "chat_completions"):
            return False
        # Text helpers use the authenticated host relay. Media uses the guarded
        # OpenRouter profile; the host admits its protected media selection.
        return (str(base_url).rstrip("/") == "https://openrouter.ai/api/v1"
                or bool(_http_v1(os.environ.get(MODEL_BASE_ENV)))
                and _http_v1(base_url) == _http_v1(os.environ.get(MODEL_BASE_ENV)))
    route = fence_route()
    if route is None:
        return True
    if not route:
        return False
    if api_mode not in (None, "", "chat_completions"):
        return False
    return _protected_v1(base_url) == route


_UNRESOLVED_CLIENT = object()


def assert_route(base_url: Any, api_mode: Optional[str] = None, *, client: Any = _UNRESOLVED_CLIENT) -> None:
    """Raise before any request is built when a call would leave the protected route."""
    if not route_allowed(base_url, api_mode) or (client is not _UNRESOLVED_CLIENT and not client_allowed(client)):
        raise GoogleFenceRouteRequired()


def client_allowed(client: Any) -> bool:
    """A resolved helper client may be used only when it targets the protected route."""
    if native_protected():
        if type(client).__name__ == "_AuxProbeClientStub":
            # Availability probes carry only base_url (any other attribute raises by design).
            return route_allowed(client.base_url)
        return (getattr(client, "_atum_native_guard_provider", None) == "openrouter"
                and route_allowed(getattr(client, "base_url", None)))
    if native_selection().get("google_latched"):
        if not relay_latched() or client is None:
            return False
        base_url = getattr(client, "base_url", None)
        if not route_allowed(base_url):
            return False
        if str(base_url).rstrip("/") == "https://openrouter.ai/api/v1":
            return (type(client).__name__ == "_AuxProbeClientStub"
                    or getattr(client, "_atum_native_guard_provider", None) == "openrouter")
        return True
    route = fence_route()
    if route is None or client is None:
        return True
    return bool(route) and _protected_v1(getattr(client, "base_url", None)) == route


def fence_resolved_client(result: Any) -> Any:
    """``resolve_provider_client``'s answer, or no client when it would leave the route.

    Callers already treat ``(None, None)`` as "this provider has no client" and
    try the next one, which is fenced the same way; when none is allowed the
    helper task simply has no model, which is the safe outcome.
    """
    if not isinstance(result, tuple) or not result:
        return result
    if client_allowed(result[0]):
        return result
    logger.info("Helper model refused: this assistant's model calls stay on Atum's protected route.")
    return (None,) * len(result)


def memory_provider_allowed(name: str) -> bool:
    """External memory providers send conversation content off this Mac."""
    return not fence_active() or name in LOCAL_MEMORY_PROVIDERS


def holding_google() -> bool:
    """This execution holds Google data, or its legacy process/home was latched."""
    if not fence_active():
        return False
    if os.environ.get(LATCHED_ENV, "").strip() == "1":
        return True
    with _holding_lock:
        if _holding:
            return True
    scoped = _execution_holding.get()
    return scoped is not None and scoped[0]() and scoped[1].is_set()


def mark_holding() -> None:
    """Fence the source execution, or retain legacy Desktop's sticky process latch."""
    scoped = _execution_holding.get()
    if scoped is not None:
        if scoped[0]():
            scoped[1].set()
        return
    global _holding
    with _holding_lock:
        _holding = True


def _mcp_tool(tool_name: str) -> bool:
    try:
        from tools.registry import registry

        toolset = registry.get_toolset_for_tool(tool_name)
    except Exception:
        return False
    return isinstance(toolset, str) and toolset.startswith("mcp-")


def egress_refusal(tool_name: Any, args: Any = None, task_id: Any = None) -> Optional[str]:
    """The refusal a tool call gets instead of running, or None when it may run.

    Holding Google data does not restrict tools. The prompt-injection policy
    still limits a turn whose Google content looked like an injection.
    """
    from agent.atum_google_injection import refusal as injection_refusal

    # Resolve only registration-owned metadata, including profile/session overlays.
    from tools.registry import registry

    entry = registry.get_entry(str(tool_name or ""))
    source = entry.atum_source if entry and entry.toolset.startswith("mcp-") else None
    # Owner chats have the same policy as the native tool, including on a tainted turn.
    policy_name = "atum_chats" if source == "owner_chats" else tool_name
    if message := injection_refusal(policy_name, args, task_id):
        return message
    return None


__all__ = [
    "EGRESS_PREFIXES",
    "EGRESS_TOOLS",
    "GoogleFenceRouteRequired",
    "LATCHED_ENV",
    "LOCAL_MEMORY_PROVIDERS",
    "MESSAGE",
    "MODEL_BASE_ENV",
    "ROUTE_ENV",
    "assert_route",
    "broker_origin",
    "client_allowed",
    "egress_refusal",
    "fence_active",
    "fence_resolved_client",
    "fence_route",
    "holding_google",
    "mark_holding",
    "memory_provider_allowed",
    "route_allowed",
    "scoped_source_holding",
]
