"""Voxel primitives and the isometric rasteriser shared by every first-party pet.

A pet is a handful of named :class:`Part`s (body, head, ears, face, four legs,
tail) built from voxel boxes, posed per frame by :class:`Pose`, and drawn with a
painter's-algorithm 2:1 dimetric projection. The output is deterministic — same
input, same bytes — so every shipped asset is reproducible from source.

Nothing in this module knows a breed. Palettes, proportions and markings live
in :mod:`scripts.pets.breeds`; the animations in :mod:`scripts.pets.poses`; the
atlas layout in :mod:`scripts.pets.sheet`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from PIL import Image, ImageDraw

# ── Voxel projection ──────────────────────────────────────────────────────────
#
# Classic 2:1 dimetric. Camera sits at (+x, +y, +z) looking at the origin, so
#     screen_x = (x - z) * HW
#     screen_y = (x + z) * HH - y * VH
# and view depth is proportional to (x + y + z): larger is nearer, so painting
# in ascending depth order gives correct occlusion with no z-buffer.
#
# Voxels are deliberately chunky. The sprite is displayed at 0.33-0.6 scale with
# canvas smoothing disabled, so fine detail would alias into mush; big blocks
# survive the downscale, which is what gives the reference pets their look.

HW = 6  # half-width of a voxel's top face
HH = 3  # quarter-height of the top face (HW / 2)
VH = 5  # vertical rise of one voxel
#
# The model must stay inside the frame at these constants. With spans of
# (17, 18, 10) in (x, y, z) the sprite projects to
#     width  = (17 + 10) * HW = 162  <= 192
#     height = (17 + 10) * HH + 18 * VH = 171  <= 208
# The 37px of vertical slack is not waste: poses lift off a *fixed* anchor
# (see `compute_anchor`), so the jump needs real headroom above the resting
# silhouette. Grow a model past this and frames clip. `check_fit` asserts the
# spans and the sheet builder asserts no frame touches a border.
MAX_SPAN = (17, 18, 10)
# Resting distance from the frame's bottom edge to the paws.
BASELINE_PAD = 14

# Face shading multipliers: top is lit, +x side mid, +z side darkest.
SHADE_TOP = 1.00
SHADE_RIGHT = 0.82
SHADE_LEFT = 0.64

Color = tuple[int, int, int]
Voxel = tuple[int, int, int, Color]

# Deterministic per-voxel coat jitter, so fur reads as texture rather than a
# flat solid. Hash-based, never random — the build must be reproducible.
JITTER = 7


def jitter(base: Color, x: int, y: int, z: int) -> Color:
    h = (x * 73_856_093) ^ (y * 19_349_663) ^ (z * 83_492_791)
    d = ((h >> 5) % (2 * JITTER + 1)) - JITTER
    return (
        max(0, min(255, base[0] + d)),
        max(0, min(255, base[1] + d)),
        max(0, min(255, base[2] + d)),
    )


def shade(c: Color, k: float) -> Color:
    return (int(c[0] * k), int(c[1] * k), int(c[2] * k))


# ── Model ─────────────────────────────────────────────────────────────────────


@dataclass
class Part:
    """A named, independently posable clump of voxels."""

    name: str
    voxels: list[Voxel] = field(default_factory=list)

    def box(self, x0: int, y0: int, z0: int, x1: int, y1: int, z1: int, color: Color) -> "Part":
        """Fill an inclusive voxel box."""
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                for z in range(z0, z1 + 1):
                    self.voxels.append((x, y, z, color))
        return self

    def rounded(
        self, x0: int, y0: int, z0: int, x1: int, y1: int, z1: int, color: Color, bite: int = 1
    ) -> "Part":
        """A box with its eight corners bitten off — reads as a soft, furry mass."""
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                for z in range(z0, z1 + 1):
                    ex = min(x - x0, x1 - x) < bite
                    ey = min(y - y0, y1 - y) < bite
                    ez = min(z - z0, z1 - z) < bite
                    if ex and ey and ez:
                        continue
                    self.voxels.append((x, y, z, color))
        return self

    def ellipsoid(
        self, cx: float, cy: float, cz: float, rx: float, ry: float, rz: float, color: Color, *, y_min: int | None = None
    ) -> "Part":
        """Voxels inside an ellipsoid — a round body, an egg, a head.

        *y_min* slices it flat: a slime is a dome sitting on the floor, not a
        ball. Every non-dog plan wants this (W0 spike, 2026-09-13).
        """
        for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
            for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
                if y_min is not None and y < y_min:
                    continue
                for z in range(int(cz - rz) - 1, int(cz + rz) + 2):
                    if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1.0:
                        self.voxels.append((x, y, z, color))
        return self

    def front_of(self, y: int, z: int) -> int | None:
        """The +x surface at (y, z): where a face feature paints on a curved part."""
        xs = [vx for vx, vy, vz, _ in self.voxels if vy == y and vz == z]
        return max(xs) if xs else None

    def paint_front(self, cells: list[tuple[int, int]], color: Color) -> "Part":
        """Recolour the outermost +x voxel at each (y, z) — eyes and mouths on
        a round face, which has no single front column to paint."""
        coords = []
        for y, z in cells:
            x = self.front_of(y, z)
            if x is not None:
                coords.append((x, y, z))
        return self.paint(coords, color)

    def paint(self, coords: list[tuple[int, int, int]], color: Color) -> "Part":
        """Recolour existing voxels in place.

        Face features and markings are painted onto a part's surface rather
        than stacked in front of it: an added voxel would stick out a full cube
        and read as a growth at this resolution, where a recoloured one reads
        as a marking.
        """
        wanted = set(coords)
        for idx, (x, y, z, _) in enumerate(self.voxels):
            if (x, y, z) in wanted:
                self.voxels[idx] = (x, y, z, color)
        return self

    def paint_where(self, predicate, color: Color) -> "Part":
        """Recolour every voxel for which ``predicate(x, y, z)`` holds — a patch."""
        for idx, (x, y, z, _) in enumerate(self.voxels):
            if predicate(x, y, z):
                self.voxels[idx] = (x, y, z, color)
        return self


def spans(parts: dict[str, Part]) -> tuple[int, int, int]:
    vox = [v for p in parts.values() for v in p.voxels]
    return tuple(max(v[i] for v in vox) - min(v[i] for v in vox) + 1 for i in range(3))  # type: ignore[return-value]


def check_fit(parts: dict[str, Part], who: str) -> tuple[int, int, int]:
    """Assert the neutral model fits the frame; returns its (x, y, z) spans."""
    got = spans(parts)
    for span, cap, axis in zip(got, MAX_SPAN, "xyz"):
        if span > cap:
            raise SystemExit(f"{who}: model {axis} span {span} exceeds {cap}; it would clip the frame")
    return got


# ── Posing ────────────────────────────────────────────────────────────────────


def translate(vox: list[Voxel], dx: float, dy: float, dz: float) -> list[Voxel]:
    return [(x + round(dx), y + round(dy), z + round(dz), c) for x, y, z, c in vox]


def _resample(vox: list[Voxel], inverse) -> list[Voxel]:
    """Rotate by INVERSE mapping: walk the destination grid, sample the source.

    Forward-mapping a voxel grid (move each source voxel to its rotated position)
    tears holes in the result: at 45 degrees several source voxels round onto the
    same destination cell while their neighbours round past each other, and the
    model comes out looking combed. Walking the destination instead asks "what
    was here before the rotation?", which by construction fills every cell.
    """
    src = {(x, y, z): c for x, y, z, c in vox}
    if not src:
        return vox

    xs = [v[0] for v in vox]
    ys = [v[1] for v in vox]
    zs = [v[2] for v in vox]
    # Pad by two so a rotated corner can never fall outside the search box.
    pad = 2
    out: list[Voxel] = []

    for x in range(min(xs) - pad, max(xs) + pad + 1):
        for y in range(min(ys) - pad, max(ys) + pad + 1):
            for z in range(min(zs) - pad, max(zs) + pad + 1):
                colour = src.get(inverse(x, y, z))
                if colour is not None:
                    out.append((x, y, z, colour))

    return out


def rotate_z(vox: list[Voxel], pivot: tuple[float, float], deg: float) -> list[Voxel]:
    """Rotate about the z axis — a head tilt, or a leg swing in the facing plane."""
    if abs(deg) < 0.01:
        return vox
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)
    px, py = pivot

    def inverse(x: int, y: int, z: int) -> tuple[int, int, int]:
        dx, dy = x - px, y - py
        return (round(px + dx * ca + dy * sa), round(py - dx * sa + dy * ca), z)

    return _resample(vox, inverse)


def rotate_y(vox: list[Voxel], pivot: tuple[float, float], deg: float) -> list[Voxel]:
    """Rotate about the vertical axis — a head turning to look somewhere.

    The eyes and nose are painted *into* the head's voxels, so they turn with it
    for free; nothing has to track the features separately.
    """
    if abs(deg) < 0.01:
        return vox
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)
    px, pz = pivot

    def inverse(x: int, y: int, z: int) -> tuple[int, int, int]:
        dx, dz = x - px, z - pz
        return (round(px + dx * ca + dz * sa), y, round(pz - dx * sa + dz * ca))

    return _resample(vox, inverse)


@dataclass
class Pose:
    """Per-part offsets for one frame. Absent parts render at rest."""

    offsets: dict[str, tuple[float, float, float]] = field(default_factory=dict)
    rotations: dict[str, tuple[tuple[float, float], float]] = field(default_factory=dict)
    # Rotations about the vertical axis — a head turning to look somewhere.
    turns: dict[str, tuple[tuple[float, float], float]] = field(default_factory=dict)
    hidden: set[str] = field(default_factory=set)
    lift: float = 0.0  # whole-body vertical offset (bob, hop)
    blink: bool = False


def posed(parts: dict[str, Part], pose: Pose) -> list[Voxel]:
    out: list[Voxel] = []
    for name, part in parts.items():
        if name in pose.hidden:
            continue
        vox = part.voxels
        if name in pose.turns:
            pivot, deg = pose.turns[name]
            vox = rotate_y(vox, pivot, deg)
        if name in pose.rotations:
            pivot, deg = pose.rotations[name]
            vox = rotate_z(vox, pivot, deg)
        dx, dy, dz = pose.offsets.get(name, (0.0, 0.0, 0.0))
        vox = translate(vox, dx, dy + pose.lift, dz)
        out.extend(vox)
    return out


# ── Rasteriser ────────────────────────────────────────────────────────────────


def project(x: float, y: float, z: float) -> tuple[float, float]:
    return ((x - z) * HW, (x + z) * HH - y * VH)


def _bounds(vox: list[Voxel]) -> tuple[float, float, float, float]:
    pts = [project(x, y, z) for x, y, z, _ in vox]
    return (
        min(p[0] for p in pts) - HW,
        max(p[0] for p in pts) + HW,
        min(p[1] for p in pts),
        max(p[1] for p in pts) + VH + 2 * HH,
    )


def compute_anchor(rest: list[Voxel], size: tuple[int, int]) -> tuple[float, float]:
    """The screen offset every frame of a model is drawn at, from its rest pose.

    Framing must NOT follow each frame's own bounds. Doing so re-centres the
    sprite every frame, which silently cancels `Pose.lift` (raise the model and
    the recentre lowers it right back) and slides it sideways as the legs swing
    — a visible jitter at 5Hz. One fixed anchor per model makes the poses mean
    what they say and keeps the paws on a stable baseline.
    """
    min_x, max_x, _, max_y = _bounds(rest)
    return ((size[0] - (max_x - min_x)) / 2 - min_x, size[1] - BASELINE_PAD - max_y)


def render(
    vox: list[Voxel],
    *,
    anchor: tuple[float, float],
    fur: frozenset[Color],
    size: tuple[int, int],
) -> Image.Image:
    """Draw voxels into a transparent frame at the fixed anchor.

    *fur* is the set of base colours that get the per-voxel jitter: coat and
    muzzle read as fur, eyes and a nose do not.
    """
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    if not vox:
        return img
    draw = ImageDraw.Draw(img)
    off_x, off_y = anchor

    # Painter's algorithm: ascending view depth, nearer voxels painted last.
    for x, y, z, base in sorted(vox, key=lambda v: v[0] + v[1] + v[2]):
        color = jitter(base, x, y, z) if base in fur else base
        sx, sy = project(x, y, z)
        sx += off_x
        sy += off_y

        top = [(sx, sy), (sx + HW, sy + HH), (sx, sy + 2 * HH), (sx - HW, sy + HH)]
        right = [
            (sx, sy + 2 * HH),
            (sx + HW, sy + HH),
            (sx + HW, sy + HH + VH),
            (sx, sy + 2 * HH + VH),
        ]
        left = [
            (sx - HW, sy + HH),
            (sx, sy + 2 * HH),
            (sx, sy + 2 * HH + VH),
            (sx - HW, sy + HH + VH),
        ]
        draw.polygon(top, fill=shade(color, SHADE_TOP))
        draw.polygon(right, fill=shade(color, SHADE_RIGHT))
        draw.polygon(left, fill=shade(color, SHADE_LEFT))

    return img


def assert_unclipped(img: Image.Image, where: str) -> None:
    """A pose that runs off the cell would be silently cropped — catch it here."""
    a = img.getchannel("A")
    w, h = img.size
    edges = (
        [a.getpixel((x, 0)) for x in range(w)]
        + [a.getpixel((x, h - 1)) for x in range(w)]
        + [a.getpixel((0, y)) for y in range(h)]
        + [a.getpixel((w - 1, y)) for y in range(h)]
    )
    if any(edges):
        raise SystemExit(f"{where}: sprite touches the cell border — it is being clipped")
