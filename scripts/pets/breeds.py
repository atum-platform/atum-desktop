"""The breeds. A pet is a spec; the model builder is shared.

Every first-party pet is the same nine parts — body, head, ears, face, four
legs, tail — built from a :class:`Breed` that says what colour the coat is,
how the ears hang, how stocky the body is, and what markings to paint. The
poses in :mod:`scripts.pets.poses` move those parts by name, so a new dog is a
new spec, not a new animation set.

Proportions are bounded by the frame: `MAX_SPAN` is (17, 18, 10) voxels in
(x, y, z), and a Bernese Mountain Dog cannot be literally larger than a maltese inside
a 192×208 cell. "Big" is a taller, longer body, heavier legs, drop ears and a
mask; "small" is a shorter body and a lower head.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Callable, Literal

from scripts.pets.voxel import Color, Part

Box = tuple[int, int, int, int, int, int]
EarStyle = Literal["drop", "upright", "round", "pointed", "none"]
EarSize = Literal["small", "medium", "large"]
TailStyle = Literal["curl", "plume", "stub", "long", "none"]

# How far each ear style rises above the crown, by size — the layout needs it
# to keep the whole animal inside the frame.
EAR_RISE: dict[EarStyle, dict[EarSize, int]] = {
    "drop": {"small": 0, "medium": 0, "large": 0},
    "upright": {"small": 2, "medium": 3, "large": 4},
    "round": {"small": 0, "medium": 1, "large": 2},
    "pointed": {"small": 2, "medium": 3, "large": 4},
    "none": {"small": 0, "medium": 0, "large": 0},
}
# How far each tail style rises above the barrel's top row.
TAIL_RISE: dict[TailStyle, int] = {"curl": 2, "plume": 3, "stub": 0, "long": 4, "none": 0}


@dataclass(frozen=True)
class Palette:
    coat: Color
    coat_deep: Color
    muzzle: Color
    ink: Color = (35, 33, 42)  # eyes, and the nose unless one is given
    tongue: Color = (242, 125, 149)
    nose: Color | None = None
    # Optional second coat colour and its shadow, for tan points, saddles, masks.
    accent: Color | None = None
    accent_deep: Color | None = None

    @property
    def fur(self) -> frozenset[Color]:
        """Colours that get the per-voxel jitter — everything that is fur."""
        return frozenset(c for c in (self.coat, self.coat_deep, self.muzzle, self.accent, self.accent_deep) if c)


@dataclass(frozen=True)
class Breed:
    slug: str
    display_name: str
    description: str
    palette: Palette
    # Inclusive voxel boxes: (x0, y0, z0, x1, y1, z1). The dog faces +x.
    body: Box = (1, 4, 1, 11, 10, 8)
    body_bite: int = 1
    head: Box = (9, 9, 1, 15, 16, 8)
    head_bite: int = 1
    ears: EarStyle = "drop"
    ear_size: EarSize = "medium"
    ear_color: Color | None = None  # defaults to the coat shadow
    # Muzzle: one voxel proud of the face (or painted flat onto it, for a pug),
    # this many rows tall, inset from the head's z edges by this much.
    muzzle_rows: int = 3
    muzzle_inset: int = 2
    muzzle_proud: bool = True
    leg_top: int = 4  # legs fill y = 0..leg_top
    tail: TailStyle = "curl"
    # Markings, painted onto the built parts before the face is drawn.
    decorate: Callable[["dict[str, Part]", "Breed"], None] | None = None
    # How big the desk draws this dog relative to Gigi, on top of the user's
    # scale. The frame is fixed, so "big" cannot live in the voxels: a Bernese
    # Mountain Dog at 1.45 is clearly bigger than a maltese without being to scale
    # (that would be 3-4x and cover the window). Written to pet.json as `size`.
    size: float = 1.0
    # House-only v5 nominal visible height; Hatch remains on legacy size.
    natural_height_pt: float | None = None
    # First-party geometry only. These are deliberately absent from the hatch
    # vocabulary: a model still supplies the plan's existing validated knobs.
    cotton_coat: bool = False
    leg_width: int = 3
    low_tail: bool = False
    grounded_sit: bool = False


def build(breed: Breed, *, blink: bool = False) -> dict[str, Part]:
    """The neutral (idle, frame 0) pose. Every animation transforms these parts.

    The dog faces +x, so its face lands on the screen-right of the head and its
    flank on the screen-left — both visible faces of the projection carry
    something to look at. The sheet builder flips rows to petdex's left-facing
    convention on the way out.
    """
    if breed.cotton_coat:
        return _build_cotton_coat(breed, blink=blink)
    pal = breed.palette
    bx0, by0, bz0, bx1, by1, bz1 = breed.body
    hx0, hy0, hz0, hx1, hy1, hz1 = breed.head
    ear = breed.ear_color or pal.coat_deep
    parts: dict[str, Part] = {}

    # Body: a furry barrel sitting low between the legs, with a belly shadow.
    body = Part("body")
    body.rounded(bx0, by0, bz0, bx1, by1, bz1, pal.coat, bite=breed.body_bite)
    body.box(bx0 + 1, by0, bz0 + 1, bx1 - 1, by0, bz1 - 1, pal.coat_deep)
    parts["body"] = body

    # Head: the whole silhouette reads off this at small sizes, so it is large
    # relative to the body — puppy proportions, deliberately.
    head = Part("head")
    head.rounded(hx0, hy0, hz0, hx1, hy1, hz1, pal.coat, bite=breed.head_bite)
    parts["head"] = head

    # Ears: every style is two voxels thick, not one. The look frames rotate
    # the ears with the head, and a single-voxel plane turned 45 degrees
    # cannot stay solid on a grid — it resamples into a sparse diagonal and
    # the ear comes out looking combed. `size` is how tall they are; the
    # medium of each style is what shipped.
    ears = Part("ears")
    size = {"small": -1, "medium": 0, "large": 1}[breed.ear_size]
    if breed.ears == "drop":
        # Tapered panels hanging either side: a full-width top, a narrower
        # body, a tip.
        top_rows = 4 + size
        for z0 in (hz0 - 1, hz1):
            ears.box(hx0 + 1, hy1 - top_rows, z0, hx1 - 1, hy1 - 1, z0 + 1, ear)
            ears.box(hx0 + 2, hy1 - top_rows - 2, z0, hx1 - 2, hy1 - top_rows - 1, z0 + 1, ear)
            ears.box(hx0 + 3, hy1 - top_rows - 3, z0, hx0 + 3, hy1 - top_rows - 3, z0 + 1, ear)
    elif breed.ears == "upright":
        # Two pricked triangles on top of the head, toward the back: a wide
        # base, a narrower row or two, a tip.
        rise = EAR_RISE["upright"][breed.ear_size]
        for z0 in (hz0 + 1, hz1 - 2):
            ears.box(hx0 + 1, hy1 + 1, z0, hx0 + 3, hy1 + 1, z0 + 1, ear)
            for y in range(hy1 + 2, hy1 + rise):
                ears.box(hx0 + 1, y, z0, hx0 + 2, y, z0 + 1, ear)
            ears.box(hx0 + 2, hy1 + rise, z0, hx0 + 2, hy1 + rise, z0 + 1, ear)
    elif breed.ears == "pointed":
        # A cat's: two thin triangles on the outer edges of the crown, well
        # apart, so the head reads feline even at 55 px.
        rise = EAR_RISE["pointed"][breed.ear_size]
        for z0 in (hz0, hz1 - 1):
            for y in range(hy1 + 1, hy1 + rise):
                ears.box(hx0 + 1, y, z0, hx0 + 2, y, z0 + 1, ear)
            ears.box(hx0 + 2, hy1 + rise, z0, hx0 + 2, hy1 + rise, z0 + 1, ear)
    elif breed.ears == "round":
        # Big soft puffs either side, rising just above the crown — the
        # silhouette that says bichon rather than a rounder maltese.
        for z0 in (hz0 - 1, hz1):
            ears.rounded(hx0 + 1, hy1 - 4 - size, z0, hx1 - 1, hy1 + 1 + size, z0 + 1, ear, bite=1)
    if ears.voxels:
        parts["ears"] = ears

    # Muzzle: one voxel proud of the face — or painted flat onto it — carrying
    # the nose and mouth.
    face = Part("face")
    fx = hx1 + 1 if breed.muzzle_proud else hx1
    top = hy1 - 4
    bottom = top - (breed.muzzle_rows - 1)
    fz0, fz1 = hz0 + breed.muzzle_inset, hz1 - breed.muzzle_inset
    face.box(fx, bottom, fz0, fx, top, fz1, pal.muzzle)
    parts["face"] = face

    # Four legs, each a stubby column with a shaded paw.
    for name, x0, z0 in (
        ("leg_fl", bx1 - 3, bz0),
        ("leg_fr", bx1 - 3, bz1 - 2),
        ("leg_bl", bx0 + 1, bz0),
        ("leg_br", bx0 + 1, bz1 - 2),
    ):
        leg = Part(name)
        # Broader large-dog paws stay inside the existing body footprint.
        width = breed.leg_width - 1
        if breed.leg_width > 3:
            x0 = min(x0, bx1 - width)
            z0 = min(z0, bz1 - width)
        leg.box(x0, 0, z0, x0 + width, breed.leg_top, z0 + width, pal.coat)
        leg.box(x0, 0, z0, x0 + width, 0, z0 + width, pal.coat_deep)  # paw
        parts[name] = leg

    tail = Part("tail")
    # Two voxels wide, straddling the body's midline on its far side.
    zt = (bz0 + bz1) // 2
    if breed.low_tail:
        tail.rounded(bx0 - 1, by0 + 1, zt, bx0, by0 + 4, zt + 1,
                     pal.coat, bite=1)
    elif breed.tail == "curl":
        # A stub curling up over the back.
        tail.box(bx0 - 1, by1 - 2, zt, bx0, by1, zt + 1, pal.coat)
        tail.box(bx0 - 1, by1 + 1, zt, bx0 - 1, by1 + 2, zt + 1, pal.coat)
    elif breed.tail == "plume":
        # A fuller brush held high.
        tail.box(bx0 - 1, by1 - 1, zt, bx0, by1 + 2, zt + 1, pal.coat)
        tail.box(bx0 - 1, by1 + 3, zt, bx0 - 1, by1 + 3, zt + 1, pal.coat_deep)
    elif breed.tail == "long":
        # A cat's: rising straight up from the rump, a little hook at the tip.
        tail.box(bx0 - 1, by1 - 2, zt, bx0, by1 + 1, zt + 1, pal.coat)
        tail.box(bx0 - 1, by1 + 2, zt, bx0 - 1, by1 + 4, zt + 1, pal.coat)
        tail.box(bx0, by1 + 4, zt, bx0, by1 + 4, zt + 1, pal.coat_deep)
    elif breed.tail == "stub":
        tail.box(bx0 - 1, by1 - 1, zt, bx0, by1, zt + 1, pal.coat)
    if tail.voxels:
        parts["tail"] = tail

    # Markings go on before the face, so a mask can never overpaint an eye.
    if breed.decorate:
        breed.decorate(parts, breed)

    # Eyes painted onto the front face, two voxels tall so they survive the
    # downscale. They sit high on the head: in this projection the far eye
    # drops toward the muzzle, and at eye level it landed on the same screen
    # row as the nose, reading as one dark smear across the face.
    eyes = [(hx1, hy1 - 1, hz0 + 1), (hx1, hy1 - 1, hz1 - 1), (hx1, hy1 - 2, hz0 + 1), (hx1, hy1 - 2, hz1 - 1)]
    if blink:
        head.paint(eyes, pal.coat)
        head.paint([(hx1, hy1 - 2, hz0 + 1), (hx1, hy1 - 2, hz1 - 1)], pal.ink)  # closed: a single lash line
    else:
        head.paint(eyes, pal.ink)
    zc = (fz0 + fz1) // 2
    face.paint([(fx, top, zc), (fx, top, zc + 1)], pal.nose or pal.ink)  # nose
    face.paint([(fx, bottom, zc), (fx, bottom, zc + 1)], pal.tongue)  # mouth

    return parts


def _rounded_mass(part: Part, box: Box, color: Color, roundness: float, *, back: float | None = None) -> None:
    """Fill *box* with a superellipsoid: flat faces with softly rounded edges.

    At this resolution a voxel sphere stacks into terraces and a box reads as a
    brick; a superellipsoid between the two reads as one soft mass of coat.
    *back*, when given, is the roundness of the half behind the box's centre
    in x: a head can keep a flat face in front and still be round behind.
    """
    x0, y0, z0, x1, y1, z1 = box
    centre = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    radii = ((x1 - x0) / 2 + .5, (y1 - y0) / 2 + .5, (z1 - z0) / 2 + .5)
    for x in range(x0, x1 + 1):
        k = back if back is not None and x < centre[0] else roundness
        for y in range(y0, y1 + 1):
            for z in range(z0, z1 + 1):
                reach = sum(abs((v - c) / r) ** k for v, c, r in zip((x, y, z), centre, radii))
                if reach <= 1:
                    part.voxels.append((x, y, z, color))


def _segment_distance(px: float, py: float, a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance from (px, py) to the segment a-b."""
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def _plume(part: Part, path: list[tuple[float, float]], z_mid: float, radius: float, half_width: float, color: Color) -> None:
    """A soft tube of coat along *path* in the (x, y) plane, centred on *z_mid*:
    a tail that curls instead of stacking boxes."""
    xs = [px for px, _ in path]
    ys = [py for _, py in path]
    for x in range(int(min(xs) - radius) - 1, int(max(xs) + radius) + 2):
        for y in range(int(min(ys) - radius) - 1, int(max(ys) + radius) + 2):
            near = min(_segment_distance(x, y, a, b) for a, b in zip(path, path[1:]))
            for z in range(math.floor(z_mid - half_width), math.ceil(z_mid + half_width) + 1):
                if (near / radius) ** 2 + ((z - z_mid) / half_width) ** 2 <= 1:
                    part.voxels.append((x, y, z, color))


