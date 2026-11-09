"""The quadruped plan: nine parts on four legs, in a few kinds.

The parts and their builder live in :mod:`scripts.pets.breeds` (a
:class:`Breed` is this plan's geometry) and the poses in
:mod:`scripts.pets.poses`; this module binds them, owns the vocabulary — the
knobs, the marking regions, the pattern — and the kinds: dog, cat, fox,
rabbit, pig, bear, with the knob defaults that make a cat a cat when the
spec says only ``"plan": "cat"``. Everything is proportions and styles on
the same rig: pointed ears and a long tail for a cat, a flat muzzle and a
stocky barrel for a pig.

The frame is zero-sum in height: legs + barrel + head − 2 (the head sits two
rows into the barrel) + whatever rises above the crown or the barrel must be
at most 18 rows, and Gigi already uses 17. :func:`layout` is the fit solver:
it gives up a barrel row first, then a head row, then a leg row.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable

from scripts.pets.breeds import EAR_RISE, TAIL_RISE, Box, Breed, Palette, build
from scripts.pets.plans import BUILDS, Vocabulary
from scripts.pets.poses import (
    pose_carried,
    pose_failed,
    pose_idle,
    pose_jump,
    pose_look,
    pose_lounging,
    pose_review,
    pose_run,
    pose_sleep,
    pose_wave,
    pose_waiting,
)
from scripts.pets.rig import Rig, rig_for
from scripts.pets.voxel import MAX_SPAN, Color, Part, Pose

if TYPE_CHECKING:
    from scripts.pets.spec import PetSpec

# ── The vocabulary ────────────────────────────────────────────────────────────

LENGTHS = ("short", "medium", "long")
DEPTHS = ("slim", "medium", "stocky")
HEADS = ("small", "medium", "large")
LEGS = ("short", "medium", "long")
EARS = ("drop", "upright", "round", "pointed", "none")
EAR_SIZES = ("small", "medium", "large")
TAILS = ("curl", "plume", "stub", "long", "none")
MUZZLES = ("flat", "short", "medium", "long")
REGIONS = (
    "head",  # the whole head
    "front",  # the lower front of the face, below the eyes
    "face",  # the front three columns of the head
    "muzzle",  # the muzzle itself — what the model reaches for first (bench, 2026-09-13)
    "mask",  # the band around the eyes, either side
    "blaze",  # the stripe down the middle of the front
    "crown",  # the top of the head
    "ears",
    "saddle",  # the back, rear two thirds
    "back",  # the back, full length
    "chest",  # the front of the body
    "belly",  # the underside
    "legs",  # the legs above the paws
    "paws",
    "tail",
    "tail_base",  # the tail up to the height of the back
    "tail_tip",  # the tail above it
)
# "build" is how big the desk draws the animal (Breed.size), because the
# frame is fixed and a large dog cannot be larger inside it. Gigi is 1.0.
BUILD_SIZE = {"small": 0.85, "medium": 1.0, "large": 1.3}

VOCABULARY = Vocabulary(
    knobs={
        "body_length": LENGTHS,
        "body_depth": DEPTHS,
        "head": HEADS,
        "legs": LEGS,
        "ears": EARS,
        "ear_size": EAR_SIZES,
        "tail": TAILS,
        "muzzle": MUZZLES,
    },
    defaults={"body_length": "medium", "body_depth": "medium", "head": "medium", "legs": "medium", "ears": "drop", "ear_size": "medium", "tail": "curl", "muzzle": "medium"},
    regions=REGIONS,
    sizes=BUILD_SIZE,
    card=("ears", "tail"),
    notes={
        "body_depth": "a slim barrel or a stocky one",
        "ears": "pointed is a cat's or a fox's; none for no ears",
        "tail": "long is held high like a cat's; none for no tail",
        "muzzle": "flat is a pug's or a cat's, painted onto the face",
    },
    palette="coat is the fur; coat_deep its shadow (darker); muzzle the muzzle's fur; accent and accent_deep a second coat colour and its shadow, for tan points, saddles, masks",
)

# Knob defaults per kind — what a spec that says only the word gets. Every
# value is a vocabulary option; ``spec.py`` validates them like anything a
# model writes. A dog is the vocabulary's defaults.
KIND_DEFAULTS: dict[str, dict[str, Any]] = {
    "dog": {},
    "cat": {"ears": "pointed", "ear_size": "medium", "tail": "long", "muzzle": "short", "body_depth": "slim"},
    "fox": {"ears": "pointed", "ear_size": "large", "tail": "plume", "muzzle": "long", "body_depth": "slim"},
    "rabbit": {"ears": "upright", "ear_size": "large", "tail": "stub", "muzzle": "short", "legs": "short", "head": "large"},
    "pig": {"ears": "drop", "ear_size": "small", "tail": "curl", "muzzle": "flat", "body_depth": "stocky", "legs": "short"},
    "bear": {"ears": "round", "ear_size": "small", "tail": "stub", "muzzle": "medium", "body_depth": "stocky", "head": "large"},
}

# ── The fit solver ────────────────────────────────────────────────────────────

_TOP = MAX_SPAN[1] - 1
_LEG_TOP = {"short": 3, "medium": 4, "long": 5}
_BODY_X1 = {"short": 10, "medium": 11, "long": 12}
_HEAD_HEIGHT = {"small": 7, "medium": 8, "large": 9}
_MUZZLE_ROWS = {"flat": 2, "short": 2, "medium": 3, "long": 4}
# The barrel: rows tall and how rounded. A slim animal is a rounder, shallower
# barrel; a stocky one a taller, boxier one.
_BODY_HEIGHT = {"slim": 6, "medium": 7, "stocky": 8}
_BODY_BITE = {"slim": 2, "medium": 1, "stocky": 1}
_HEAD_X = (9, 15)  # the head sits at the front; the muzzle lands at x=16


def layout(spec: PetSpec) -> tuple[Box, Box, int]:
    """(body, head, leg_top) for *spec*, lowered until the whole animal fits.

    Stacked from the ground: legs, a barrel, a head that sits two rows into
    the barrel, ears that rise above the crown — and a tail that may rise
    above the barrel. When something would leave the frame, the barrel gives
    a row first, then the head, then the legs: the head is what reads at
    192 px, a barrel row is what doesn't, and legs are already short.
    """
    leg_top = _LEG_TOP[spec.legs]
    body_h = _BODY_HEIGHT[spec.body_depth]
    head_h = _HEAD_HEIGHT[spec.head]
    rise = EAR_RISE[spec.ears][spec.ear_size]
    tail_rise = TAIL_RISE[spec.tail]

    def top(leg: int, bh: int, hh: int) -> int:
        by1 = leg + bh - 1
        return max(by1 - 1 + hh - 1 + rise, by1 + tail_rise)

    while top(leg_top, body_h, head_h) > _TOP:
        if body_h > _BODY_HEIGHT["slim"]:
            body_h -= 1
        elif head_h > _HEAD_HEIGHT["small"]:
            head_h -= 1
        elif leg_top > _LEG_TOP["short"]:
            leg_top -= 1
        else:  # pragma: no cover - the smallest animal always fits
            break

    by0 = leg_top
    by1 = by0 + body_h - 1
    hy0 = by1 - 1
    hy1 = hy0 + head_h - 1
    body: Box = (1, by0, 1, _BODY_X1[spec.body_length], by1, 8)
    head: Box = (_HEAD_X[0], hy0, 1, _HEAD_X[1], hy1, 8)
    return body, head, leg_top


# ── Markings and patterns ─────────────────────────────────────────────────────


def paint_for(spec: PetSpec, name: str) -> Color:
    """The colour a palette slot name means on *spec*."""
    return {
        "coat": spec.coat,
        "coat_deep": spec.coat_deep,
        "muzzle": spec.muzzle_color,
        "accent": spec.accent or spec.coat_deep,
        "accent_deep": spec.accent_deep or spec.coat_deep,
    }[name]


def _region(where: str, breed: Breed) -> tuple[str, Callable[[int, int, int], bool]]:
    """(part name, predicate) for a marking region on *breed*'s geometry."""
    bx0, by0, bz0, bx1, by1, bz1 = breed.body
    hx0, hy0, hz0, hx1, hy1, hz1 = breed.head
    everywhere: Callable[[int, int, int], bool] = lambda x, y, z: True  # noqa: E731
    table: dict[str, tuple[str, Callable[[int, int, int], bool]]] = {
        "head": ("head", everywhere),
        "front": ("head", lambda x, y, z: x == hx1 and y < hy1 - 3),
        "face": ("head", lambda x, y, z: x >= hx1 - 2),
        "muzzle": ("face", everywhere),
        "mask": ("head", lambda x, y, z: x == hx1 and hy1 - 3 <= y <= hy1 - 1 and (z <= hz0 + 2 or z >= hz1 - 2)),
        "blaze": ("head", lambda x, y, z: x == hx1 and hz0 + 3 <= z <= hz1 - 3),
        "crown": ("head", lambda x, y, z: y >= hy1 - 1),
        "ears": ("ears", everywhere),
        "saddle": ("body", lambda x, y, z: y >= by1 - 2 and x <= bx1 - 3),
        "back": ("body", lambda x, y, z: y >= by1 - 1),
        "chest": ("body", lambda x, y, z: x >= bx1 - 1),
        "belly": ("body", lambda x, y, z: y == by0),
        "legs": ("leg", lambda x, y, z: y > 0),
        "paws": ("leg", lambda x, y, z: y == 0),
        "tail": ("tail", everywhere),
        "tail_base": ("tail", lambda x, y, z: y < by1 + 2),
        "tail_tip": ("tail", lambda x, y, z: y >= by1 + 2),
    }
    return table[where]


