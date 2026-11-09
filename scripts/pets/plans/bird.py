'The bird plan: an egg of a body, a head, a beak, two wings, two feet.\n\nChicks, owls, penguins, parrots, ducks — round things that hop (plan\n2026-09-13-pet-plans-rig-and-activities, decision 6). The rows in a bird\'s\nidiom: "running" is a two-footed hop with a flutter, "waving" one wing up,\n"jumping" both wings spread, "failed" head down and wings drooped,\n"lounging" a roost with the feet hidden and the body settled onto them, and\nthe look grid turns the head and beak together.\n\nSpindly birds are out of the house style at 55 px: legs are two voxels\nthick, necks one row at most, and the fit solver takes the crest, then the\nneck, then a leg row before anything can clip.\n\nProven in the W0 spike ; the\nshapes here are that chick with knobs.\n'

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

BODIES = ("round", "slim")
NECKS = ("short", "medium", "long")  # medium: the model assumed it, as every other knob has one (bench, 2026-09-13)
BEAKS = ("short", "long", "hooked")
WINGS = ("stub", "folded")
LEGS = ("short", "medium")
TAILS = ("short", "fan")
CRESTS = ("none", "tuft")
REGIONS = ("head", "face", "mask", "beak", "neck", "chest", "belly", "back", "wings", "tail", "feet")
BUILD_SIZE = {"small": 0.7, "medium": 0.9, "large": 1.1}

VOCABULARY = Vocabulary(
    knobs={"body": BODIES, "neck": NECKS, "beak": BEAKS, "wings": WINGS, "legs": LEGS, "tail": TAILS, "crest": CRESTS},
    defaults={"body": "round", "neck": "short", "beak": "short", "wings": "folded", "legs": "short", "tail": "short", "crest": "none"},
    regions=REGIONS,
    sizes=BUILD_SIZE,
    card=("beak", "wings"),
    notes={
        "wings": "stub is a penguin's flipper",
        "beak": "hooked is an owl's or a parrot's",
        "tail": "fan spreads wide like a parrot's",
    },
    palette="coat is the feathers; coat_deep the wings and tail; muzzle the beak and feet; accent the belly; accent_deep any pattern or marking",
)

KIND_DEFAULTS: dict[str, dict[str, Any]] = {
    "bird": {},
    "chick": {"legs": "short", "tail": "short", "wings": "folded"},
    "owl": {"beak": "hooked", "crest": "tuft", "body": "round", "legs": "short"},
    "penguin": {"wings": "stub", "body": "slim", "neck": "short", "legs": "short", "beak": "short"},
    "parrot": {"beak": "hooked", "tail": "fan", "crest": "tuft", "neck": "short"},
    "duck": {"beak": "long", "neck": "long", "tail": "short", "legs": "medium"},
}

# ── Geometry ──────────────────────────────────────────────────────────────────

_TOP = MAX_SPAN[1] - 1
_BODY = {"round": {"r": (4.6, 4.6, 3.6), "rows": 9}, "slim": {"r": (3.8, 5.0, 3.2), "rows": 10}}
_LEG_H = {"short": 3, "medium": 4}
_NECK_LIFT = {"short": 1.5, "medium": 2.25, "long": 3.0}
_SHORTER_NECK = {"long": "medium", "medium": "short"}
_HEAD_R = (3.6, 3.4, 3.2)
_CREST_ROWS = {"none": 0, "tuft": 2}
_BX, _HX, _CZ = 6.0, 10.0, 5.0
_INK: Color = (38, 36, 42)


@dataclass(frozen=True)
class BirdGeometry:
    slug: str
    display_name: str
    description: str
    coat: Color
    coat_deep: Color
    beak_color: Color
    belly: Color
    ink: Color
    body: str
    neck: str
    beak: str
    wings: str
    leg_h: int
    tail: str
    crest_rows: int
    size: float
    decorate: Callable[[dict[str, Part], "BirdGeometry"], None] | None = None

    @property
    def body_cy(self) -> float:
        return self.leg_h + _BODY[self.body]["r"][1]

    @property
    def body_top(self) -> int:
        return self.leg_h + _BODY[self.body]["rows"] - 1

    @property
    def head_cy(self) -> float:
        return self.body_top + _NECK_LIFT[self.neck]

    @property
    def head_top(self) -> int:
        return int(self.head_cy + _HEAD_R[1])

    @property
    def head_x(self) -> tuple[int, int]:
        return int(_HX - _HEAD_R[0]) + 1, int(_HX + _HEAD_R[0])