def _dedupe(part: Part) -> Part:
    """Keep one voxel per cell, the last colour written: overlapping masses
    would otherwise draw the same cube twice."""
    cells: dict[tuple[int, int, int], Color] = {}
    for x, y, z, c in part.voxels:
        cells[(x, y, z)] = c
    part.voxels = [(x, y, z, c) for (x, y, z), c in cells.items()]
    return part


def _build_cotton_coat(breed: Breed, *, blink: bool = False) -> dict[str, Part]:
    """A bichon frisé, drawn from the breed standard.

    The same nine named parts as :func:`build`, so every pose still works, but
    drawn as soft masses: the coat is what makes a bichon, so the outline is
    rounded everywhere a maltese is long and straight. The AKC standard sets
    the shape: a sturdy body a quarter longer than the dog is tall at the
    withers, a chest half that height deep and legs the other half, a long
    neck carrying a round head up and in front of the shoulders, drop ears
    lost in the coat, and a plumed tail curled over the back. The head is
    wider than the body, which is what reads as the powder puff. Only the
    boxes, `leg_top`, `leg_width` and the palette are read; the ear, tail and
    muzzle knobs belong to :func:`build`.
    """
    pal = breed.palette
    bx0, by0, bz0, bx1, by1, bz1 = breed.body
    hx0, hy0, hz0, hx1, hy1, hz1 = breed.head
    zc = (hz0 + hz1) // 2
    parts: dict[str, Part] = {}

    # Body: a level-backed barrel, with the neck rising out of the forechest
    # into the head so head, chest and back read as one dog.
    body = Part("body")
    _rounded_mass(body, breed.body, pal.coat, 2.6)
    _rounded_mass(body, (bx1 - 4, by1 - 2, bz0 + 1, bx1, hy0 + 1, bz1 - 1), pal.coat, 2.4)
    body.paint_where(lambda x, y, z: y == by0, pal.coat_deep)  # belly shadow
    parts["body"] = _dedupe(body)

    # Head: the powder puff. Flat enough in front that the eyes sit on one
    # face and show no dark top or side; rounder behind, where its outline
    # meets the neck and the sky.
    head = Part("head")
    _rounded_mass(head, breed.head, pal.coat, 3.0, back=2.2)
    parts["head"] = head

    # Drop ears hidden in the coat: soft lobes either side of the head, two
    # voxels thick (see build), in the coat's own white. They widen the puff
    # rather than showing as flaps.
    ears = Part("ears")
    for z0 in (hz0 - 1, hz1):
        _rounded_mass(ears, (hx0 + 2, hy0, z0, hx0 + 5, hy1 - 1, z0 + 1), pal.coat, 2.2)
    parts["ears"] = ears

    # Round dark eyes high in the face, and a short muzzle below them: the
    # black nose on top, the tongue at the bottom, white between.
    eye_y = hy1 - 3
    nose_y = eye_y - 2
    face = Part("face")
    face.box(hx1 + 1, nose_y - 2, zc - 1, hx1 + 1, nose_y, zc + 2, pal.muzzle)
    parts["face"] = face

    # Legs of medium length, straight under the withers and the rump.
    width = breed.leg_width - 1
    for name, x0, z0 in (
        ("leg_fl", bx1 - 1 - width, bz0),
        ("leg_fr", bx1 - 1 - width, bz1 - width),
        ("leg_bl", bx0 + 1, bz0),
        ("leg_br", bx0 + 1, bz1 - width),
    ):
        leg = Part(name)
        leg.box(x0, 0, z0, x0 + width, breed.leg_top, z0 + width, pal.coat)
        leg.box(x0, 0, z0, x0 + width, 0, z0 + width, pal.coat_deep)  # paw
        parts[name] = leg

    # The plume: set on level with the back, up off the rump, then curled
    # forward so its hair rests on the back.
    tail = Part("tail")
    curl = [(bx0 - .5, by1 - .5), (bx0 - .5, by1 + 2), (bx0 + .5, by1 + 3.4), (bx0 + 2.5, by1 + 3.6), (bx0 + 4, by1 + 2.4)]
    _plume(tail, curl, zc + .5, 1.3, 1.8, pal.coat)
    parts["tail"] = _dedupe(tail)

    eye_rows = (eye_y,) if blink else (eye_y, eye_y + 1)
    head.paint_front([(y, z) for y in eye_rows for z in (zc - 1, zc + 2)], pal.ink)
    face.paint([(hx1 + 1, nose_y, zc), (hx1 + 1, nose_y, zc + 1)], pal.nose or pal.ink)
    face.paint([(hx1 + 1, nose_y - 2, zc), (hx1 + 1, nose_y - 2, zc + 1)], pal.tongue)
    return parts


