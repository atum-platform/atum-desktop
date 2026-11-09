"""Store previews show the same dog that ships: each committed portrait is the
shipped atlas's first idle cell, trimmed and enlarged, with nothing redrawn.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("PIL")

from PIL import Image  # noqa: E402

from scripts.pets.breeds import BREEDS  # noqa: E402
from scripts.pets.preview import DEFAULT_OUT, portrait, write_preview  # noqa: E402
from scripts.pets.sheet import REPO_ROOT, SIZE  # noqa: E402

SHIPPED_SHEETS = REPO_ROOT / "apps" / "desktop" / "assets" / "pets"


def _shipped_idle_cell(slug: str) -> Image.Image:
    with Image.open(SHIPPED_SHEETS / slug / "spritesheet.webp") as sheet:
        return sheet.convert("RGBA").crop((0, 0, *SIZE))


@pytest.mark.parametrize("slug", sorted(BREEDS))
def test_committed_preview_is_the_shipped_idle_pose(slug: str) -> None:
    with Image.open(DEFAULT_OUT / f"{slug}-preview.webp") as committed:
        got = committed.convert("RGBA")
    want = portrait(_shipped_idle_cell(slug))
    assert got.size == want.size
    assert got.tobytes() == want.tobytes()


def _pixels(path: Path) -> tuple[tuple[int, int], bytes]:
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        return rgba.size, rgba.tobytes()


def test_previews_are_reproducible_from_the_voxel_models(tmp_path: Path) -> None:
    # Decoded pixels, not file bytes: a different libwebp may encode the same
    # lossless picture differently.
    for slug in sorted(BREEDS):
        assert _pixels(write_preview(slug, tmp_path)) == _pixels(DEFAULT_OUT / f"{slug}-preview.webp")


def test_portrait_keeps_voxel_edges_sharp() -> None:
    cell = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    cell.putpixel((50, 60), (200, 100, 50, 255))
    out = portrait(cell)
    colours = {px for px in out.getdata() if px[3]}
    assert colours == {(200, 100, 50, 255)}


def test_an_empty_frame_is_refused() -> None:
    with pytest.raises(ValueError):
        portrait(Image.new("RGBA", SIZE, (0, 0, 0, 0)))
