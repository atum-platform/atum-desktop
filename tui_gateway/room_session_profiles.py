"""Immutable room profile identity. Tool capability is chosen only at agent birth."""

import json

PROFILE_FLAGS = ("shared_room", "reply_only", "pet_surface", "first_learning")


def stored_profile(row):
    raw = (row or {}).get("model_config")
    if isinstance(raw, str) and raw.strip():
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            raw = {}
    raw = raw if isinstance(raw, dict) else {}
    return tuple(raw.get("_" + flag) is True for flag in PROFILE_FLAGS)


def live_profile(session):
    return tuple(bool((session or {}).get(flag)) for flag in PROFILE_FLAGS)


def profile_key(
    shared_room=False, reply_only=False, pet_surface=False, first_learning=False
):
    key = f"room:shared={int(shared_room)}:reply={int(reply_only)}:pet={int(pet_surface)}"
    return f"{key}:learn=1" if first_learning else key


def inherit_profile(child, parent):
    """Before the child's first turn/DB insert, retain its parent's immutable scope."""
    config = getattr(parent, "_session_init_model_config", None) or {}
    child._session_init_model_config = {
        **(getattr(child, "_session_init_model_config", None) or {}),
        **{"_" + flag: config.get("_" + flag) is True for flag in PROFILE_FLAGS},
    }
    return child