def _solve(body: str, neck: str, leg_h: int, crest_rows: int) -> tuple[str, str, int, int]:
    """Lower the bird until it fits: the crest gives first, then the neck,
    then a leg row, then the slim body's extra row."""

    def top(b: str, nk: str, lh: int, cr: int) -> int:
        return int(lh + _BODY[b]["rows"] - 1 + _NECK_LIFT[nk] + _HEAD_R[1]) + cr

    while top(body, neck, leg_h, crest_rows) > _TOP:
        if crest_rows > 0:
            crest_rows -= 1
        elif neck != "short":
            neck = _SHORTER_NECK[neck]
        elif leg_h > _LEG_H["short"]:
            leg_h -= 1
        elif body == "slim":
            body = "round"
        else:  # pragma: no cover - the smallest bird always fits
            break
    return body, neck, leg_h, crest_rows


def geometry_from_spec(spec: PetSpec, *, slug: str) -> BirdGeometry:
    k = spec.knobs
    body, neck, leg_h, crest_rows = _solve(k["body"], k["neck"], _LEG_H[k["legs"]], _CREST_ROWS[k["crest"]])
    return BirdGeometry(
        slug=slug,
        display_name=spec.name,
        description=spec.description,
        coat=spec.coat,
        coat_deep=spec.coat_deep,
        beak_color=spec.muzzle_color,
        belly=spec.accent or shade(spec.coat, 1.08),
        ink=spec.eyes or _INK,
        body=body,
        neck=neck,
        beak=k["beak"],
        wings=k["wings"],
        leg_h=leg_h,
        tail=k["tail"],
        crest_rows=crest_rows,
        size=BUILD_SIZE[spec.build],
        decorate=_decorate_from(spec),
    )


# ── Build ─────────────────────────────────────────────────────────────────────


def build(g: BirdGeometry, *, blink: bool = False) -> dict[str, Part]:
    rx, ry, rz = _BODY[g.body]["r"]
    parts: dict[str, Part] = {}

    body = Part("body")
    body.ellipsoid(_BX, g.body_cy, _CZ, rx, ry, rz, g.coat)
    body.paint_where(lambda x, y, z: x >= _BX + 2 and y <= g.body_cy, g.belly)  # the front tummy
    body.paint_where(lambda x, y, z: y <= g.leg_h, g.coat_deep)  # underside shadow
    parts["body"] = body

    head = Part("head")
    head.ellipsoid(_HX, g.head_cy, _CZ, *_HEAD_R, g.coat)
    parts["head"] = head
    if g.neck != "short":
        # A short column joining head and body, so a duck has a neck and not a gap.
        parts["neck"] = Part("neck").box(int(_HX) - 1, g.body_top, 4, int(_HX), int(g.head_cy) - 2, 5, g.coat)

    hx0, hx1 = g.head_x
    by = int(g.head_cy) - 1
    beak = Part("beak")
    if g.beak == "long":
        beak.box(hx1 + 1, by, 4, hx1 + 3, by + 1, 5, g.beak_color)
    elif g.beak == "hooked":
        beak.box(hx1 + 1, by, 4, hx1 + 2, by + 1, 5, g.beak_color)
        beak.box(hx1 + 2, by - 1, 4, hx1 + 2, by - 1, 5, shade(g.beak_color, 0.85))  # the hook, turning down
    else:
        beak.box(hx1 + 1, by, 4, hx1 + 2, by + 1, 5, g.beak_color)
    parts["beak"] = beak

    wy0 = g.leg_h + 2
    if g.wings == "stub":
        # Flippers: short panels held against the flanks.
        parts["wing_l"] = Part("wing_l").rounded(4, wy0, 0, 7, wy0 + 3, 1, g.coat_deep, bite=1)
        parts["wing_r"] = Part("wing_r").rounded(4, wy0, 8, 7, wy0 + 3, 9, g.coat_deep, bite=1)
    else:
        parts["wing_l"] = Part("wing_l").rounded(3, wy0, 0, 8, wy0 + 5, 1, g.coat_deep, bite=2)
        parts["wing_r"] = Part("wing_r").rounded(3, wy0, 8, 8, wy0 + 5, 9, g.coat_deep, bite=2)

    ty = g.body_top - 1
    tail = Part("tail")
    if g.tail == "fan":
        tail.box(1, ty, 3, 2, ty, 7, g.coat_deep)
        tail.box(0, ty + 1, 2, 1, ty + 1, 8, g.coat_deep)
    else:
        tail.box(1, ty, 4, 2, ty, 6, g.coat_deep)
        tail.box(0, ty + 1, 4, 1, ty + 1, 6, g.coat_deep)
    parts["tail"] = tail

    parts["leg_l"] = Part("leg_l").box(6, 0, 3, 7, g.leg_h, 4, g.beak_color)
    parts["leg_r"] = Part("leg_r").box(6, 0, 6, 7, g.leg_h, 7, g.beak_color)

    if g.crest_rows:
        crest = Part("crest").box(int(_HX) - 1, g.head_top + 1, 4, int(_HX), g.head_top + g.crest_rows, 5, g.coat_deep)
        parts["crest"] = crest

    # Markings and the pattern go on before the eyes, so nothing paints over one.
    if g.decorate:
        g.decorate(parts, g)

    ey = int(g.head_cy) + 1
    eyes = [(ey, 2), (ey - 1, 2), (ey, 8), (ey - 1, 8)]
    if blink:
        head.paint_front([(ey - 1, 2), (ey - 1, 8)], g.ink)
    else:
        head.paint_front(eyes, g.ink)
    return parts


