"""A PetSpec is what a model writes; the renderer guarantees the rest.

Every combination of knobs fits the frame; the shipped dogs are expressible
and render byte-identical; a bad spec is refused with a message the model
can act on.
"""

from __future__ import annotations

import itertools
import json

import pytest

pytest.importorskip("PIL")

from scripts.pets import spec as S  # noqa: E402
from scripts.pets.breeds import BAILEY, COOKIE, GIGI, MOCHI, build  # noqa: E402
from scripts.pets.sheet import build_sheet  # noqa: E402
from scripts.pets.voxel import MAX_SPAN, check_fit  # noqa: E402


def _parts_equal(a, b) -> bool:
    return {k: sorted(p.voxels) for k, p in a.items()} == {k: sorted(p.voxels) for k, p in b.items()}


@pytest.mark.parametrize(("hand", "spec"), [(GIGI, S.GIGI_SPEC), (MOCHI, S.MOCHI_SPEC), (COOKIE, S.COOKIE_SPEC), (BAILEY, S.BAILEY_SPEC)])
def test_the_legacy_hand_dogs_remain_expressible_as_specs(hand, spec: S.PetSpec) -> None:
    from_spec = S.breed_from_spec(spec, slug=hand.slug)

    assert (from_spec.body, from_spec.head, from_spec.leg_top) == (hand.body, hand.head, hand.leg_top)
    assert _parts_equal(build(from_spec), build(hand)), f"{hand.slug}: the spec draws a different dog"
    # The whole sheet, not just the idle pose: markings must survive every row.
    assert build_sheet(from_spec).tobytes() == build_sheet(hand).tobytes()


def test_every_combination_of_knobs_fits_the_frame_and_has_all_its_parts() -> None:
    # Every knob that moves the silhouette's height or width, in full; the
    # widest length and the longest muzzle are held so width is at its worst.
    combos = itertools.product(S.DEPTHS, S.HEADS, S.LEGS, S.EARS, S.EAR_SIZES, S.TAILS)
    worst = (0, 0, 0)
    for depth, head, legs, ears, ear_size, tail in combos:
        spec = S.PetSpec(name="x", body_length="long", body_depth=depth, head=head, legs=legs, ears=ears, ear_size=ear_size, tail=tail, muzzle="long")
        spans = S.fits(spec)  # raises on a clip
        worst = tuple(max(a, b) for a, b in zip(worst, spans))
        parts = build(S.breed_from_spec(spec, slug="x"))
        assert all(part.voxels for part in parts.values()), f"an empty part in {spec}"
    for length, muzzle, build_ in itertools.product(S.LENGTHS, S.MUZZLES, S.BUILDS):
        S.fits(S.PetSpec(name="x", body_length=length, muzzle=muzzle, build=build_))
    assert all(a <= b for a, b in zip(worst, MAX_SPAN)), worst


@pytest.mark.parametrize(
    "extreme",
    [
        S.PetSpec(name="tallest", body_depth="stocky", head="large", legs="long", ears="upright", ear_size="large", tail="long"),
        S.PetSpec(name="smallest", body_depth="slim", head="small", legs="short", ears="none", tail="none", muzzle="flat"),
        S.PetSpec(name="longest", body_length="long", muzzle="long", tail="plume", ears="drop", ear_size="large"),
        S.PetSpec(name="pointed", ears="pointed", ear_size="large", tail="long", body_depth="slim", legs="long"),
        S.PetSpec(name="round", ears="round", ear_size="large", body_depth="stocky", head="large"),
    ],
)
def test_every_row_stays_inside_the_frame_at_the_extremes(extreme: S.PetSpec) -> None:
    # build_sheet asserts no frame touches a border — every row, every look cell.
    assert S.render_sheet(extreme, slug="x").size == (1536, 2912)


def _pixels(img) -> set[tuple[int, int, int, int]]:
    return set(img.getdata())


def test_eyes_nose_and_tongue_are_the_colours_asked_for() -> None:
    spec = S.PetSpec(name="x", eyes=(255, 0, 0), nose=(0, 255, 0), tongue=(0, 0, 255))
    parts = build(S.breed_from_spec(spec, slug="x"))
    head_colours = {c for (*_, c) in parts["head"].voxels}
    face_colours = {c for (*_, c) in parts["face"].voxels}

    assert (255, 0, 0) in head_colours, "the eyes"
    assert (0, 255, 0) in face_colours, "the nose"
    assert (0, 0, 255) in face_colours, "the tongue"
    # Faces are shaded when drawn, so compare renders, not pixels: each colour changes the picture.
    plain = S.render_preview(S.PetSpec(name="x")).tobytes()
    for change in ({"eyes": (255, 0, 0)}, {"nose": (0, 255, 0)}, {"tongue": (0, 0, 255)}):
        assert S.render_preview(S.PetSpec(name="x", **change)).tobytes() != plain, change
    # No nose colour given: the nose is ink, as every shipped dog's is.
    default_face = {c for (*_, c) in build(S.breed_from_spec(S.PetSpec(name="x"), slug="x"))["face"].voxels}
    assert (35, 33, 42) in default_face


