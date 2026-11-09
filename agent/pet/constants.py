"""Pet sprite geometry + animation-state taxonomy.

These values are the common petdex/Codex pet geometry. The real ``pet.json``
usually only carries ``id``/``displayName``/``description``/``spritesheetPath``;
row taxonomy is inferred from the atlas shape so Hermes can render both legacy
8-row sheets and current 9-row Codex sheets.
"""

from __future__ import annotations

import math
from enum import Enum

# Frame geometry (pixels). Current Codex/petdex spritesheets are 8 columns x 9
# rows (1536x1872), while older Hermes/petdex sheets used 9 columns x 8 rows
# (1728x1664). Renderers derive both row taxonomy and real column count from the
# concrete sheet, so either shape works.
FRAME_W = 192
FRAME_H = 208

# Frames consumed per animation state (the petdex web app uses CSS
# ``steps(6)``).  A sheet may physically contain more columns; we only step
# through the first ``FRAMES_PER_STATE``.
FRAMES_PER_STATE = 6

# Full-loop duration for one state, milliseconds (petdex default).
LOOP_MS = 1100

# Default on-screen scale relative to native frame size.  ``display.pet.scale``
# is the single master scalar: the desktop canvas multiplies its native pixels
# by it and every terminal surface derives its half-block/kitty column width
# from it (see :func:`cols_for_scale`), so one number shrinks all three
# interfaces together.  (petdex's own clients render at 0.7; we default smaller
# so the kitty/GUI mascot stays a glanceable corner sprite.  The half-block
# fallback can't shrink as far — see ``UNICODE_MIN_COLS`` — and clamps to its
# legibility floor instead.)
DEFAULT_SCALE = 0.33

# User-settable scale bounds (``/pet scale``, desktop slider).  Floor keeps the
# pet clickable/visible; ceiling stops a fat-fingered value from filling the
# screen.  The unicode fallback additionally clamps to ``UNICODE_MIN_COLS``.
MIN_SCALE = 0.1
MAX_SCALE = 3.0


def clamp_scale(scale: float) -> float:
    """Clamp *scale* to ``[MIN_SCALE, MAX_SCALE]`` (the single validation point)."""
    return max(MIN_SCALE, min(MAX_SCALE, scale))


# A pet's own size, multiplied onto the user's scale at draw time: a Saint
# Bernard is drawn bigger than a maltese at the same ``display.pet.scale``
# (plan 2026-09-13-pet-plans-rig-and-activities, decision 1). It never changes
# the sprite — every pet still fills its 192x208 cell — only how big the desk
# draws it. Read from ``pet.json``'s ``size``; absent means 1.0. Bounded so a
# stray value can neither vanish a pet nor fill the screen.
DEFAULT_SIZE = 1.0
MIN_SIZE = 0.5
MAX_SIZE = 2.0


def clamp_size(size: float) -> float:
    """Clamp *size* to ``[MIN_SIZE, MAX_SIZE]`` (the single validation point)."""
    return max(MIN_SIZE, min(MAX_SIZE, size))


def parse_size(raw: object) -> float:
    """``pet.json``'s ``size`` as a float — absent, null or junk is 1.0."""
    if raw is None or isinstance(raw, bool):
        return DEFAULT_SIZE
    try:
        value = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_SIZE
    if value != value:  # NaN
        return DEFAULT_SIZE
    return clamp_size(value)

# Terminal cells one native frame spans at ``scale == 1.0``.  A cell is ~8px
# wide, a frame is ``FRAME_W`` (192) px → 24 cells.  This mirrors the kitty
# graphics placement (``scaled_px // 8``) so at full scale every renderer agrees.
BASE_UNICODE_COLS = FRAME_W // 8

# Legibility floor for the half-block fallback.  A half-block cell samples the
# sprite at only 1 horizontal + 2 vertical taps, so below this width a 192×208
# pet collapses into an unreadable blob *regardless* of scale.  kitty/GUI draw
# true pixels and have no such floor — that's why the same ``scale: 0.33`` is
# crisp there but mush in half-blocks.  ``scale`` shrinks the unicode pet down
# TO this floor (and grows it above), instead of past it into noise.
UNICODE_MIN_COLS = 16