# ── Markings and the pattern ──────────────────────────────────────────────────


def _decorate_from(spec: PetSpec) -> Callable[[dict[str, Part], BirdGeometry], None] | None:
    from scripts.pets.plans.quadruped import paint_for, pattern_predicate

    if not spec.markings and spec.pattern.kind == "none":
        return None

    def decorate(parts: dict[str, Part], g: BirdGeometry) -> None:
        where = pattern_predicate(spec)
        if where is not None:
            colour = paint_for(spec, spec.pattern.color)
            for name in ("body", "head", "wing_l", "wing_r"):
                parts[name].paint_where(where, colour)
        hx0, hx1 = g.head_x
        regions: dict[str, tuple[tuple[str, ...], Callable[[int, int, int], bool]]] = {
            "head": (("head",), lambda x, y, z: True),
            "face": (("head",), lambda x, y, z: x >= hx1 - 1),
            "mask": (("head",), lambda x, y, z: x >= hx1 - 2 and int(g.head_cy) - 1 <= y <= int(g.head_cy) + 1),
            "beak": (("beak",), lambda x, y, z: True),
            # The neck: the column when there is one, and the head's lowest
            # rows either way — a mallard's ring (bench, 2026-09-13).
            "neck": (("neck", "head"), lambda x, y, z: y <= int(g.head_cy) - 2),
            "chest": (("body",), lambda x, y, z: x >= _BX + 2),
            "belly": (("body",), lambda x, y, z: y <= g.leg_h + 2),
            "back": (("body",), lambda x, y, z: y >= g.body_top - 2),
            "wings": (("wing_l", "wing_r"), lambda x, y, z: True),
            "tail": (("tail",), lambda x, y, z: True),
            "feet": (("leg_l", "leg_r"), lambda x, y, z: y <= 1),
        }
        for marking in spec.markings:
            names, predicate = regions[marking.where]
            colour = paint_for(spec, marking.color)
            for name in names:
                if name in parts:
                    parts[name].paint_where(predicate, colour)

    return decorate


# ── Rig and poses ─────────────────────────────────────────────────────────────


def rig_for(g: BirdGeometry) -> Rig:
    return Rig(
        turn_pivot=(_HX, _CZ),
        tilt_pivot=(_HX - 1.0, g.head_cy - 2.5),
        pitch_pivot=(_HX - 1.0, g.head_cy - 2.5),
        leg_height=g.leg_h,
        body_bottom=g.leg_h,
        body_top=g.body_top,
        head_top=g.head_top + g.crest_rows,
        anchors={"shoulder": (4.0, float(g.leg_h + (5 if g.wings == "stub" else 7)))},
    )


_HEAD = ("head", "beak", "crest", "neck")
_WINGS = ("wing_l", "wing_r")
_LEGS = ("leg_l", "leg_r")
_NOT_LEGS = ("body", "head", "beak", "crest", "neck", "wing_l", "wing_r", "tail")


def _wave(i: int, n: int, amp: float, phase: float = 0.0) -> float:
    return amp * math.sin(2 * math.pi * (i / n) + phase)


def _head(p: Pose, rig: Rig, deg: float) -> None:
    for part in _HEAD:
        p.rotations[part] = (rig.tilt_pivot, deg)


def _wings(p: Pose, rig: Rig, deg: float) -> None:
    for part in _WINGS:
        p.rotations[part] = (rig.anchors["shoulder"], deg)


def _offset(p: Pose, parts: tuple[str, ...], dx: float, dy: float, dz: float = 0.0) -> None:
    for part in parts:
        p.offsets[part] = (dx, dy, dz)