def test_a_pattern_is_deterministic_in_its_seed_and_changes_the_dog() -> None:
    base = dict(name="x", coat=(200, 200, 200), coat_deep=(150, 150, 150), muzzle_color=(230, 230, 230), accent_deep=(40, 40, 40))
    spotted = S.PetSpec(**base, pattern=S.Pattern("spots", "accent_deep", "medium", 7))
    again = S.PetSpec(**base, pattern=S.Pattern("spots", "accent_deep", "medium", 7))
    other = S.PetSpec(**base, pattern=S.Pattern("spots", "accent_deep", "medium", 8))
    brindle = S.PetSpec(**base, pattern=S.Pattern("brindle", "accent_deep", "dense", 1))
    plain = S.PetSpec(**base)

    assert S.render_preview(spotted).tobytes() == S.render_preview(again).tobytes()
    assert S.render_preview(spotted).tobytes() != S.render_preview(other).tobytes()
    assert S.render_preview(spotted).tobytes() != S.render_preview(plain).tobytes()
    assert S.render_preview(brindle).tobytes() != S.render_preview(spotted).tobytes()
    # The whole dog still fits with a pattern on, and every density is drawable.
    for density in S.DENSITIES:
        S.fits(S.PetSpec(**base, pattern=S.Pattern("brindle", "accent_deep", density, 3)))


def test_markings_paint_over_the_pattern() -> None:
    base = dict(name="x", coat=(200, 200, 200), coat_deep=(150, 150, 150), muzzle_color=(230, 230, 230), accent=(255, 255, 255), accent_deep=(40, 40, 40))
    chest_over = S.PetSpec(**base, pattern=S.Pattern("spots", "accent_deep", "dense", 5), markings=(S.Marking("chest", "accent"),))
    parts = build(S.breed_from_spec(chest_over, slug="x"))
    bx1 = S.breed_from_spec(chest_over, slug="x").body[3]
    chest = [c for (x, y, z, c) in parts["body"].voxels if x >= bx1 - 1]

    assert chest and all(c == (255, 255, 255) for c in chest)


def test_a_tall_dog_is_lowered_rather_than_clipped() -> None:
    tall = S.PetSpec(name="x", head="large", legs="long", ears="upright")
    body, head, leg_top = S.layout(tall)

    assert head[4] + 3 <= MAX_SPAN[1] - 1, "the ears stay inside the frame"
    assert leg_top < 5 or head[4] - head[1] + 1 < 9, "something gave: the head first, then the legs"
    check_fit(build(S.breed_from_spec(tall, slug="x")), "tall")


def test_from_dict_round_trips_and_validates() -> None:
    data = S.COOKIE_SPEC.to_dict()
    again = S.PetSpec.from_dict(json.loads(json.dumps(data)))

    assert again == S.COOKIE_SPEC
    assert S.PetSpec.from_dict({"plan": "dog", "name": "Bob", "palette": {"coat": "#ffffff", "coat_deep": "#dddddd", "muzzle": "#ffffff"}}).name == "Bob"


@pytest.mark.parametrize(
    ("bad", "message"),
    [
        ({"spec_version": 3, "name": "x", "palette": {}}, "spec_version must be 2"),
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}, "pattern": {"kind": "stripes"}}, "pattern.kind must be one of"),
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}, "pattern": {"kind": "spots", "seed": 99999}}, "pattern.seed must be an integer from 0 to 9999"),
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}, "pattern": {"kind": "spots", "color": "accent"}}, "the pattern uses accent but palette.accent is missing"),
        ({"name": "", "palette": {}}, "name is required"),
        ({"name": "x", "palette": "red"}, "palette must be an object"),
        ({"name": "x", "palette": {"coat": "red", "coat_deep": "#000000", "muzzle": "#000000"}}, "palette.coat must be a hex colour"),
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000"}}, "palette.muzzle is required"),
        ({"name": "x", "ears": "floppy", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}}, "ears must be one of drop, upright, round"),
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}, "markings": [{"where": "wings", "color": "coat"}]}, "marking.where must be one of"),
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}, "markings": [{"where": "chest", "color": "accent"}]}, "uses accent but palette.accent is missing"),
        ("not an object", "must be a JSON object"),
    ],
)
def test_a_bad_spec_says_what_to_fix(bad, message: str) -> None:
    with pytest.raises(S.SpecError, match=message):
        S.PetSpec.from_dict(bad)


