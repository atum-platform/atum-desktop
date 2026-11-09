"""Promoted house geometry reproduces the owner-approved stills exactly."""

import pytest

pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from scripts.pets.breeds import APPROVED_BREEDS, BREEDS, LEGACY_BREEDS  # noqa: E402
from scripts.pets.contact_sheet import OUT  # noqa: E402
from scripts.pets.sheet import FRAMES_PER_ROW, frame_for, model_for  # noqa: E402

if not OUT.is_dir():
    pytest.skip(
        "owner-approved contact-sheet artifacts are not shipped in this branch",
        allow_module_level=True,
    )


@pytest.mark.parametrize("slug", sorted(APPROVED_BREEDS))
@pytest.mark.parametrize(("label", "row", "index"), [("idle", "idle", 0), ("walk", "running-left", 2)])
def test_candidate_frames_reproduce_owner_approved_stills(slug, label, row, index):
    frame = frame_for(model_for(APPROVED_BREEDS[slug]), row, index, FRAMES_PER_ROW[row])
    with Image.open(OUT / f"{slug}-{label}.png") as approved:
        assert frame.tobytes() == approved.convert("RGBA").tobytes()
    shipped = frame_for(model_for(BREEDS[slug]), row, index, FRAMES_PER_ROW[row])
    assert frame.tobytes() == shipped.tobytes()
    legacy = frame_for(model_for(LEGACY_BREEDS[slug]), row, index, FRAMES_PER_ROW[row])
    assert (frame.tobytes() == legacy.tobytes()) is (slug in {"gigi", "cookie"})
