"""v4 optional rows: appended after the look rows, declared in pet.json, invisible
to readers that were not told, and drawn by every plan with a stand-in for
sheets that lack them.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.pet import constants as C
from agent.pet import store


def test_a_tall_sheet_nobody_described_is_still_v3_to_every_reader() -> None:
    assert C.state_rows_for_grid(14) == C.V3_STATE_ROWS
    assert C.state_rows_for_grid(12) == C.V3_STATE_ROWS
    assert C.look_row_start(14) == len(C.V3_STATE_ROWS) == 10
    # A v3 sheet asked to sleep lounges; a Codex sheet asked to sleep lounges, then sits.
    assert C.state_row_index("sleep", 12) == C.V3_STATE_ROWS.index("lounging")
    assert C.state_row_index("sleep", 9) == C.CODEX_STATE_ROWS.index("waiting")
    assert C.state_row_index("carried", 12) == 0


def test_declared_extras_name_the_rows_past_the_look_rows_and_nothing_moves() -> None:
    rows = C.state_rows_for_grid(14, ("sleep", "carried"))
    assert rows[:10] == C.V3_STATE_ROWS and rows[10:12] == list(C.LOOK_ROW_NAMES)
    assert rows[12] == "sleep" and rows[13] == "carried"
    assert C.state_row_index("sleep", 14, ("sleep", "carried")) == 12
    assert C.state_row_index("carried", 14, ("sleep", "carried")) == 13
    assert C.state_row_present("sleep", 14, ("sleep", "carried"))
    assert C.look_row_start(14) == 10, "the look rows do not move"
    # Only the rows that fit are named: a 13-row sheet declaring two has one.
    assert C.state_rows_for_grid(13, ("sleep", "carried"))[-1] == "sleep"
    assert C.state_row_index("carried", 13, ("sleep", "carried")) == 0, "the second extra is not there: its stand-in"


def test_parse_extra_rows_keeps_known_names_in_order_once() -> None:
    assert C.parse_extra_rows(["carried", "sleep", "carried", "dance", 3]) == ("carried", "sleep")
    assert C.parse_extra_rows("sleep") == () and C.parse_extra_rows(None) == ()


def test_the_store_reads_extra_rows_from_pet_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    store.pets_dir().mkdir(parents=True, exist_ok=True)
    for slug, meta in (("v4", {"displayName": "V4", "extraRows": ["sleep", "carried"]}), ("v3", {"displayName": "V3"})):
        d = store.pets_dir() / slug
        d.mkdir()
        (d / "spritesheet.webp").write_bytes(b"x")
        (d / "pet.json").write_text(json.dumps(meta), encoding="utf-8")
    assert store.load_pet("v4").extra_rows == ("sleep", "carried")
    assert store.load_pet("v3").extra_rows == ()
    assert store._pet_in("v4", store.pets_dir() / "v4").extra_rows == ("sleep", "carried")


pytest.importorskip("PIL")

from PIL import Image  # noqa: E402

from agent.pet import render  # noqa: E402
from scripts.pets import spec as S  # noqa: E402
from scripts.pets.breeds import BREEDS, GIGI  # noqa: E402
from scripts.pets.plans import kinds, optional_rows, plans  # noqa: E402
from scripts.pets.sheet import DEFAULT_OUT, FRAMES_PER_ROW, build_sheet, frame_for, model_for, pet_json, rows_for  # noqa: E402

PALETTE = dict(coat=(128, 206, 168), coat_deep=(96, 176, 138), muzzle_color=(96, 168, 84), accent=(160, 224, 192), accent_deep=(72, 132, 64))


def test_every_plan_draws_both_optional_rows_in_canonical_order() -> None:
    for plan in plans().values():
        assert optional_rows(plan) == ("sleep", "carried")
    assert rows_for() == 14


def test_the_first_party_atlas_is_v4_and_pet_json_declares_it() -> None:
    sheet = build_sheet(GIGI)
    assert sheet.size == (1536, 14 * 208)
    meta = json.loads(pet_json(GIGI))
    assert meta["extraRows"] == ["sleep", "carried"]
    # The rows are where the declaration says, with the frames the builder promised.
    sleep = sheet.crop((0, 12 * 208, 1536, 13 * 208))
    carried = sheet.crop((0, 13 * 208, 1536, 14 * 208))
    assert sleep.getbbox() and carried.getbbox()
    blank_after = carried.crop((FRAMES_PER_ROW["carried"] * 192, 0, 1536, 208)).getbbox()
    assert blank_after is None, "the carried row has exactly its frames"


@pytest.mark.parametrize("slug", sorted(BREEDS))
def test_the_shipped_pet_json_and_sheets_carry_the_rows(slug: str) -> None:
    meta = json.loads((DEFAULT_OUT / slug / "pet.json").read_text(encoding="utf-8"))
    assert meta["extraRows"] == ["sleep", "carried"]
    with Image.open(DEFAULT_OUT / slug / "spritesheet.webp") as shipped:
        assert shipped.size == (1536, 14 * 208)


def test_frame_counts_include_native_optional_states(tmp_path: Path) -> None:
    path = tmp_path / "gigi.webp"
    build_sheet(GIGI).save(path, "WEBP", lossless=True)
    counts = render.state_frame_counts(path, extra_rows=("sleep", "carried"))
    assert counts["sleep"] == FRAMES_PER_ROW["sleep"]
    assert counts["carried"] == FRAMES_PER_ROW["carried"]


@pytest.mark.parametrize("kind", sorted(kinds()))
def test_every_kind_sleeps_lower_than_it_lounges_and_carried_is_a_pose(kind: str) -> None:
    spec = S.PetSpec(name=kind, plan=kind, **PALETTE)
    plan, geometry = S._geometry(spec, kind)
    model = model_for(geometry, plan=plan)
    lounge = frame_for(model, "lounging", 0, FRAMES_PER_ROW["lounging"])
    sleep = frame_for(model, "sleep", 0, FRAMES_PER_ROW["sleep"])
    carried = frame_for(model, "carried", 0, FRAMES_PER_ROW["carried"])
    idle = frame_for(model, "idle", 0, FRAMES_PER_ROW["idle"])
    assert sleep.tobytes() != lounge.tobytes() and carried.tobytes() != idle.tobytes()
    # Asleep, the eyes are shut: never more ink showing than awake (a flat cloud
    # or an egg hides part of its face either way, so "no more", not "less").
    dark = lambda img: sum(1 for r, g, b, a in img.getdata() if a == 255 and max(r, g, b) < 60)  # noqa: E731
    assert dark(sleep) <= dark(idle), f"{kind}: asleep should not show more eye than awake"
