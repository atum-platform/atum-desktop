'The mascot plan: one body with a face on it, and whatever sits on top.\n\nBlobs, slimes, ghosts, clouds, mushrooms, robots, eggs — the most\nhatch-shaped plan of all (plan 2026-09-13-pet-plans-rig-and-activities,\ndecision 6). One rounded body (a dome on the floor, a tall egg, a flat\ncloud), optional stub arms and feet, eyes and maybe a mouth painted onto the\ncurved front, and a topper — a sprout, an antenna, horns, a mushroom cap.\nEvery row is a whole-body gesture, because there is no head to move apart\nfrom the body: it hops to run, tilts to think, slumps when it fails,\nreclines to lounge, and turns entirely to look.\n\nProven in the W0 spike ; the\nshapes here are that blob with knobs.\n'

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from scripts.pets.plans import BUILDS, Vocabulary
from scripts.pets.poses import PITCH_ANGLES, PITCH_STEPS, YAW_HEADINGS, YAW_STEPS
from scripts.pets.rig import Rig
from scripts.pets.voxel import MAX_SPAN, Color, Part, Pose, shade

if TYPE_CHECKING:
    from scripts.pets.spec import PetSpec

# ── The vocabulary ────────────────────────────────────────────────────────────

BODIES = ("round", "tall", "flat")
ARMS = ("none", "stub")
LEGS = ("none", "stub")
FACES = ("eyes", "eyes_mouth")
TOPPERS = ("none", "sprout", "antenna", "horns", "cap")
REGIONS = ("body", "belly", "face", "topper", "arms", "legs")
BUILD_SIZE = {"small": 0.8, "medium": 1.0, "large": 1.25}

VOCABULARY = Vocabulary(
    knobs={"body": BODIES, "arms": ARMS, "legs": LEGS, "face": FACES, "topper": TOPPERS},
    defaults={"body": "round", "arms": "stub", "legs": "none", "face": "eyes_mouth", "topper": "none"},
    regions=REGIONS,
    sizes=BUILD_SIZE,
    card=("body", "topper"),
    notes={
        "body": "round is a dome on the floor; tall an egg; flat a low cloud",
        "topper": "sprout for a slime, antenna for a robot, horns, cap for a mushroom",
    },
    palette="coat is the body; coat_deep its shade, the arms and the feet; muzzle the topper; accent a belly or a marking; accent_deep the topper's shade and any pattern",
)

KIND_DEFAULTS: dict[str, dict[str, Any]] = {
    "blob": {},
    "slime": {"topper": "sprout"},
    "ghost": {"body": "tall", "arms": "stub", "legs": "none", "face": "eyes_mouth"},
    "cloud": {"body": "flat", "arms": "none", "legs": "none", "face": "eyes"},
    "mushroom": {"body": "tall", "topper": "cap", "legs": "stub", "arms": "none"},
    "robot": {"body": "tall", "topper": "antenna", "arms": "stub", "legs": "stub", "face": "eyes"},
    "egg": {"body": "tall", "arms": "none", "legs": "none", "face": "eyes"},
}

# ── Geometry ──────────────────────────────────────────────────────────────────

_TOP = MAX_SPAN[1] - 1
# The body: ellipsoid centre y above the base, radii, and the rows it takes.
_BODY = {
    "round": {"cy": 2.5, "r": (5.5, 7.0, 4.2), "rows": 10},
    "tall": {"cy": 4.0, "r": (4.5, 8.5, 3.8), "rows": 13},
    "flat": {"cy": 1.0, "r": (6.5, 5.0, 4.5), "rows": 7},
}
# Rows a topper adds above the body's crown, and its short form for when the
# frame runs out.
_TOPPER_ROWS = {"none": (0, 0), "sprout": (4, 3), "antenna": (5, 3), "horns": (2, 2), "cap": (4, 3)}
_LEG_ROWS = 2
_CX, _CZ = 8.0, 4.5
_INK: Color = (38, 44, 48)


@dataclass(frozen=True)
class MascotGeometry:
    slug: str
    display_name: str
    description: str
    coat: Color
    coat_deep: Color
    topper_color: Color
    topper_deep: Color
    accent: Color | None
    ink: Color
    body: str
    arms: bool
    legs: bool
    mouth: bool
    topper: str
    topper_short: bool
    size: float
    decorate: Callable[[dict[str, Part], "MascotGeometry"], None] | None = None

    @property
    def base(self) -> int:
        return _LEG_ROWS if self.legs else 0

    @property
    def top(self) -> int:
        """The body's crown row."""
        return self.base + _BODY[self.body]["rows"] - 1

    @property
    def x_range(self) -> tuple[int, int]:
        rx = _BODY[self.body]["r"][0]
        return int(_CX - rx) + 1, int(_CX + rx)


