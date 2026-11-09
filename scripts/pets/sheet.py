"""Compose a breed's frames into the v3 atlas and write the pet directory.

Output is the Codex/petdex atlas extended twice: 8 columns of 192×208 cells,
the nine Codex animation rows, then our ``lounging`` row (v3, see
``agent.pet.constants.V3_STATE_ROWS``), then two rows of look directions.
That is 12 rows — 1536×2496 — with unused cells fully transparent. Sheets
tell their version by height, so nothing else has to be told.

    python -m scripts.pets            # every breed, into apps/desktop/assets/pets
    python -m scripts.pets cookie     # one breed
    python -m scripts.pets all OUTDIR

Deterministic: same source, same bytes.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image

from agent.pet.constants import FRAME_H, FRAME_W, V3_STATE_ROWS
from scripts.pets.breeds import BREEDS, Breed
from scripts.pets.plans import Plan, optional_rows
from scripts.pets.poses import LOOK_ORIGIN, PITCH_STEPS, YAW_STEPS
from scripts.pets.rig import Rig
from scripts.pets.voxel import Color, assert_unclipped, check_fit, compute_anchor, posed, render

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_OUT = REPO_ROOT / "apps" / "desktop" / "assets" / "pets"

COLS = 8
LOOK_ROWS = 2
ROWS = len(V3_STATE_ROWS) + LOOK_ROWS  # 12
SIZE = (FRAME_W, FRAME_H)

FRAMES_PER_ROW: dict[str, int] = {
    "idle": 6,
    "running-right": 8,
    "running-left": 8,
    "waving": 4,
    "jumping": 5,
    "failed": 8,
    "waiting": 6,
    "running": 6,
    "review": 6,
    "lounging": 6,
    # v4 optional rows (appended after the look rows, declared in pet.json).
    "sleep": 6,
    "carried": 4,
}


def _default_plan() -> Plan:
    from scripts.pets.plans.quadruped import QUADRUPED

    return QUADRUPED


@dataclass(frozen=True)
class Model:
    """A plan's geometry plus what the rasteriser needs to draw it consistently."""

    plan: Plan
    geometry: Any  # the plan's own shape — a Breed for the quadruped
    anchor: tuple[float, float]
    fur: frozenset[Color]
    rig: Rig

    @property
    def breed(self) -> Any:
        """The geometry, under the name every quadruped caller knows."""
        return self.geometry


def model_for(geometry: Any, *, plan: Plan | None = None) -> Model:
    """Fit-check the geometry and fix its anchor from the rest pose, once.

    *plan* defaults to the quadruped, so a bare :class:`Breed` still works.
    """
    plan = plan or _default_plan()
    rest = plan.build(geometry)
    check_fit(rest, getattr(geometry, "display_name", plan.name))
    return Model(
        plan=plan,
        geometry=geometry,
        anchor=compute_anchor([v for p in rest.values() for v in p.voxels], SIZE),
        fur=plan.fur(geometry),
        rig=plan.rig(geometry),
    )


def frame_for(model: Model, row: str, i: int, n: int) -> Image.Image:
    pose = model.plan.pose(row, i, n, model.rig)
    if row == "waiting" and getattr(model.geometry, "grounded_sit", False):
        # The tall house dog lowers her body to sit while her paws keep their
        # ground plane. Moving the entire long-legged dog down clips the paws.
        for leg in ("leg_fl", "leg_fr", "leg_bl", "leg_br"):
            x, y, z = pose.offsets.get(leg, (0, 0, 0))
            pose.offsets[leg] = (x, y + model.rig.sit_drop, z)
    # Blink is a model change (the eye voxels recolour), not a transform.
    img = render(posed(model.plan.build(model.geometry, blink=pose.blink), pose), anchor=model.anchor, fur=model.fur, size=SIZE)

    # Petdex sheets face LEFT by default, and the desktop depends on it twice:
    # `facing()` mirrors the sprite when the pet sits on the left half so it
    # always looks *inward* at the content, and `roamWalkRow` mirrors the
    # in-place run row for rightward travel. A right-facing sheet inverts both —
    # the pet ends up staring off the nearest edge in either half.
    #
    # The model is posed facing +x (screen-right) because that is the natural way
    # to read this isometric view while building it, so every row is flipped to
    # the convention on the way out. `running-right` is the one row that must
    # genuinely face right, so it alone is left alone.
    if row != "running-right":
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    return img


def look_frame(model: Model, cell: int) -> Image.Image:
    yaw = cell % YAW_STEPS
    pitch = cell // YAW_STEPS
    img = render(posed(model.plan.build(model.geometry), model.plan.look(yaw, pitch, model.rig)), anchor=model.anchor, fur=model.fur, size=SIZE)
    # Look cells follow the same left-facing convention as every other row.
    return img.transpose(Image.FLIP_LEFT_RIGHT)


