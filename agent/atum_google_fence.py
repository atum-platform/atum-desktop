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
- once the process holds Google data (``ATUM_GOOGLE_LATCHED`` at launch, or the
  first Google result in this process, ``mark_holding``), the tools that hand
  what they are given to a service outside that route answer with a refusal
  instead of running (``egress_refusal``): the open web and its search and scrape
  providers, other AI models, other platforms and rooms, other agents, and every
  MCP server. Its own Atum profile/roster remains available through targetless
  list/read/update calls. The tool list itself never changes, so prompt caching
  holds.

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

#: Tools that hand what they are given to a service outside Atum's protected route.
#: Each is listed for one reason: the open web and its search and scrape providers
#: (web_*, x_search, every browser_* tool), other AI models (image_generate,
#: text_to_speech), other platforms and rooms (send_message), and other agents (the
#: kanban board's writes). Every MCP server's tools are refused too (toolset mcp-*).
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
# ``atum_agents`` stays in the block set: only the targetless self/roster
# operations admitted by ``_self_profile_access`` may bypass it.
EGRESS_PREFIXES = ("browser_",)
#: Speech engines that run on this Mac: reading aloud with one sends nothing anywhere.
LOCAL_SPEECH_PROVIDERS = frozenset({"neutts", "kittentts", "piper"})

EGRESS_MESSAGE = (
    "Not available here: this assistant holds the owner's Gmail, Calendar or Drive "
    "information, which stays with Atum's protected model. Do the task without this "
    "tool, or tell the owner plainly that it needs a tool this assistant can't use "
    "(another agent of theirs can)."
)
SPEECH_MESSAGE = (
    "Reading aloud is off for this assistant: it holds your Gmail, Calendar or Drive "
    "information, which stays with Atum's protected model."
)

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


def route_allowed(base_url: Any, api_mode: Optional[str] = None) -> bool:
    route = fence_route()
    if route is None:
        return True
    if not route:
        return False
    if api_mode not in (None, "", "chat_completions"):
        return False
    return _protected_v1(base_url) == route


def assert_route(base_url: Any, api_mode: Optional[str] = None) -> None:
    """Raise before any request is built when a call would leave the protected route."""
    if not route_allowed(base_url, api_mode):
        raise GoogleFenceRouteRequired()


def client_allowed(client: Any) -> bool:
    """A resolved helper client may be used only when it targets the protected route."""
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


def _speech_is_local() -> bool:
    try:
        from tools.tts_tool import _get_provider, _load_tts_config

        return _get_provider(_load_tts_config()) in LOCAL_SPEECH_PROVIDERS
    except Exception:
        return False


def speech_allowed() -> bool:
    """Reading text aloud (the tool, or the desktop's voice mode) sends it to the
    configured speech engine; an assistant holding Google data uses only one on this Mac."""
    return not holding_google() or _speech_is_local()


def _self_profile_access(args: Any) -> bool:
    """Whether an ``atum_agents`` call stays on the current agent's profile/roster.

    The host treats an omitted target as self. An explicit principal may name a
    sibling, so the fence never tries to infer identity from it.
    """
    if not isinstance(args, dict) or args.get("target") not in (None, ""):
        return False
    operation = args.get("operation")
    return isinstance(operation, str) and operation in {"list", "read", "update"}


def egress_refusal(tool_name: Any, args: Any = None, task_id: Any = None) -> Optional[str]:
    """The refusal a tool call gets instead of running, or None when it may run.

    Only the source execution (or legacy latched assistant) holding Google data is
    limited; other native sessions run every tool as Hermes ships it. A turn that
    read Google content which looked like an injection is limited further, whether or not
    this process is fenced (``agent/atum_google_injection.py``).
    """
    from agent.atum_google_injection import refusal as injection_refusal

    if message := injection_refusal(tool_name, args, task_id):
        return message
    if not holding_google():
        return None
    name = str(tool_name or "")
    if name == "text_to_speech":
        return None if speech_allowed() else EGRESS_MESSAGE
    if name == "atum_agents" and _self_profile_access(args):
        return None
    if name in EGRESS_TOOLS or name.startswith(EGRESS_PREFIXES) or _mcp_tool(name):
        return EGRESS_MESSAGE
    return None


__all__ = [
    "EGRESS_MESSAGE",
    "EGRESS_PREFIXES",
    "EGRESS_TOOLS",
    "GoogleFenceRouteRequired",
    "LATCHED_ENV",
    "LOCAL_MEMORY_PROVIDERS",
    "LOCAL_SPEECH_PROVIDERS",
    "MESSAGE",
    "MODEL_BASE_ENV",
    "ROUTE_ENV",
    "SPEECH_MESSAGE",
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
    "speech_allowed",
]