# ── The dogs ──────────────────────────────────────────────────────────────────


def _cookie_markings(parts: dict[str, Part], breed: Breed) -> None:
    """Yorkshire: steel-blue coat, tan face, legs and chest."""
    pal = breed.palette
    tan, tan_deep = pal.accent, pal.accent_deep
    assert tan and tan_deep
    hx0, _, _, hx1, _, _ = breed.head
    bx1 = breed.body[3]
    parts["head"].paint_where(lambda x, y, z: x >= hx1 - 2, tan)  # the face
    parts["body"].paint_where(lambda x, y, z: x >= bx1 - 1, tan)  # the chest
    for name in ("leg_fl", "leg_fr", "leg_bl", "leg_br"):
        parts[name].paint_where(lambda x, y, z: y > 0, tan)
        parts[name].paint_where(lambda x, y, z: y == 0, tan_deep)


def _bernese_markings(parts: dict[str, Part], breed: Breed) -> None:
    """Bernese Mountain Dog: black coat, rust points, white blaze/chest/paws."""
    pal = breed.palette
    rust = pal.accent
    assert rust
    _, by0, bz0, bx1, by1, bz1 = breed.body
    _, _, hz0, hx1, hy1, hz1 = breed.head
    zc = (hz0 + hz1) // 2
    parts["body"].paint_where(
        lambda x, y, z: x >= bx1 - 1 and bz0 + 1 <= z <= bz1 - 1,
        pal.muzzle,
    )
    # A narrow blaze between the eyes; cheeks and eyebrows are rust.
    parts["head"].paint_where(
        lambda x, y, z: x >= hx1 - 1 and zc <= z <= zc + 1,
        pal.muzzle,
    )
    parts["head"].paint_where(
        lambda x, y, z: x >= hx1 - 1 and
        (z < zc or z > zc + 1) and hy1 - 4 <= y <= hy1 - 3,
        rust,
    )
    parts["head"].paint_front([(hy1 - 1, hz0 + 1), (hy1 - 1, hz1 - 1)], rust)
    for name in ("leg_fl", "leg_fr", "leg_bl", "leg_br"):
        parts[name].paint_where(lambda x, y, z: 1 <= y <= breed.leg_top - 2, rust)
        parts[name].paint_where(lambda x, y, z: y == 0, pal.muzzle)
    if "tail" in parts:
        parts["tail"].paint_where(lambda x, y, z: y <= by0 + 1, pal.muzzle)