def test_a_spider_is_an_honest_no_that_names_what_is_available() -> None:
    with pytest.raises(S.UnsupportedPlanError) as caught:
        S.PetSpec.from_dict({"plan": "Spider", "name": "Tom", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}})

    assert caught.value.plan == "spider"
    assert isinstance(caught.value, S.SpecError)
    assert "cat" in str(caught.value) and "dog" in str(caught.value)


def test_a_cat_that_says_only_cat_gets_a_cats_knobs() -> None:
    cat = S.PetSpec.from_dict({"plan": "cat", "name": "Tom", "palette": {"coat": "#888888", "coat_deep": "#555555", "muzzle": "#eeeeee"}})

    assert (cat.plan, cat.ears, cat.tail, cat.muzzle, cat.body_depth) == ("cat", "pointed", "long", "short", "slim")
    # A knob the spec does say wins over the kind's default.
    lop = S.PetSpec.from_dict({"plan": "cat", "name": "Tom", "ears": "drop", "palette": {"coat": "#888888", "coat_deep": "#555555", "muzzle": "#eeeeee"}})
    assert lop.ears == "drop" and lop.tail == "long"
    # A v1 spec still parses, with the new knobs at their defaults.
    old = S.PetSpec.from_dict({"spec_version": 1, "plan": "dog", "name": "Rex", "palette": {"coat": "#888888", "coat_deep": "#555555", "muzzle": "#eeeeee"}})
    assert (old.body_depth, old.ear_size) == ("medium", "medium") and old.to_dict()["spec_version"] == 2


def test_the_cat_example_renders_with_pointed_ears_and_a_long_tail_and_lounges() -> None:
    from scripts.pets.sheet import FRAMES_PER_ROW, frame_for, model_for

    breed = S.breed_from_spec(S.MISO_SPEC, slug="miso")
    parts = build(breed)
    hy1 = breed.head[4]
    assert any(y > hy1 for (_, y, _, _) in parts["ears"].voxels), "the ears rise above the crown"
    by1 = breed.body[4]
    assert max(y for (_, y, _, _) in parts["tail"].voxels) == by1 + 4, "a long tail held high"
    S.fits(S.MISO_SPEC)
    model = model_for(breed)
    lounge = frame_for(model, "lounging", 0, FRAMES_PER_ROW["lounging"]).getchannel("A").getbbox()
    sit = frame_for(model, "waiting", 0, FRAMES_PER_ROW["waiting"]).getchannel("A").getbbox()
    assert lounge and sit and lounge[1] > sit[1]


def test_an_earless_tailless_animal_has_no_such_parts_and_still_takes_markings() -> None:
    bare = S.PetSpec(name="x", ears="none", tail="none", accent=(255, 255, 255), markings=(S.Marking("ears", "accent"), S.Marking("tail", "accent")))
    parts = build(S.breed_from_spec(bare, slug="x"))

    assert "ears" not in parts and "tail" not in parts
    assert all(part.voxels for part in parts.values())
    S.fits(bare)
    assert S.render_preview(bare).getbbox() is not None


def test_previews_and_sheets_render() -> None:
    preview = S.render_preview(S.BAILEY_SPEC)
    sheet = S.render_sheet(S.MOCHI_SPEC, slug="mochi")

    assert preview.size == (192, 208)
    assert sheet.size == (1536, 2912)
    assert preview.getbbox() is not None, "something was drawn"


def test_the_schema_matches_the_parser() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    for example in S.EXAMPLES.values():
        jsonschema.validate(example.to_dict(), S.PET_SPEC_SCHEMA)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"plan": "dog"}, S.PET_SPEC_SCHEMA)


@pytest.mark.parametrize(
    ("bad", "message"),
    [
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}, "wings": True}, "dog spec has unexpected field"),
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000", "glow": "#ff00ff"}}, "palette has unexpected field"),
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}, "pattern": {"kind": "spots", "size": 3}}, "pattern has unexpected field"),
        ({"name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}, "markings": [{"where": "chest", "color": "coat", "opacity": 1}]}, "marking has unexpected field"),
        ({"name": "x" * 41, "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}}, "name must be at most 40"),
        ({"name": "x", "description": "d" * 201, "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}}, "description must be at most 200"),
    ],
)
def test_the_parser_is_the_schema_unknown_fields_and_overlong_text_are_refused(bad, message: str) -> None:
    with pytest.raises(S.SpecError, match=message):
        S.PetSpec.from_dict(bad)
