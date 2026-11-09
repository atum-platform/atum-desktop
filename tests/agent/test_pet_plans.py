"""The mascot and bird plans: every knob combination fits, every kind draws
every row, the spec speaks each plan's vocabulary and refuses the others'.
"""

from __future__ import annotations

import itertools
import json

import pytest

pytest.importorskip("PIL")

from scripts.pets import spec as S  # noqa: E402
from scripts.pets.plans import kinds, plan_for, plans  # noqa: E402
from scripts.pets.sheet import FRAMES_PER_ROW, frame_for, look_frame, model_for  # noqa: E402
from scripts.pets.voxel import MAX_SPAN  # noqa: E402

PALETTE = dict(coat=(128, 206, 168), coat_deep=(96, 176, 138), muzzle_color=(96, 168, 84), accent=(160, 224, 192), accent_deep=(72, 132, 64))
NEW_PLANS = [p for p in plans().values() if p.name != "quadruped"]
NEW_KINDS = sorted(k for k, p in kinds().items() if p.name != "quadruped")


def _spec(kind: str, **knobs: str) -> S.PetSpec:
    return S.PetSpec(name=kind, plan=kind, knobs=knobs, **PALETTE)


@pytest.mark.parametrize("plan", NEW_PLANS, ids=lambda p: p.name)
def test_every_knob_combination_fits_and_has_all_its_parts(plan) -> None:
    names = list(plan.vocabulary.knobs)
    worst = (0, 0, 0)
    for values in itertools.product(*plan.vocabulary.knobs.values()):
        spec = _spec(plan.kinds[0], **dict(zip(names, values)))
        spans = S.fits(spec)  # raises on a clip
        worst = tuple(max(a, b) for a, b in zip(worst, spans))
        parts = plan.build(plan.geometry(spec, slug="x"))
        assert all(part.voxels for part in parts.values()), f"an empty part in {spec.knobs}"
    assert all(a <= b for a, b in zip(worst, MAX_SPAN)), worst


@pytest.mark.parametrize("kind", NEW_KINDS)
def test_every_kind_draws_every_row_and_the_look_grid_unclipped(kind: str) -> None:
    # build_sheet asserts no frame touches a border — every row, every look cell.
    assert S.render_sheet(_spec(kind), slug=kind).size == (1536, 2912)


@pytest.mark.parametrize("kind", NEW_KINDS)
def test_every_kind_has_eyes_lounges_and_turns_to_look(kind: str) -> None:
    plan, geometry = S._geometry(_spec(kind), kind)
    model = model_for(geometry, plan=plan)
    idle = frame_for(model, "idle", 0, FRAMES_PER_ROW["idle"])
    dark = sum(1 for r, g, b, a in idle.getdata() if a == 255 and max(r, g, b) < 60)
    assert dark >= 8, f"{kind}: no eyes drawn"
    lounge = frame_for(model, "lounging", 0, FRAMES_PER_ROW["lounging"])
    assert lounge.tobytes() != idle.tobytes(), f"{kind}: lounging is not a pose"
    assert look_frame(model, 0).tobytes() != look_frame(model, 4).tobytes(), f"{kind}: the look grid does not turn"


def test_a_bird_roosts_lower_than_it_stands() -> None:
    plan, geometry = S._geometry(_spec("chick"), "chick")
    model = model_for(geometry, plan=plan)
    idle = frame_for(model, "idle", 0, FRAMES_PER_ROW["idle"]).getchannel("A").getbbox()
    roost = frame_for(model, "lounging", 0, FRAMES_PER_ROW["lounging"]).getchannel("A").getbbox()
    assert idle and roost and roost[1] > idle[1]