def rows_for(plan: Plan | None = None) -> int:
    """Atlas rows for *plan*: the v3 twelve plus its optional rows (v4)."""
    return ROWS + len(optional_rows(plan or _default_plan()))


def build_sheet(geometry: Any, *, plan: Plan | None = None) -> Image.Image:
    model = model_for(geometry, plan=plan)
    who = getattr(geometry, "slug", model.plan.name)
    extras = optional_rows(model.plan)
    sheet = Image.new("RGBA", (COLS * FRAME_W, (ROWS + len(extras)) * FRAME_H), (0, 0, 0, 0))

    for r, row in enumerate(V3_STATE_ROWS):
        n = FRAMES_PER_ROW[row]
        for i in range(n):
            frame = frame_for(model, row, i, n)
            assert_unclipped(frame, f"{who}: {row}[{i}]")
            sheet.paste(frame, (i * FRAME_W, r * FRAME_H))

    # Look rows: the yaw x pitch grid across the two rows after the animations.
    base = len(V3_STATE_ROWS)
    for cell in range(YAW_STEPS * PITCH_STEPS):
        frame = look_frame(model, cell)
        assert_unclipped(frame, f"{who}: look[yaw={cell % YAW_STEPS},pitch={cell // YAW_STEPS}]")
        sheet.paste(frame, ((cell % COLS) * FRAME_W, (base + cell // COLS) * FRAME_H))

    # v4: the plan's optional rows after the look rows, in canonical order —
    # the same order pet.json declares them in (`extraRows`).
    for r, row in enumerate(extras, start=base + LOOK_ROWS):
        n = FRAMES_PER_ROW[row]
        for i in range(n):
            frame = frame_for(model, row, i, n)
            assert_unclipped(frame, f"{who}: {row}[{i}]")
            sheet.paste(frame, (i * FRAME_W, r * FRAME_H))

    return sheet


def pet_json(breed: Breed, *, anchor: dict | None = None, bounds: dict | None = None) -> str:
    extras = ", ".join(f'"{row}"' for row in optional_rows(_default_plan()))
    metadata = ""
    if breed.natural_height_pt is not None:
        fields = {"sizeClass": {"naturalHeightPt": breed.natural_height_pt}, "locomotion": "walk"}
        if anchor is not None and bounds:
            fields.update(anchor=anchor, bounds=bounds)
        metadata = ",\n" + ",\n".join(f'  "{key}": {json.dumps(value)}' for key, value in fields.items())
    return (
        "{\n"
        f'  "id": "{breed.slug}",\n'
        f'  "displayName": "{breed.display_name}",\n'
        f'  "description": "{breed.description}",\n'
        '  "spritesheetPath": "spritesheet.webp",\n'
        '  "spriteVersionNumber": 3,\n'
        f'  "size": {breed.size:g},\n'
        f'  "extraRows": [{extras}],\n'
        f'  "lookOrigin": "{LOOK_ORIGIN}",\n'
        f'  "lookYawSteps": {YAW_STEPS},\n'
        f'  "lookPitchSteps": {PITCH_STEPS}{metadata}\n'
        "}\n"
    )


def write_pet(breed: Breed, out_root: Path) -> Path:
    out = out_root / breed.slug
    out.mkdir(parents=True, exist_ok=True)
    sheet = build_sheet(breed)
    assert sheet.size == (COLS * FRAME_W, rows_for() * FRAME_H), sheet.size
    sheet.save(out / "spritesheet.webp", "WEBP", lossless=True, quality=100, method=6)
    anchor, bounds = None, None
    if breed.natural_height_pt is not None:
        from agent.pet.payload import _pet_opaque_geometry

        anchor, bounds = _pet_opaque_geometry(out / "spritesheet.webp", optional_rows(_default_plan()))
        if anchor is None or len(bounds) != rows_for():
            raise ValueError(f"{breed.slug}: generated atlas has incomplete opaque geometry")
    (out / "pet.json").write_text(pet_json(breed, anchor=anchor, bounds=bounds), encoding="utf-8")
    kb = (out / "spritesheet.webp").stat().st_size / 1024
    print(f"{breed.slug}: spans {check_fit(_default_plan().build(breed), breed.display_name)}; wrote {out}/spritesheet.webp {sheet.size[0]}x{sheet.size[1]} {kb:.0f} KiB")
    return out


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    which = args[0] if args else "all"
    out_root = Path(args[1]) if len(args) > 1 else DEFAULT_OUT
    slugs = list(BREEDS) if which == "all" else [which]
    unknown = [s for s in slugs if s not in BREEDS]
    if unknown:
        print(f"unknown breed(s): {', '.join(unknown)}; known: {', '.join(BREEDS)}", file=sys.stderr)
        return 2
    for slug in slugs:
        write_pet(BREEDS[slug], out_root)
    return 0