def _bailey_markings(parts: dict[str, Part], breed: Breed) -> None:
    """Saint Bernard: white with a brown saddle, brown head, dark mask and ears."""
    pal = breed.palette
    brown, mask = pal.accent, pal.accent_deep
    assert brown and mask
    bx0, _, _, bx1, by1, _ = breed.body
    hx0, _, hz0, hx1, hy1, hz1 = breed.head
    parts["body"].paint_where(lambda x, y, z: y >= by1 - 2 and x <= bx1 - 3, brown)  # saddle
    parts["head"].paint_where(lambda x, y, z: x < hx1 or y >= hy1 - 3, brown)  # crown and cheeks; the blaze stays white
    parts["head"].paint_where(lambda x, y, z: x == hx1 and hy1 - 3 <= y <= hy1 - 1 and (z <= hz0 + 2 or z >= hz1 - 2), mask)
    if "ears" in parts:
        parts["ears"].paint_where(lambda x, y, z: True, mask)
    if "tail" in parts:
        parts["tail"].paint_where(lambda x, y, z: y < by1 + 2, brown)


GIGI = Breed(
    slug="gigi",
    display_name="Gigi",
    description="Atum's maltese. The master assistant's companion.",
    palette=Palette(
        coat=(245, 243, 238),  # maltese white, very slightly warm
        coat_deep=(226, 221, 211),  # under-body and ear shadow
        muzzle=(252, 251, 248),
    ),
)

