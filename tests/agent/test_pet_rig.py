"""The rig is derived from the body, and the derivation is right because
Gigi — whose numbers the animations used to hard-code — comes out
byte-identical to the asset that ships.
"""

from __future__ import annotations

import pytest

pytest.importorskip("PIL")

from PIL import Image  # noqa: E402

from scripts.pets.breeds import BAILEY, BREEDS, COOKIE, GIGI  # noqa: E402
from scripts.pets.rig import rig_for  # noqa: E402
from scripts.pets.sheet import DEFAULT_OUT, FRAMES_PER_ROW, build_sheet, frame_for, model_for  # noqa: E402


def test_gigis_rig_is_the_constants_the_poses_used_to_carry() -> None:
    rig = rig_for(GIGI)
    assert rig.turn_pivot == (12.0, 4.5)
    assert rig.tilt_pivot == (12.0, 12.0)
    assert rig.pitch_pivot == (11.0, 11.0)
    assert rig.leg_height == 4
    assert (rig.lounge_body_drop, rig.lounge_head_drop, rig.sit_drop, rig.paw_raise, rig.stride) == (3.0, 5.0, 2.0, 4.5, 2.4)


def test_gigis_sheet_is_byte_identical_to_the_shipped_asset() -> None:
    # The whole atlas — ten rows and the look grid — through the derived rig.
    shipped = Image.open(DEFAULT_OUT / "gigi" / "spritesheet.webp").convert("RGBA")
    assert build_sheet(GIGI).tobytes() == shipped.tobytes()


def test_the_rig_follows_the_body() -> None:
    gigi, bailey, cookie = rig_for(GIGI), rig_for(BAILEY), rig_for(COOKIE)
    # The neck is two rows above the barrel: Bailey's barrel sits higher than
    # Gigi's, Cookie's lower, and their necks follow.
    assert bailey.tilt_pivot[1] == bailey.body_top + 2 > gigi.tilt_pivot[1]
    assert cookie.tilt_pivot[1] == cookie.body_top + 2 < gigi.tilt_pivot[1]
    # Longer legs come further down to lounge and take longer strides.
    assert bailey.lounge_body_drop > gigi.lounge_body_drop > cookie.lounge_body_drop
    assert bailey.stride > cookie.stride


@pytest.mark.parametrize("slug", sorted(BREEDS))
def test_every_breed_lounges_lower_than_it_sits(slug: str) -> None:
    model = model_for(BREEDS[slug])
    lounge = frame_for(model, "lounging", 0, FRAMES_PER_ROW["lounging"]).getchannel("A").getbbox()
    sit = frame_for(model, "waiting", 0, FRAMES_PER_ROW["waiting"]).getchannel("A").getbbox()
    assert lounge and sit
    assert lounge[1] > sit[1], f"{slug}: a lounging head is lower than a sitting one"
    # And the belly rests just above the floor — the drop is the leg, not a constant.
    rig = model.rig
    assert rig.body_bottom - rig.lounge_body_drop == 1
