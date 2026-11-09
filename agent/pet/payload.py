"""One sprite payload/geometry builder for the desktop and gateway.

No profile configuration, networking, adoption or execution lives here.
"""

import copy
import json
import threading


def _pet_frame_counts(spritesheet, extra_rows: tuple[str, ...] = ()) -> dict:
    """Real (padding-trimmed) frame count per state, for the desktop canvas.

    Fail-open: a decode hiccup returns ``{}`` and the canvas falls back to its
    static ``framesPerState`` rather than breaking the (cosmetic) pet.
    """
    try:
        from agent.pet import render

        return render.state_frame_counts(str(spritesheet), extra_rows=tuple(extra_rows))
    except Exception:  # noqa: BLE001 - cosmetic, never break the surface
        return {}


_pet_payload_cache_lock = threading.Lock()
_pet_payload_cache: dict[tuple, dict] = {}


def _pet_sheet_revision(spritesheet) -> str:
    """Stable revision id for one spritesheet file."""
    try:
        stat = spritesheet.stat()
        return f"{stat.st_mtime_ns}:{stat.st_size}"
    except Exception:  # noqa: BLE001 - cosmetic, never break the surface
        return "0:0"


def _pet_payload_cache_key(pet, *, scale: float) -> tuple | None:
    """Cache key for the expensive sprite payload build."""
    try:
        stat = pet.spritesheet.stat()
    except Exception:  # noqa: BLE001
        return None
    from agent.pet import constants
    metadata = [
        constants.parse_size_class(getattr(pet, "size_class", None)),
        constants.parse_anchor(getattr(pet, "anchor", None)),
        constants.parse_bounds(getattr(pet, "bounds", None)),
        constants.parse_locomotion(getattr(pet, "locomotion", None)),
    ]
    return (
        str(pet.spritesheet),
        stat.st_mtime_ns,
        stat.st_size,
        pet.slug,
        pet.display_name,
        round(scale, 4),
        round(getattr(pet, "size", 1.0), 4),
        tuple(getattr(pet, "extra_rows", ()) or ()),
        json.dumps(metadata, sort_keys=True),
    )


def _clone_pet_payload(payload: dict) -> dict:
    """Clone cached payloads, including nested v5 geometry, for each caller."""
    out = dict(payload)
    if isinstance(payload.get("framesByState"), dict):
        out["framesByState"] = dict(payload["framesByState"])
    if isinstance(payload.get("framesByRow"), dict):
        out["framesByRow"] = dict(payload["framesByRow"])
    if isinstance(payload.get("stateRows"), list):
        out["stateRows"] = list(payload["stateRows"])
    if isinstance(payload.get("extraRows"), list):
        out["extraRows"] = list(payload["extraRows"])
    for key in ("sizeClass", "anchor", "bounds"):
        if key in payload:
            out[key] = copy.deepcopy(payload[key])
    return out