# Proportions re-cut 2026-09-13 with the wider knobs (plan
# 2026-09-13-pet-plans-rig-and-activities, W2): each dog's idle silhouette
# overlaps Gigi's by at most 0.85 (tests/agent/test_pets_generator.py).
MOCHI = Breed(
    slug="mochi",
    display_name="Mochi",
    description="A white bichon: round everywhere, and pleased about it.",
    palette=Palette(coat=(250, 250, 250), coat_deep=(226, 226, 230), muzzle=(255, 247, 247)),
    # Short and low, with a head as big as the body and ears like pom-poms.
    body=(1, 3, 1, 10, 8, 8),
    body_bite=2,
    head=(9, 7, 1, 15, 15, 8),
    head_bite=2,
    ears="round",
    ear_size="large",
    muzzle_inset=1,
    leg_top=3,
    tail="plume",
    size=1.1,
)

# House candidates selected by the contact sheet and promoted into BREEDS.
# Bailey is the owner-approved PT-6 still. Mochi was redrawn twice on
# 2026-10-08. The owner called the PT-6 Mochi ugly ("fix Mochi design"), and
# then said of the first redraw, a big round head on four short legs, "Take a
# look at a real bichon. Mochi right now looks like he has no body." This one
# follows the breed standard: a body a quarter longer than the withers are
# high, half of that height in legs, a round head wider than the body carried
# up on a neck in front of the shoulders, and a plume curled over the back.
# The real proportions overlap Gigi and Bailey above the 0.6 guide; that is
# the owner's call (tests/agent/test_pets_generator.py).
APPROVED_MOCHI = Breed(
    slug="mochi",
    display_name="Mochi",
    description="A white bichon: round everywhere, and pleased about it.",
    # All white: the ears are hidden in the coat, so no cream shading shows.
    palette=Palette(coat=(250, 250, 250), coat_deep=(226, 226, 230), muzzle=(255, 255, 253)),
    body=(1, 5, 2, 13, 10, 7),
    head=(9, 10, 1, 15, 17, 8),
    leg_top=5,
    leg_width=2,
    cotton_coat=True,
    size=1.1,
)