def _solve(body: str, legs: bool, topper: str) -> bool:
    """Whether the topper needs its short form for the whole thing to fit."""
    tall, short = _TOPPER_ROWS[topper]
    base = _LEG_ROWS if legs else 0
    return base + _BODY[body]["rows"] + tall - 1 > _TOP and short < tall


def geometry_from_spec(spec: PetSpec, *, slug: str) -> MascotGeometry:
    k = spec.knobs
    return MascotGeometry(
        slug=slug,
        display_name=spec.name,
        description=spec.description,
        coat=spec.coat,
        coat_deep=spec.coat_deep,
        topper_color=spec.muzzle_color,
        topper_deep=spec.accent_deep or shade(spec.muzzle_color, 0.75),
        accent=spec.accent,
        ink=spec.eyes or _INK,
        body=k["body"],
        arms=k["arms"] == "stub",
        legs=k["legs"] == "stub",
        mouth=k["face"] == "eyes_mouth",
        topper=k["topper"],
        topper_short=_solve(k["body"], k["legs"] == "stub", k["topper"]),
        size=BUILD_SIZE[spec.build],
        decorate=_decorate_from(spec),
    )


# ── Build ─────────────────────────────────────────────────────────────────────


def build(g: MascotGeometry, *, blink: bool = False) -> dict[str, Part]:
    dims = _BODY[g.body]
    rx, ry, rz = dims["r"]
    base, top = g.base, g.top
    parts: dict[str, Part] = {}

    body = Part("body")
    body.ellipsoid(_CX, base + dims["cy"], _CZ, rx, ry, rz, g.coat, y_min=base)
    body.paint_where(lambda x, y, z: y == base, g.coat_deep)  # the floor ring / underside
    parts["body"] = body

    if g.arms:
        # Stub arms rooted in the flank (x 7 is inside the body), four long so
        # a raised one reads as an arm and not a crumb.
        ay = base + max(2, int(dims["rows"] * 0.25))
        parts["arm_l"] = Part("arm_l").box(7, ay, 0, 10, ay + 1, 1, g.coat_deep)
        parts["arm_r"] = Part("arm_r").box(7, ay, 8, 10, ay + 1, 9, g.coat_deep)

    if g.legs:
        parts["leg_l"] = Part("leg_l").box(5, 0, 2, 6, _LEG_ROWS - 1, 3, g.coat_deep)
        parts["leg_r"] = Part("leg_r").box(9, 0, 5, 10, _LEG_ROWS - 1, 6, g.coat_deep)

    if g.topper != "none":
        parts["topper"] = _topper(g, top)

    # Markings and the pattern go on before the face, so nothing paints over an eye.
    if g.decorate:
        g.decorate(parts, g)

    # The face on the curved +x surface: two 2x2 eyes high, a mouth below.
    rows = dims["rows"]
    ey = base + int(rows * 0.55)
    eyes_z = ((2, 3), (6, 7)) if g.body != "tall" else ((2, 3), (5, 6))
    open_eyes = [(y, z) for y in (ey, ey + 1) for pair in eyes_z for z in pair]
    if blink:
        body.paint_front([(ey, z) for pair in eyes_z for z in pair], g.ink)
    else:
        body.paint_front(open_eyes, g.ink)
    if g.mouth:
        my = base + max(1, int(rows * 0.25))
        body.paint_front([(my, 4), (my, 5)], shade(g.coat_deep, 0.7))
    return parts


def _topper(g: MascotGeometry, top: int) -> Part:
    t = Part("topper")
    short = g.topper_short
    if g.topper == "sprout":
        t.box(7, top + 1, 4, 8, top + (1 if short else 2), 5, g.topper_deep)  # stem
        leaf_y = top + (2 if short else 3)
        t.box(5, leaf_y, 4, 10, leaf_y, 5, g.topper_color)
        if not short:
            t.box(6, leaf_y + 1, 4, 9, leaf_y + 1, 5, g.topper_color)
    elif g.topper == "antenna":
        stem_top = top + (1 if short else 3)
        t.box(7, top + 1, 4, 8, stem_top, 5, g.coat_deep)
        t.box(6, stem_top + 1, 3, 9, stem_top + 2, 6, g.topper_color)  # the knob
    elif g.topper == "horns":
        x0, x1 = g.x_range
        hx = x0 + 2
        for z0 in (1, 7):
            t.box(hx, top + 1, z0, hx + 1, top + 2, z0 + 1, g.topper_color)
    elif g.topper == "cap":
        # A mushroom cap: a wide flat dome sitting on the crown, spotted.
        rows = 3 if short else 4
        t.ellipsoid(_CX, top + 1.2, _CZ, 7.5, float(rows) - 0.4, 5.2, g.topper_color, y_min=top + 1)
        t.paint_where(lambda x, y, z: y == top + 1, g.topper_deep)  # the underside
        spots = g.accent or shade(g.topper_color, 1.25)
        t.paint_where(lambda x, y, z: y > top + 1 and ((x * 7 + z * 3) % 5 == 0), spots)
    return t