def _pet_row_frame_counts(spritesheet, extra_rows: tuple[str, ...] = ()) -> dict:
    """Real frame count per concrete spritesheet row name."""
    try:
        from PIL import Image

        from agent.pet import constants, render

        with Image.open(spritesheet) as opened:
            image = opened.convert("RGBA")
        cols = max(1, image.width // constants.FRAME_W)
        row_count = max(1, image.height // constants.FRAME_H)
        rows = constants.state_rows_for_grid(row_count, extra_rows)
        out: dict[str, int] = {}
        for row_idx, name in enumerate(rows[:row_count]):
            top = row_idx * constants.FRAME_H
            count = 0
            for col in range(cols):
                left = col * constants.FRAME_W
                frame = image.crop((
                    left,
                    top,
                    left + constants.FRAME_W,
                    top + constants.FRAME_H,
                ))
                if render._frame_is_blank(frame):
                    break
                count += 1
            out[name] = count
        return out
    except Exception:  # noqa: BLE001 - cosmetic, never break the surface
        return {}


def _pet_sprite_payload(pet, *, scale: float) -> dict:
    """Build the renderer payload (spritesheet bytes + geometry) for *pet*.

    Shared by ``pet.info`` (the active mascot) and ``pet.hatch`` (the unadopted
    preview) so both feed the desktop canvas / TUI from one shape.
    """
    import base64

    from agent.pet import constants

    cache_key = _pet_payload_cache_key(pet, scale=scale)
    if cache_key is not None:
        with _pet_payload_cache_lock:
            cached = _pet_payload_cache.get(cache_key)
        if cached is not None:
            return _clone_pet_payload(cached)

    raw = pet.spritesheet.read_bytes()
    suffix = pet.spritesheet.suffix.lower()
    mime = "image/png" if suffix == ".png" else "image/webp"
    extra_rows = tuple(getattr(pet, "extra_rows", ()) or ())
    payload = {
        "slug": pet.slug,
        "displayName": pet.display_name,
        "mime": mime,
        "spritesheetBase64": base64.standard_b64encode(raw).decode("ascii"),
        "spritesheetRevision": _pet_sheet_revision(pet.spritesheet),
        "frameW": constants.FRAME_W,
        "frameH": constants.FRAME_H,
        "framesPerState": constants.FRAMES_PER_STATE,
        "framesByState": _pet_frame_counts(pet.spritesheet, extra_rows),
        "framesByRow": _pet_row_frame_counts(pet.spritesheet, extra_rows),
        "loopMs": constants.LOOP_MS,
        "scale": scale,
        # The pet's own size; the desktop draws at scale x size (plan
        # 2026-09-13-pet-plans-rig-and-activities, decision 1).
        "size": getattr(pet, "size", constants.DEFAULT_SIZE),
        # v4: the rows past the look rows the pet.json declares, so the
        # canvas can index sleep/carried; a sheet that declares none stays v3.
        "stateRows": _pet_state_rows(pet.spritesheet, extra_rows),
        "extraRows": list(extra_rows),
    }
    derived_anchor, derived_bounds = _pet_opaque_geometry(pet.spritesheet, extra_rows)
    size_class = constants.parse_size_class(getattr(pet, "size_class", None))
    if size_class is not None:
        payload["sizeClass"] = size_class
    anchor = constants.parse_anchor(getattr(pet, "anchor", None)) or derived_anchor
    bounds = constants.parse_bounds(getattr(pet, "bounds", None)) or derived_bounds
    if anchor is not None:
        payload["anchor"] = anchor
    if bounds:
        payload["bounds"] = bounds
    payload["locomotion"] = constants.parse_locomotion(getattr(pet, "locomotion", None))
    if cache_key is not None:
        with _pet_payload_cache_lock:
            _pet_payload_cache[cache_key] = payload
            while len(_pet_payload_cache) > 8:
                _pet_payload_cache.pop(next(iter(_pet_payload_cache)))
    return _clone_pet_payload(payload)


def _pet_state_rows(spritesheet, extra_rows: tuple[str, ...] = ()) -> list[str]:
    """Row taxonomy for the concrete active pet sheet.

    Hermes has to support both the legacy 8-row petdex atlas and the current
    Codex/petdex 9-row atlas. The desktop canvas gets this list and indexes it
    with the same `PetState` names the Python renderer uses. *extra_rows* is
    the v4 declaration from the pet's ``pet.json``.
    """
    try:
        from PIL import Image

        from agent.pet import constants

        with Image.open(spritesheet) as image:
            row_count = max(1, image.height // constants.FRAME_H)
        return list(constants.state_rows_for_grid(row_count, extra_rows))
    except Exception:  # noqa: BLE001 - cosmetic, never break the surface
        from agent.pet import constants

        return list(constants.STATE_ROWS)


def _pet_opaque_geometry(spritesheet, extra_rows: tuple[str, ...] = ()) -> tuple[dict | None, dict]:
    """Idle feet/centre and tight per-row unions, in the existing cell pixels."""
    try:
        from PIL import Image
        from agent.pet import constants

        with Image.open(spritesheet) as opened:
            image = opened.convert("RGBA")
        cols = image.width // constants.FRAME_W
        row_count = image.height // constants.FRAME_H
        core = constants._core_state_rows(row_count)
        rows = list(core)
        if constants.look_row_start(row_count) is not None:
            rows += list(constants.LOOK_ROW_NAMES)
        rows += list(extra_rows)
        bounds = {}
        idle_anchor = None
        for row_index, name in enumerate(rows[:row_count]):
            union = None
            for col in range(cols):
                x, y = col * constants.FRAME_W, row_index * constants.FRAME_H
                cell = image.crop((x, y, x + constants.FRAME_W, y + constants.FRAME_H))
                box = cell.getchannel("A").getbbox()
                if box is None:
                    continue
                if row_index == 0 and col == 0:
                    idle_anchor = {"footY": box[3], "centerX": (box[0] + box[2]) / 2}
                union = box if union is None else (
                    min(union[0], box[0]), min(union[1], box[1]),
                    max(union[2], box[2]), max(union[3], box[3]),
                )
            if union is not None:
                bounds[name] = {"x": union[0], "y": union[1], "width": union[2] - union[0], "height": union[3] - union[1]}
        return idle_anchor, bounds
    except Exception:  # noqa: BLE001 - cosmetic decode never breaks a legacy pet
        return None, {}