COOKIE = Breed(
    slug="cookie",
    display_name="Cookie",
    description="A Yorkshire terrier: small, steel-blue and tan, ears up.",
    palette=Palette(
        coat=(98, 104, 120),
        coat_deep=(72, 76, 90),
        muzzle=(206, 160, 96),
        accent=(196, 146, 84),
        accent_deep=(150, 106, 56),
    ),
    # Slim barrel, small head, short legs, small pricked ears: a toy dog.
    body=(1, 3, 1, 11, 8, 8),
    body_bite=2,
    head=(9, 7, 1, 15, 13, 8),
    ears="upright",
    ear_size="small",
    ear_color=(72, 76, 90),
    leg_top=3,
    tail="stub",
    decorate=_cookie_markings,
    size=0.85,
)

BAILEY = Breed(
    slug="bailey",
    display_name="Bailey",
    description="A Saint Bernard: big, gentle, and mostly asleep.",
    palette=Palette(
        coat=(240, 236, 228),
        coat_deep=(218, 211, 199),
        muzzle=(246, 243, 236),
        accent=(150, 96, 52),
        accent_deep=(60, 42, 34),
    ),
    # Already the most the frame allows in every direction; "big" is the
    # long body, heavy legs, long muzzle, and ears as large as they go.
    body=(1, 5, 1, 12, 11, 8),
    head=(9, 10, 1, 15, 17, 8),
    ears="drop",
    ear_size="large",
    ear_color=(60, 42, 34),
    muzzle_rows=4,
    muzzle_inset=1,
    leg_top=5,
    tail="plume",
    decorate=_bailey_markings,
    size=1.45,
)

