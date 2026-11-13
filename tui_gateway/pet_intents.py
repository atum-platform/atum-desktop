"""Turn-bound collector for reply-delivered pet intents.

The gateway owns the lifecycle binding.  This small collector only ensures a
callback can add a closed, bounded set of commands during one active turn.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any


_ACTIONS = frozenset(("go", "wave", "jump", "sit", "lounge"))
_PLACES = frozenset(("left", "right", "center"))
_LIMIT = 3


def pet_intent_envelope(intents: Any) -> dict[str, Any] | None:
    """Validate cosmetic completion data without making text delivery fallible."""
    if not isinstance(intents, list) or not 1 <= len(intents) <= _LIMIT:
        return None
    canonical = [_canonical_command(intent) for intent in intents]
    if any(intent is None for intent in canonical):
        return None
    return {"v": 1, "intents": canonical}


class PetIntentBuffer:
    """Collect at most three distinct canonical pet commands for one turn."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active_token: object | None = None
        self._active_callback: Callable[[dict[str, Any]], dict[str, Any]] | None = None
        self._intents: list[dict[str, str]] = []
        self._seen: set[tuple[str, str | None]] = set()

    def begin(self, turn_id: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
        """Start a turn and return the callback bound to exactly that turn.

        ``turn_id`` is deliberately not used as an authority token: a repeated
        ID must not revive a callback retained from an earlier turn.
        """
        if not isinstance(turn_id, str):
            raise TypeError("turn_id must be a string")

        token = object()

        def queue(command: dict[str, Any]) -> dict[str, Any]:
            return self._queue(token, command)

        with self._lock:
            self._active_token = token
            self._active_callback = queue
            self._intents = []
            self._seen = set()
        return queue

    def finish(
        self,
        callback: Callable[[dict[str, Any]], dict[str, Any]],
        success: bool = True,
    ) -> list[dict[str, str]]:
        """Drain a matching active turn, discarding intents for failed turns."""
        with self._lock:
            if callback is not self._active_callback:
                return []
            intents = [dict(intent) for intent in self._intents] if success else []
            self._active_token = None
            self._active_callback = None
            self._intents = []
            self._seen = set()
            return intents

    def _queue(self, token: object, command: dict[str, Any]) -> dict[str, Any]:
        canonical = _canonical_command(command)
        if canonical is None:
            return {"ok": False, "reason": "invalid_pet_intent"}

        key = (canonical["action"], canonical.get("place"))
        with self._lock:
            if token is not self._active_token:
                return {"ok": False, "reason": "no_active_pet_turn"}
            if key in self._seen:
                return {"ok": True, "queued": True}
            if len(self._intents) >= _LIMIT:
                return {"ok": False, "reason": "intent_limit"}
            self._seen.add(key)
            self._intents.append(canonical)
            return {"ok": True, "queued": True}


def _canonical_command(command: Any) -> dict[str, str] | None:
    """Return an exact v1 command, rejecting aliases and extra fields."""
    if not isinstance(command, dict):
        return None
    action = command.get("action")
    if not isinstance(action, str) or action not in _ACTIONS:
        return None
    if action == "go":
        place = command.get("place")
        if (
            set(command) != {"action", "place"}
            or not isinstance(place, str)
            or place not in _PLACES
        ):
            return None
        return {"action": "go", "place": place}
    if set(command) != {"action"}:
        return None
    return {"action": action}