def cols_for_scale(scale: float) -> int:
    """Half-block width implied by *scale*, clamped to the legibility floor.

    Above the floor it tracks the kitty cell box (``scaled_px // 8``) so the two
    renderers converge at larger sizes; below it the floor keeps the sprite
    readable rather than letting it devolve into a blob.
    """
    return max(UNICODE_MIN_COLS, round(BASE_UNICODE_COLS * (scale or DEFAULT_SCALE)))


def resolve_cols(scale: float, unicode_cols: int = 0) -> int:
    """Resolve terminal width: explicit *unicode_cols* override, else from *scale*."""
    return int(unicode_cols) if unicode_cols and int(unicode_cols) > 0 else cols_for_scale(scale)


class PetState(str, Enum):
    """Animation state a pet can be shown in.

    These are Hermes' activity state names. They are not always identical to the
    source atlas row names: Codex-format pets use rows like ``jumping`` /
    ``running`` while the UI keeps the shorter ``jump`` / ``run`` names.
    """

    IDLE = "idle"
    WAVE = "wave"
    RUN = "run"
    FAILED = "failed"
    REVIEW = "review"
    JUMP = "jump"
    WAITING = "waiting"
    LOUNGING = "lounging"
    # v4 optional rows (plan 2026-09-13-pet-plans-rig-and-activities, decisions
    # 10-11): a sheet may carry them; a sheet without them plays a stand-in.
    SLEEP = "sleep"  # long idle; falls back to lounging
    CARRIED = "carried"  # being dragged; falls back to idle


# Legacy Hermes/petdex row order (top -> bottom) used by the older 8-row,
# 9-column atlas shape.
LEGACY_STATE_ROWS: list[str] = [
    PetState.IDLE.value,
    PetState.WAVE.value,
    PetState.RUN.value,
    PetState.FAILED.value,
    PetState.REVIEW.value,
    PetState.JUMP.value,
    "extra1",
    "extra2",
]

# Current Petdex row order (top -> bottom) used by 1536x1872 atlases:
# 8 columns x 9 rows of 192x208 cells.
CODEX_STATE_ROWS: list[str] = [
    PetState.IDLE.value,
    "running-right",
    "running-left",
    "waving",
    "jumping",
    PetState.FAILED.value,
    PetState.WAITING.value,
    "running",
    PetState.REVIEW.value,
]

# Default/fallback for callers without a sheet. Prefer the current 9-row Codex
# format because generated pets and the public Codex pet contract use it.
# v3: the Codex rows plus one of ours. "lounging" is the pose a pet holds on a
# perch — curled up on the composer — and the one thing a pet can do that the
# Codex taxonomy has no word for. Sheets without the row fall back to
# "waiting" (sitting) through STATE_ALIASES, so a petdex pet asked to lounge
# sits, which is the honest approximation.
V3_STATE_ROWS: list[str] = [*CODEX_STATE_ROWS, PetState.LOUNGING.value]

# v4: optional rows appended AFTER the two look rows, in this canonical order,
# and declared in pet.json as `extraRows` (sheet order) — never inferred from
# height. A reader that predates them sees a taller sheet and keeps reading v3,
# because `state_rows_for_grid` only names rows it is told about.
OPTIONAL_STATE_ROWS: tuple[str, ...] = (PetState.SLEEP.value, PetState.CARRIED.value)
# Placeholders for the look rows inside a v4 row list, so a row's index in the
# list is its index in the atlas; no state is ever named this.
LOOK_ROW_NAMES: tuple[str, ...] = ("look-0", "look-1")

STATE_ROWS: list[str] = CODEX_STATE_ROWS