def pose(row: str, i: int, n: int, rig: Rig) -> Pose:
    # Positive rotate_z lifts a bar's front (beak up); negative is beak down (rig.py).
    p = Pose()
    if row == "idle":
        p.lift = _wave(i, n, 0.4)
        _offset(p, _HEAD, 0, _wave(i, n, 0.5, phase=0.6))
        p.offsets["tail"] = (0, _wave(i, n, 0.8, phase=1.5), 0)
        p.blink = i == n - 2
    elif row in ("running", "running-right", "running-left"):
        # A two-footed hop with a flutter; feet tuck at the top.
        hop = abs(_wave(i, n, 2.4))
        p.lift = hop
        _offset(p, _LEGS, 0, -hop * 0.5)
        _wings(p, rig, 14 * math.sin(2 * math.pi * i / n * 2))
        _offset(p, _HEAD, 0.3, -hop * 0.2)
        if row != "running":
            _head(p, rig, -6)
    elif row == "waving":
        p.rotations["wing_l"] = (rig.anchors["shoulder"], 70 + _wave(i, n, 15))  # the near wing up
        p.offsets["wing_l"] = (1.0, 1.5, 0)
        _head(p, rig, _wave(i, n, 5))
    elif row == "jumping":
        curve = [-1.5, 1.2, 3.5, 2.0, -0.5]
        spread = [0.0, 20.0, 45.0, 30.0, 0.0]
        tuck = [0.0, 0.5, 1.5, 1.0, 0.0]
        p.lift = curve[i % 5]
        _wings(p, rig, spread[i % 5])
        _offset(p, _LEGS, 0, tuck[i % 5])
    elif row == "failed":
        droop = min(1.0, i / 3)
        _offset(p, _HEAD, 0.5 * droop, -2.0 * droop)
        _head(p, rig, -16 * droop)
        _wings(p, rig, -18 * droop)
        p.offsets["tail"] = (0, -2.0 * droop, 0)
        p.blink = True
    elif row == "waiting":
        _head(p, rig, _wave(i, n, 6, phase=0.5))
        p.offsets["tail"] = (0, 0.5 + _wave(i, n, 0.6), _wave(i, n, 1.6))
        _offset(p, _HEAD, 0, _wave(i, n, 0.4))
    elif row == "review":
        _head(p, rig, 14 * (0.5 + 0.5 * math.sin(2 * math.pi * i / n)))
        p.blink = i in (n - 2, n - 1)
    elif row == "lounging":
        # A roost: feet hidden, body down onto them, head tucked in, slow blink.
        breath = _wave(i, n, 0.3)
        p.hidden.update(_LEGS)
        drop = -rig.leg_height + breath
        _offset(p, _NOT_LEGS, 0, drop)
        _offset(p, _HEAD, -0.8, drop - 1.0)
        _head(p, rig, -6)
        p.blink = i in (n - 3, n - 2)
    elif row == "sleep":
        # The roost with the head tucked right in and the eyes shut all loop.
        breath = _wave(i, n, 0.25)
        p.hidden.update(_LEGS)
        drop = -rig.leg_height + breath
        _offset(p, _NOT_LEGS, 0, drop)
        _offset(p, _HEAD, -1.5, drop - 1.5)
        _head(p, rig, -14)
        _wings(p, rig, -4)
        p.blink = True
    elif row == "carried":
        # Held: wings half out for balance, feet dangling, a little sway.
        sway = _wave(i, n, 0.6)
        _wings(p, rig, 30)
        _offset(p, _LEGS, sway, -1.0)
        p.offsets["tail"] = (0, -1.0, 0)
    return p


def look(yaw: int, pitch: int, rig: Rig) -> Pose:
    p = Pose()
    heading = YAW_HEADINGS[max(0, min(YAW_STEPS - 1, yaw))]
    tilt = PITCH_ANGLES[max(0, min(PITCH_STEPS - 1, pitch))]
    for part in ("head", "beak", "crest"):
        p.turns[part] = (rig.turn_pivot, heading)
        if tilt:
            p.rotations[part] = (rig.pitch_pivot, tilt)
    return p


# ── The plan ──────────────────────────────────────────────────────────────────


class BirdPlan:
    name = "bird"
    kinds = tuple(KIND_DEFAULTS)
    vocabulary = VOCABULARY
    optional_rows: frozenset[str] = frozenset({"sleep", "carried"})

    def defaults(self, kind: str) -> dict[str, Any]:
        return dict(KIND_DEFAULTS[kind])

    def geometry(self, spec: PetSpec, *, slug: str) -> BirdGeometry:
        return geometry_from_spec(spec, slug=slug)

    def build(self, geometry: BirdGeometry, *, blink: bool = False) -> dict[str, Part]:
        return build(geometry, blink=blink)

    def rig(self, geometry: BirdGeometry) -> Rig:
        return rig_for(geometry)

    def fur(self, geometry: BirdGeometry) -> frozenset[Color]:
        return frozenset({geometry.coat, geometry.coat_deep, geometry.belly})  # down, not enamel

    def pose(self, row: str, i: int, n: int, rig: Rig) -> Pose:
        return pose(row, i, n, rig)

    def look(self, yaw: int, pitch: int, rig: Rig) -> Pose:
        return look(yaw, pitch, rig)


BIRD = BirdPlan()

__all__ = ["BUILDS", "BUILD_SIZE", "BIRD", "BirdGeometry", "BirdPlan", "KIND_DEFAULTS", "VOCABULARY", "build", "geometry_from_spec"]
