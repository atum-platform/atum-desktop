"""Approved house atlases: complete pixels, real metadata and reproducibility."""

from dataclasses import replace
import json
from pathlib import Path

import pytest

pytest.importorskip("PIL")
from PIL import Image, ImageChops  # noqa: E402

from agent.pet.constants import FRAME_H, FRAME_W, LOOK_ROW_NAMES, V3_STATE_ROWS  # noqa: E402
from agent.pet.payload import _pet_opaque_geometry  # noqa: E402
from scripts.pets.breeds import BREEDS  # noqa: E402
from scripts.pets.preview import write_preview  # noqa: E402
from scripts.pets.sheet import DEFAULT_OUT, FRAMES_PER_ROW, build_sheet, frame_for, model_for, write_pet  # noqa: E402
from scripts.pets.voxel import assert_unclipped  # noqa: E402

HOUSE = ("mochi", "bailey")


@pytest.mark.parametrize("slug", HOUSE)
def test_committed_atlas_has_every_unclipped_frame_and_matches_the_model(slug):
    with Image.open(DEFAULT_OUT / slug / "spritesheet.webp") as image:
        sheet = image.convert("RGBA")
    assert sheet.tobytes() == build_sheet(BREEDS[slug]).tobytes()
    meta = json.loads((DEFAULT_OUT / slug / "pet.json").read_text())
    rows = [*V3_STATE_ROWS, *LOOK_ROW_NAMES, *meta["extraRows"]]
    for row_index, row in enumerate(rows):
        count = 8 if row == LOOK_ROW_NAMES[0] else 7 if row == LOOK_ROW_NAMES[1] else FRAMES_PER_ROW[row]
        for col in range(8):
            cell = sheet.crop((col * FRAME_W, row_index * FRAME_H, (col + 1) * FRAME_W, (row_index + 1) * FRAME_H))
            assert bool(cell.getchannel("A").getbbox()) == (col < count), (slug, row, col)
            assert_unclipped(cell, f"{slug}/{row}/{col}")
    assert (DEFAULT_OUT / slug / "spritesheet.webp").stat().st_size <= 4 * 1024 * 1024


@pytest.mark.parametrize("slug", HOUSE)
def test_manifest_geometry_is_the_union_of_actual_opaque_pixels(slug):
    root = DEFAULT_OUT / slug
    meta = json.loads((root / "pet.json").read_text())
    anchor, bounds = _pet_opaque_geometry(root / "spritesheet.webp", tuple(meta["extraRows"]))
    assert meta["anchor"] == anchor
    assert meta["bounds"] == bounds
    assert set(bounds) == {*V3_STATE_ROWS, *LOOK_ROW_NAMES, *meta["extraRows"]}
    assert meta["sizeClass"]["naturalHeightPt"] == BREEDS[slug].natural_height_pt
    assert meta["locomotion"] == "walk"
    # Independent alpha-union oracle for the idle row, including its bob.
    with Image.open(root / "spritesheet.webp") as image:
        alpha = image.convert("RGBA").getchannel("A")
    union = Image.new("L", (FRAME_W, FRAME_H))
    for col in range(8):
        union = ImageChops.lighter(union, alpha.crop((col * FRAME_W, 0, (col + 1) * FRAME_W, FRAME_H)))
    left, top, right, bottom = union.getbbox()
    assert bounds["idle"] == {"x": left, "y": top, "width": right - left, "height": bottom - top}


@pytest.mark.parametrize("slug", HOUSE)
@pytest.mark.parametrize("feature", ["ink", "nose"])
def test_eyes_and_nose_are_visible_pixels_not_black_coat_false_positives(slug, feature):
    breed = BREEDS[slug]
    changed = replace(breed, palette=replace(breed.palette, **{feature: (0, 255, 0)}))
    for row, index in [("idle", 0), ("running-left", 2)]:
        original = frame_for(model_for(breed), row, index, FRAMES_PER_ROW[row])
        marked = frame_for(model_for(changed), row, index, FRAMES_PER_ROW[row])
        assert original.getchannel("A").tobytes() == marked.getchannel("A").tobytes()
        differences = sum(a != b for a, b in zip(original.getdata(), marked.getdata()))
        assert differences >= 8, (slug, row, feature, differences)


@pytest.mark.parametrize("slug", HOUSE)
def test_generation_is_byte_deterministic_within_the_same_encoder(slug, tmp_path: Path):
    first = write_pet(BREEDS[slug], tmp_path / "a")
    second = write_pet(BREEDS[slug], tmp_path / "b")
    for name in ("spritesheet.webp", "pet.json"):
        assert (first / name).read_bytes() == (second / name).read_bytes()
    left = write_preview(slug, tmp_path / "a")
    right = write_preview(slug, tmp_path / "b")
    assert left.read_bytes() == right.read_bytes()