# Canonical Hermes activity names -> accepted row-name aliases in descending
# preference. This keeps our internal state names stable (`wave`/`jump`/`run`)
# while matching Petdex's current `waving`/`jumping`/`running` taxonomy.
STATE_ALIASES: dict[str, tuple[str, ...]] = {
    PetState.IDLE.value: (PetState.IDLE.value,),
    PetState.WAVE.value: (PetState.WAVE.value, "waving"),
    PetState.JUMP.value: (PetState.JUMP.value, "jumping"),
    PetState.RUN.value: (PetState.RUN.value, "running"),
    PetState.FAILED.value: (PetState.FAILED.value,),
    PetState.REVIEW.value: (PetState.REVIEW.value,),
    PetState.WAITING.value: (PetState.WAITING.value,),
    PetState.LOUNGING.value: (PetState.LOUNGING.value,),
    PetState.SLEEP.value: (PetState.SLEEP.value,),
    PetState.CARRIED.value: (PetState.CARRIED.value,),
}

# States a sheet may lack, and the pose that stands in. Codex/petdex sheets
# have no lounging row; a pet asked to lounge on one sits, which is the honest
# approximation. Kept apart from STATE_ALIASES so "does this sheet drive the
# state" and "what do we draw instead" stay different questions. The chain
# resolves: a v3 sheet asked to sleep lounges; a Codex sheet asked to sleep
# lounges → sits.
STATE_FALLBACKS: dict[str, str] = {
    PetState.LOUNGING.value: PetState.WAITING.value,
    PetState.SLEEP.value: PetState.LOUNGING.value,
    PetState.CARRIED.value: PetState.IDLE.value,
}


def parse_extra_rows(raw: object) -> tuple[str, ...]:
    """``pet.json``'s ``extraRows`` — the optional rows a sheet carries, in
    sheet order. Unknown names and repeats are dropped; anything that is not
    a list is no rows."""
    if not isinstance(raw, list):
        return ()
    out: list[str] = []
    for item in raw:
        name = str(item or "").strip().lower()
        if name in OPTIONAL_STATE_ROWS and name not in out:
            out.append(name)
    return tuple(out)


def state_aliases_for(state: PetState | str) -> tuple[str, ...]:
    """Return accepted row-name aliases for *state* (always non-empty)."""
    value = state.value if isinstance(state, PetState) else str(state)
    aliases = STATE_ALIASES.get(value)
    return aliases if aliases else (value,)


def _core_state_rows(row_count: int | None) -> list[str]:
    """The animation-row taxonomy a sheet's height implies (never the extras)."""
    try:
        rows = int(row_count or 0)
    except (TypeError, ValueError):
        rows = 0

    # Row counts are unambiguous because look rows only ever come in pairs:
    # 8 legacy, 9 Codex, 11 Codex + look, 10 v3, 12+ v3 + look (+ declared extras).
    if rows >= len(V3_STATE_ROWS) + LOOK_ROWS or rows == len(V3_STATE_ROWS):
        return V3_STATE_ROWS
    if rows >= len(CODEX_STATE_ROWS):
        return CODEX_STATE_ROWS
    return LEGACY_STATE_ROWS


def state_rows_for_grid(row_count: int | None, extra_rows: tuple[str, ...] | list[str] = ()) -> list[str]:
    """Return the row taxonomy for a spritesheet with *row_count* rows: a row's
    index in the list is its row in the atlas.

    *extra_rows* is what the pet's ``pet.json`` declares (v4). Only then does
    the list run past the look rows — as core rows, two look placeholders, then
    the declared extras that fit — so a sheet nobody described stays v3 to
    every reader, however tall it is.
    """
    core = _core_state_rows(row_count)
    try:
        rows = int(row_count or 0)
    except (TypeError, ValueError):
        rows = 0
    extras = [name for name in extra_rows if name in OPTIONAL_STATE_ROWS]
    room = rows - len(V3_STATE_ROWS) - LOOK_ROWS
    if core is V3_STATE_ROWS and extras and room > 0:
        return [*V3_STATE_ROWS, *LOOK_ROW_NAMES, *extras[:room]]
    return core


# v2 atlases carry two extra rows after the nine animation rows: 8x2 = 16 look
# directions, for a pet whose head tracks the cursor.
#
# The public registry describes them only as "16 clockwise look directions" — it
# does not say which direction index 0 faces, nor how the 16 are laid out across
# the two rows. So a sheet is only usable for gaze if it *declares* its ordering
# in ``pet.json`` as ``lookOrigin``; a v2 sheet without one is rendered as a
# plain 9-row pet, because a pet that looks confidently the wrong way is worse
# than one that does not look at all.
LOOK_ROWS = 2