# ── Markings and the pattern ──────────────────────────────────────────────────


def _decorate_from(spec: PetSpec) -> Callable[[dict[str, Part], MascotGeometry], None] | None:
    from scripts.pets.plans.quadruped import paint_for, pattern_predicate

    if not spec.markings and spec.pattern.kind == "none":
        return None

    def decorate(parts: dict[str, Part], g: MascotGeometry) -> None:
        where = pattern_predicate(spec)
        if where is not None:
            parts["body"].paint_where(where, paint_for(spec, spec.pattern.color))
        x0, x1 = g.x_range
        base, top = g.base, g.top
        regions: dict[str, tuple[tuple[str, ...], Callable[[int, int, int], bool]]] = {
            "body": (("body",), lambda x, y, z: True),
            "belly": (("body",), lambda x, y, z: y <= base + 2),
            "face": (("body",), lambda x, y, z: x >= x1 - 1),
            "topper": (("topper",), lambda x, y, z: True),
            "arms": (("arm_l", "arm_r"), lambda x, y, z: True),
            "legs": (("leg_l", "leg_r"), lambda x, y, z: True),
        }
        for marking in spec.markings:
            names, predicate = regions[marking.where]
            colour = paint_for(spec, marking.color)
            for name in names:
                if name in parts:
                    parts[name].paint_where(predicate, colour)

    return decorate


# ── Rig and poses ─────────────────────────────────────────────────────────────


def rig_for(g: MascotGeometry) -> Rig:
    x0, x1 = g.x_range
    return Rig(
        turn_pivot=(_CX, _CZ),
        tilt_pivot=(_CX, float(g.base)),
        pitch_pivot=(_CX, g.base + 3.0),
        leg_height=_LEG_ROWS if g.legs else 0,
        body_bottom=g.base,
        body_top=g.top,
        head_top=g.top + _TOPPER_ROWS[g.topper][1 if g.topper_short else 0],
        anchors={"rear": (float(x0), float(g.base)), "front": (float(x1), float(g.base)), "arm_root": (7.5, g.base + max(2, int(_BODY[g.body]["rows"] * 0.25)) + 0.5)},
    )


_ALL = ("body", "arm_l", "arm_r", "leg_l", "leg_r", "topper")
_UPPER = ("body", "arm_l", "arm_r", "topper")


def _wave(i: int, n: int, amp: float, phase: float = 0.0) -> float:
    return amp * math.sin(2 * math.pi * (i / n) + phase)


def _rotate(p: Pose, parts: tuple[str, ...], pivot: tuple[float, float], deg: float) -> None:
    for part in parts:
        p.rotations[part] = (pivot, deg)