def mix(seed: int, x: int, y: int, z: int) -> float:
    """A stable hash in [0, 1) — no Python `hash()`, which is salted per process."""
    h = (seed * 0x9E3779B1) ^ (x * 0x85EBCA77) ^ (y * 0xC2B2AE3D) ^ (z * 0x27D4EB2F)
    h &= 0xFFFFFFFF
    h ^= h >> 15
    h = (h * 0x2C1B3C6D) & 0xFFFFFFFF
    h ^= h >> 12
    return (h & 0xFFFFFF) / 0x1000000


SPOT_THRESHOLD = {"sparse": 0.12, "medium": 0.22, "dense": 0.34}
BRINDLE_PERIOD = {"sparse": 4, "medium": 3, "dense": 2}
_PATTERNED_PARTS = ("body", "head", "leg_fl", "leg_fr", "leg_bl", "leg_br", "tail")


def pattern_predicate(spec: PetSpec, *, keep_x: int | None = None) -> Callable[[int, int, int], bool] | None:
    """The voxel predicate for *spec*'s pattern, or ``None`` for no pattern.

    *keep_x* is a column the pattern leaves alone — the quadruped's face, so
    spots never land on an eye. Shared by every plan that paints a pattern.
    """
    pattern = spec.pattern
    if pattern.kind == "none":
        return None
    if pattern.kind == "spots":
        # Blobs two voxels across: hash the 2-cell, not the voxel, so a spot
        # is a spot and not confetti.
        threshold = SPOT_THRESHOLD[pattern.density]
        return lambda x, y, z: x != keep_x and mix(pattern.seed, x // 2, y // 2, z // 2) < threshold
    # brindle: tiger stripes, diagonal bands whose phase wanders with the seed.
    period = BRINDLE_PERIOD[pattern.density]
    return lambda x, y, z: x != keep_x and (x + y // 2 + int(mix(pattern.seed, 0, y, 0) * period)) % period == 0


def _decorate_from(spec: PetSpec) -> Callable[[dict[str, Part], Breed], None] | None:
    if not spec.markings and spec.pattern.kind == "none":
        return None

    def decorate(parts: dict[str, Part], breed: Breed) -> None:
        where = pattern_predicate(spec, keep_x=breed.head[3])
        if where is not None:
            colour = paint_for(spec, spec.pattern.color)
            for name in _PATTERNED_PARTS:
                if name in parts:
                    parts[name].paint_where(where, colour)
        for marking in spec.markings:
            part, predicate = _region(marking.where, breed)
            colour = paint_for(spec, marking.color)
            names = ("leg_fl", "leg_fr", "leg_bl", "leg_br") if part == "leg" else (part,)
            for name in names:
                if name in parts:  # an earless or tailless animal has no such region
                    parts[name].paint_where(predicate, colour)

    return decorate


def breed_from_spec(spec: PetSpec, *, slug: str) -> Breed:
    """The renderer's contract for *spec*: a :class:`Breed` that fits."""
    body, head, leg_top = layout(spec)
    large_head = spec.head == "large" or spec.muzzle == "long"
    rounded = spec.ears == "round"
    return Breed(
        slug=slug,
        display_name=spec.name,
        description=spec.description,
        palette=Palette(
            coat=spec.coat,
            coat_deep=spec.coat_deep,
            muzzle=spec.muzzle_color,
            accent=spec.accent,
            accent_deep=spec.accent_deep,
            **({"ink": spec.eyes} if spec.eyes else {}),
            **({"tongue": spec.tongue} if spec.tongue else {}),
            nose=spec.nose,
        ),
        body=body,
        body_bite=2 if rounded else _BODY_BITE[spec.body_depth],
        head=head,
        head_bite=2 if rounded else 1,
        ears=spec.ears,
        ear_size=spec.ear_size,
        ear_color=spec.ear_color,
        muzzle_rows=_MUZZLE_ROWS[spec.muzzle],
        muzzle_inset=1 if large_head else 2,
        muzzle_proud=spec.muzzle != "flat",
        leg_top=leg_top,
        tail=spec.tail,
        decorate=_decorate_from(spec),
        size=BUILD_SIZE[spec.build],
    )


# ── The plan ──────────────────────────────────────────────────────────────────


class QuadrupedPlan:
    name = "quadruped"
    kinds = tuple(KIND_DEFAULTS)
    vocabulary = VOCABULARY
    optional_rows: frozenset[str] = frozenset({"sleep", "carried"})

    def defaults(self, kind: str) -> dict[str, Any]:
        return dict(KIND_DEFAULTS[kind])

    def geometry(self, spec: PetSpec, *, slug: str) -> Breed:
        return breed_from_spec(spec, slug=slug)

    def build(self, geometry: Breed, *, blink: bool = False) -> dict[str, Part]:
        return build(geometry, blink=blink)

    def rig(self, geometry: Breed) -> Rig:
        return rig_for(geometry)

    def fur(self, geometry: Breed) -> frozenset[Color]:
        return geometry.palette.fur

    def pose(self, row: str, i: int, n: int, rig: Rig) -> Pose:
        if row == "idle":
            return pose_idle(i, n, rig)
        if row in ("running-right", "running-left"):
            return pose_run(i, n, rig, travelling=True)
        if row == "running":
            return pose_run(i, n, rig, travelling=False)
        if row == "waving":
            return pose_wave(i, n, rig)
        if row == "jumping":
            return pose_jump(i, n, rig)
        if row == "failed":
            return pose_failed(i, n, rig)
        if row == "waiting":
            return pose_waiting(i, n, rig)
        if row == "review":
            return pose_review(i, n, rig)
        if row == "lounging":
            return pose_lounging(i, n, rig)
        if row == "sleep":
            return pose_sleep(i, n, rig)
        if row == "carried":
            return pose_carried(i, n, rig)
        return Pose()

    def look(self, yaw: int, pitch: int, rig: Rig) -> Pose:
        return pose_look(yaw, pitch, rig)


QUADRUPED = QuadrupedPlan()

__all__ = ["BUILDS", "BUILD_SIZE", "KIND_DEFAULTS", "QUADRUPED", "QuadrupedPlan", "VOCABULARY", "breed_from_spec", "layout", "paint_for", "pattern_predicate"]