# The look cells are a yaw x pitch grid, not a ring of compass directions: a
# ring can only turn a head left, right and away, so "look up" came out as
# "face away from the viewer" and the head never tilted. 5 yaw x 3 pitch = 15
# cells cover one side, and the renderer's existing mirror covers the other.
LOOK_YAW_STEPS = 5
LOOK_PITCH_STEPS = 3

# The only layout we know how to drive: cell = pitch * LOOK_YAW_STEPS + yaw,
# row 9 holding cells 0-7 and row 10 holding 8-14.
# Produced by scripts/build_default_pet.py.
LOOK_ORIGIN_YAW_PITCH = "yaw5-pitch3-mirrored"


def look_row_start(row_count: int | None = None) -> int | None:
    """First look-direction row index, or ``None`` when the sheet has none."""
    try:
        rows = int(row_count or 0)
    except (TypeError, ValueError):
        return None

    # The look rows sit after the core state taxonomy the sheet carries; the
    # v4 extras come after the look rows and never move them.
    start = len(_core_state_rows(rows))
    return start if rows >= start + LOOK_ROWS else None


def state_row_present(state: PetState | str, row_count: int | None = None, extra_rows: tuple[str, ...] | list[str] = ()) -> bool:
    """Does a sheet with *row_count* rows carry *state*'s own row (no stand-ins)?"""
    rows = state_rows_for_grid(row_count, extra_rows)
    return any(name in rows for name in state_aliases_for(state))


def state_row_index(state: PetState | str, row_count: int | None = None, extra_rows: tuple[str, ...] | list[str] = ()) -> int:
    """Return the spritesheet row index for *state* (clamped, never raises)."""
    rows = state_rows_for_grid(row_count, extra_rows)
    value = state.value if isinstance(state, PetState) else str(state)
    fallback = STATE_FALLBACKS.get(value)
    if fallback and not state_row_present(value, row_count, extra_rows):
        return state_row_index(fallback, row_count, extra_rows)
    for name in state_aliases_for(state):
        try:
            return rows.index(name)
        except ValueError:
            continue
    return 0  # fall back to the idle row


# v5 optional presentation metadata. Invalid fields are absent to legacy
# loaders; portable bundles and the desktop boundary reject them explicitly.
LOCOMOTIONS = ("walk", "hop", "float", "fly")


def _finite_number(value: object) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def parse_size_class(raw: object) -> dict | None:
    if not isinstance(raw, dict) or set(raw) != {"naturalHeightPt"}:
        return None
    height = raw["naturalHeightPt"]
    return {"naturalHeightPt": height} if _finite_number(height) and 40 <= height <= 300 else None


def parse_anchor(raw: object) -> dict | None:
    if not isinstance(raw, dict) or set(raw) != {"footY", "centerX"}:
        return None
    foot, center = raw["footY"], raw["centerX"]
    if not (_finite_number(foot) and _finite_number(center) and 0 <= foot <= FRAME_H and 0 <= center <= FRAME_W):
        return None
    return {"footY": foot, "centerX": center}


def parse_bounds(raw: object) -> dict | None:
    if not isinstance(raw, dict) or not 1 <= len(raw) <= 32:
        return None
    known = set(LEGACY_STATE_ROWS + CODEX_STATE_ROWS + V3_STATE_ROWS + list(LOOK_ROW_NAMES) + list(OPTIONAL_STATE_ROWS))
    result = {}
    for row, box in raw.items():
        if row not in known or not isinstance(box, dict) or set(box) != {"x", "y", "width", "height"}:
            return None
        x, y, width, height = (box[key] for key in ("x", "y", "width", "height"))
        if not all(_finite_number(n) for n in (x, y, width, height)):
            return None
        if not (x >= 0 and y >= 0 and width > 0 and height > 0 and x + width <= FRAME_W and y + height <= FRAME_H):
            return None
        result[row] = dict(box)
    return result


def parse_locomotion(raw: object) -> str:
    return raw if isinstance(raw, str) and raw in LOCOMOTIONS else "walk"