def pose(row: str, i: int, n: int, rig: Rig) -> Pose:
    # Positive rotate_z leans the top back and lifts the front; pivot on the
    # edge that must stay on the floor (rig.py).
    base = rig.tilt_pivot
    p = Pose()
    if row == "idle":
        p.lift = _wave(i, n, 0.5)
        p.offsets["topper"] = (0, _wave(i, n, 0.5, phase=1.0), 0)
        p.blink = i == n - 2
    elif row in ("running", "running-right", "running-left"):
        # A hop: up on the beat, arms trailing, feet tucked, a lean when travelling.
        hop = abs(_wave(i, n, 2.2))
        p.lift = hop
        swing = _wave(i, n, 1.2)
        p.offsets["arm_l"] = (-swing, abs(swing) * 0.5, 0)
        p.offsets["arm_r"] = (swing, abs(swing) * 0.5, 0)
        p.offsets["leg_l"] = (0, -hop * 0.4, 0)
        p.offsets["leg_r"] = (0, -hop * 0.4, 0)
        p.offsets["topper"] = (-0.5, _wave(i, n, 0.8, phase=1.2), 0)
        if row != "running":
            _rotate(p, _UPPER, base, -8)
    elif row == "waving":
        p.lift = -0.5
        # The near arm swings up about its root, so it stays attached.
        p.rotations["arm_l"] = (rig.anchors["arm_root"], 75 + _wave(i, n, 15))
        _rotate(p, ("body", "topper", "arm_r"), base, _wave(i, n, 4))
    elif row == "jumping":
        curve = [-1.5, 1.5, 3.5, 2.0, -0.5]
        up = [0.0, 1.0, 2.5, 1.5, 0.0]
        p.lift = curve[i % 5]
        for arm in ("arm_l", "arm_r"):
            p.offsets[arm] = (0, up[i % 5], 0)
        for leg in ("leg_l", "leg_r"):
            p.offsets[leg] = (0, up[i % 5] * 0.6, 0)
        p.offsets["topper"] = (0, -up[i % 5] * 0.5, 0)
    elif row == "failed":
        # Slumps forward over its front edge; the rear lifts, nothing goes under the floor.
        droop = min(1.0, i / 3)
        _rotate(p, _ALL, rig.anchors["front"], -14 * droop)
        p.offsets["arm_l"] = (0, -1.5 * droop, 0)
        p.offsets["arm_r"] = (0, -1.5 * droop, 0)
        p.offsets["topper"] = (0.5 * droop, -1.5 * droop, 0)
        p.blink = True
    elif row == "waiting":
        _rotate(p, _ALL, base, _wave(i, n, 4))
        p.offsets["arm_l"] = (0, _wave(i, n, 0.6, phase=0.8), 0)
        p.offsets["arm_r"] = (0, _wave(i, n, 0.6, phase=2.0), 0)
    elif row == "review":
        tilt = 12 * (0.5 + 0.5 * math.sin(2 * math.pi * i / n))
        _rotate(p, _ALL, (rig.anchors["rear"][0] + 3, base[1]), tilt)
        p.offsets["arm_r"] = (1.5, 3.0, 0)  # the far arm comes up to its chin
        p.blink = i in (n - 2, n - 1)
    elif row == "lounging":
        # Reclines: tips back onto its rear edge like a beanbag, arms out, slow blink.
        _rotate(p, _ALL, rig.anchors["rear"], 22)
        p.offsets["arm_l"] = (-1.0, -0.5, -0.5)
        p.offsets["arm_r"] = (-1.0, -0.5, 0.5)
        p.lift = _wave(i, n, 0.3)
        p.blink = i in (n - 3, n - 2)
    elif row == "sleep":
        # The recline, eyes shut all loop, arms fallen to the sides, just breathing.
        _rotate(p, _ALL, rig.anchors["rear"], 26)
        p.offsets["arm_l"] = (-1.5, -1.0, -0.5)
        p.offsets["arm_r"] = (-1.5, -1.0, 0.5)
        p.lift = _wave(i, n, 0.25)
        p.blink = True
    elif row == "carried":
        # Held: arms up over its head, feet dangling, a little sway — and the
        # whole body tips back a touch, so a mascot with no limbs at all (an
        # egg, a cloud) still reads as picked up rather than standing.
        sway = _wave(i, n, 0.6)
        _rotate(p, _ALL, base, 6)
        p.offsets["body"] = (sway * 0.3, 0, 0)
        p.rotations["arm_l"] = (rig.anchors["arm_root"], 80)
        p.rotations["arm_r"] = (rig.anchors["arm_root"], 80)
        p.offsets["leg_l"] = (sway, -1.0, 0)
        p.offsets["leg_r"] = (sway, -1.0, 0)
        p.offsets["topper"] = (sway * 0.5, 0, 0)
    return p


def look(yaw: int, pitch: int, rig: Rig) -> Pose:
    """A blob turns its whole body to look; the feet stay put."""
    p = Pose()
    heading = YAW_HEADINGS[max(0, min(YAW_STEPS - 1, yaw))]
    tilt = PITCH_ANGLES[max(0, min(PITCH_STEPS - 1, pitch))]
    for part in _UPPER:
        p.turns[part] = (rig.turn_pivot, heading)
        if tilt:
            p.rotations[part] = (rig.pitch_pivot, tilt)
    return p


# ── The plan ──────────────────────────────────────────────────────────────────


class MascotPlan:
    name = "mascot"
    kinds = tuple(KIND_DEFAULTS)
    vocabulary = VOCABULARY
    optional_rows: frozenset[str] = frozenset({"sleep", "carried"})

    def defaults(self, kind: str) -> dict[str, Any]:
        return dict(KIND_DEFAULTS[kind])

    def geometry(self, spec: PetSpec, *, slug: str) -> MascotGeometry:
        return geometry_from_spec(spec, slug=slug)

    def build(self, geometry: MascotGeometry, *, blink: bool = False) -> dict[str, Part]:
        return build(geometry, blink=blink)

    def rig(self, geometry: MascotGeometry) -> Rig:
        return rig_for(geometry)

    def fur(self, geometry: MascotGeometry) -> frozenset[Color]:
        return frozenset()  # a slime is smooth: no jitter

    def pose(self, row: str, i: int, n: int, rig: Rig) -> Pose:
        return pose(row, i, n, rig)

    def look(self, yaw: int, pitch: int, rig: Rig) -> Pose:
        return look(yaw, pitch, rig)


MASCOT = MascotPlan()

__all__ = ["BUILDS", "BUILD_SIZE", "KIND_DEFAULTS", "MASCOT", "MascotGeometry", "MascotPlan", "VOCABULARY", "build", "geometry_from_spec"]
