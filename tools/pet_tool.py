#!/usr/bin/env python3
"""Pet Tool — let an assistant move and animate its own on-screen pet.

The pet is the assistant's face on the desktop, so the assistant should be able
to use it: walk across when asked, wave when a job lands, sit when told. "Gigi, go to the left of the screen" should make the dog *walk* there.

The platform layer owns the pet. This module defines the schema, validates the
command, and hands it to a platform-provided callback — the same shape as
``clarify_tool``. Surfaces without a pet (CLI, TUI, a headless run) have no
callback and the tool says so plainly rather than pretending it worked.

Commands are requests, not teleports: the desktop feeds ``go`` into the pet's
existing wander physics so she walks, at her own pace, along whatever she is
standing on. A pet that snaps to a coordinate reads as furniture being dragged;
one that trots over reads as a dog being called.
"""

import json
import os
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Callable, Optional

_turn_callback: ContextVar[Optional[Callable]] = ContextVar("atum_pet_turn_callback", default=None)


def bind_turn_callback(callback):
    return _turn_callback.set(callback)


def reset_turn_callback(token):
    _turn_callback.reset(token)


# Where a pet can be sent. Deliberately places rather than coordinates: an
# assistant means a region of the screen, and it has no way to know where the
# Dock is, which display is which, or how big the pet currently is.
PLACES = ("left", "right", "center", "centre", "middle")
_PLACE_ALIASES = {"centre": "center", "middle": "center"}
_REPLY_QUEUED_MESSAGE = "queued for your reply; shows on devices where your pet is out"

# What a pet can be asked to do. Each maps onto an animation row the pet already
# has, so the tool can never ask for a pose that does not exist. `come` and
# `look` lived here briefly and were removed with the desktop wander and the
# cursor gaze: an action the renderer silently drops is worse than a missing one,
# because the model reports success and may tell the user it happened.
ACTIONS = ("go", "wave", "jump", "sit", "lounge")


def pet_tool(
    action: str,
    place: Optional[str] = None,
    callback: Optional[Callable] = None,
) -> str:
    """Move or animate the assistant's pet.

    Args:
        action:   One of :data:`ACTIONS`.
        place:    For ``go``, one of :data:`PLACES`.
        callback: Platform-provided handler, injected by the agent runner.
                  Reply mode requires ``{ok: True, queued: True}``; legacy
                  handlers may return ``None`` after dispatch.

    Returns:
        JSON string describing what was requested.
    """
    if callback is None:
        callback = _turn_callback.get()
    action = (action or "").strip().lower()
    reply_mode = os.environ.get("ATUM_PET_INTENTS") == "reply"

    if action not in ACTIONS:
        return tool_error(f"Unknown action '{action}'. Use one of: {', '.join(ACTIONS)}.")

    command: dict = {"action": action}

    if action == "go":
        normalised = (place or "").strip().lower()
        if normalised not in PLACES:
            return tool_error(f"'go' needs a place: {', '.join(PLACES)}.")
        if reply_mode:
            normalised = _PLACE_ALIASES.get(normalised, normalised)
        command["place"] = normalised

    if callback is None or not check_pet_requirements():
        # Not an error: the assistant is on a surface with no pet, which it has
        # no way to know in advance. Say so rather than reporting a phantom
        # success it might then narrate to the user.
        return json.dumps(
            {
                "ok": False,
                "reason": "no_pet_surface",
                "message": "There is no pet on this surface, so nothing moved.",
            }
        )

    try:
        callback_result = callback(command)
    except Exception as exc:
        return tool_error(f"Could not reach the pet: {exc}")

    if reply_mode:
        if (
            isinstance(callback_result, Mapping)
            and callback_result.get("ok") is True
            and callback_result.get("queued") is True
        ):
            return json.dumps(
                {
                    "ok": True,
                    "queued": True,
                    "message": _REPLY_QUEUED_MESSAGE,
                    **command,
                }
            )
        if isinstance(callback_result, Mapping) and callback_result.get("reason") == "intent_limit":
            return json.dumps(
                {
                    "ok": False,
                    "reason": "intent_limit",
                    "message": "This reply already has the maximum of 3 pet intents.",
                }
            )
        return json.dumps(
            {
                "ok": False,
                "reason": "pet_intent_not_queued",
                "message": "The pet action could not be queued for this reply.",
            }
        )

    return json.dumps({"ok": True, **command})


def check_pet_requirements() -> bool:
    """A process-stable host handshake; unset preserves legacy surfaces."""
    return os.environ.get("ATUM_PET_INTENTS") != "off"


PET_SCHEMA = {
    "name": "pet",
    "description": (
        "Move or animate your on-screen pet — your own avatar on the user's "
        "desktop. Use it when the user asks the pet to do something ('go to "
        "the left side', 'sit'), or as a small flourish when a turn lands.\n\n"
        "Actions:\n"
        "- `go` — walk to a place (`left`, `right`, `center`). She walks; she "
        "does not teleport, so it takes a moment.\n"
        "- `wave`, `jump`, `sit` — one-off animations.\n"
        "- `lounge` — settle down and stay a while; on the composer if she is up there.\n\n"
        "This is cosmetic. It never affects the task, and on a surface with no "
        "pet it reports that instead of failing. Do not narrate it as though "
        "you did real work, and do not call it repeatedly for emphasis."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": list(ACTIONS),
                "description": "What the pet should do.",
            },
            "place": {
                "type": "string",
                "enum": ["left", "right", "center"],
                "description": "Where to walk. Required for `go`, ignored otherwise.",
            },
        },
        "required": ["action"],
    },
}


# --- Registry ---
from tools.registry import registry, tool_error

registry.register(
    name="pet",
    toolset="pet",
    schema=PET_SCHEMA,
    handler=lambda args, **kw: pet_tool(
        action=args.get("action", ""),
        place=args.get("place"),
        callback=kw.get("callback"),
    ),
    check_fn=check_pet_requirements,
    emoji="🐾",
)