def test_kind_defaults_make_the_kind() -> None:
    penguin = S.PetSpec.from_dict({"plan": "penguin", "name": "Pen", "palette": {"coat": "#222222", "coat_deep": "#111111", "muzzle": "#ee8830"}})
    robot = S.PetSpec.from_dict({"plan": "robot", "name": "Bolt", "palette": {"coat": "#888888", "coat_deep": "#555555", "muzzle": "#cc3333"}})

    assert penguin.knobs["wings"] == "stub" and penguin.knobs["body"] == "slim"
    assert robot.knobs["topper"] == "antenna" and robot.knobs["legs"] == "stub"
    # A knob the spec does say wins over the kind's default.
    lop = S.PetSpec.from_dict({"plan": "penguin", "name": "Pen", "wings": "folded", "palette": {"coat": "#222222", "coat_deep": "#111111", "muzzle": "#ee8830"}})
    assert lop.knobs["wings"] == "folded"


def test_examples_round_trip_and_the_json_is_flat() -> None:
    for spec in (S.MINT_SPEC, S.PIP_SPEC):
        data = spec.to_dict()
        assert data["plan"] == spec.plan and "knobs" not in data and all(k in data for k in spec.knobs)
        assert S.PetSpec.from_dict(json.loads(json.dumps(data))) == spec
    assert S.PIP_SPEC.knobs["beak"] == "short" and S.MINT_SPEC.knobs["topper"] == "sprout"


@pytest.mark.parametrize(
    ("bad", "message"),
    [
        ({"plan": "chick", "name": "x", "ears": "pointed", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}}, "chick spec has unexpected field"),
        ({"plan": "slime", "name": "x", "topper": "halo", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}}, "topper must be one of none, sprout, antenna, horns, cap"),
        ({"plan": "penguin", "name": "x", "palette": {"coat": "#000000", "coat_deep": "#000000", "muzzle": "#000000"}, "markings": [{"where": "saddle", "color": "coat"}]}, "for a penguin"),
    ],
)
def test_each_plan_refuses_the_others_vocabulary(bad, message: str) -> None:
    with pytest.raises(S.SpecError, match=message):
        S.PetSpec.from_dict(bad)


def test_build_means_each_plans_own_size() -> None:
    assert S.size_for(S.PIP_SPEC) == 0.7 and S.size_for(S.MINT_SPEC) == 1.0 and S.size_for(S.BAILEY_SPEC) == 1.3
    for plan in plans().values():
        assert set(plan.vocabulary.sizes) == set(S.BUILDS)


def test_the_schema_covers_every_plan() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    for example in S.EXAMPLES.values():
        jsonschema.validate(example.to_dict(), S.PET_SPEC_SCHEMA)
    assert set(S.PET_SPEC_SCHEMA["properties"]["plan"]["enum"]) == set(kinds())
    assert "topper" in S.PET_SPEC_SCHEMA["properties"] and "beak" in S.PET_SPEC_SCHEMA["properties"]


def test_the_prompt_lists_each_plans_knobs_and_regions() -> None:
    from agent.pet.generate.voxel import system_prompt

    prompt = system_prompt(4)
    for plan in plans().values():
        for knob, options in plan.vocabulary.knobs.items():
            assert f'"{knob}"' in prompt
            for option in options:
                assert json.dumps(option) in prompt
        assert ", ".join(plan.vocabulary.regions) in prompt
    assert "mint:" in prompt and "pip:" in prompt


def test_markings_and_patterns_paint_the_new_plans() -> None:
    plain = S.render_preview(_spec("chick"))
    marked = S.render_preview(S.PetSpec(name="x", plan="chick", markings=(S.Marking("wings", "accent_deep"),), **PALETTE))
    spotted = S.render_preview(S.PetSpec(name="x", plan="blob", pattern=S.Pattern("spots", "accent_deep", "dense", 5), **PALETTE))
    assert marked.tobytes() != plain.tobytes()
    assert spotted.tobytes() != S.render_preview(_spec("blob")).tobytes()
    assert plan_for("chick").vocabulary.regions != plan_for("blob").vocabulary.regions