APPROVED_BAILEY = Breed(
    slug="bailey",
    display_name="Bailey",
    description="A Bernese Mountain Dog: big, gentle, and mostly asleep.",
    palette=Palette(
        coat=(37, 40, 46),
        coat_deep=(22, 25, 30),
        muzzle=(246, 244, 239),
        ink=(8, 10, 14),
        nose=(10, 12, 15),
        accent=(178, 105, 54),
        accent_deep=(131, 73, 36),
    ),
    # Long black barrel, a raised head, drop ears and sturdy tricolour legs.
    # The proposed 210 pt standing height belongs to PT-5/PT-7 metadata;
    # this stills slice preserves the installed assets and legacy size.
    body=(1, 6, 2, 12, 12, 7),
    head=(10, 10, 2, 15, 16, 7),
    head_bite=2,
    ears="drop",
    ear_size="medium",
    ear_color=(22, 25, 30),
    muzzle_rows=3,
    muzzle_inset=1,
    leg_top=6,
    tail="plume",
    leg_width=4,
    low_tail=True,
    decorate=_bernese_markings,
    size=1.45,
)

# Keep the original hand specifications for Hatch's backwards-compatibility
# oracle. Approved geometry is promoted only in the house generation registry.
LEGACY_BREEDS: dict[str, Breed] = {b.slug: b for b in (GIGI, MOCHI, COOKIE, BAILEY)}
APPROVED_BREEDS: dict[str, Breed] = {
    **LEGACY_BREEDS, "mochi": APPROVED_MOCHI, "bailey": APPROVED_BAILEY,
}
BREEDS: dict[str, Breed] = {
    **LEGACY_BREEDS,
    "mochi": replace(APPROVED_MOCHI, natural_height_pt=100),
    "bailey": replace(APPROVED_BAILEY, size=2.0, natural_height_pt=210, grounded_sit=True),
}
