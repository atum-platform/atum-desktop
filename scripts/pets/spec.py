"""A pet as a spec of knobs: what a model writes, what the renderer guarantees.

A language model should never have to emit voxel coordinates, so this module
sits between the model and the plans (:mod:`scripts.pets.plans`): a
**PetSpec** is a kind word (``"cat"``, ``"penguin"``, ``"slime"``), a build,
a palette of hex colours, a pattern, markings from the plan's menu of named
regions, and the plan's own knobs — each an enum from that plan's
vocabulary. The plan maps every combination onto geometry that fits the
frame by construction, and the test suite renders every combination through
the fit check to prove it.

The JSON is flat: the plan's knobs sit beside ``name`` and ``palette``, and
which knobs are allowed depends on the ``plan`` word. The parser is the
schema — a field the plan's vocabulary does not name is refused — and the
prompt is generated from the same tables (:mod:`agent.pet.generate.voxel`).

The quadruped's knobs are also typed fields on :class:`PetSpec` (``ears``,
``tail``, …), kept in sync with ``knobs``: the first plan's convenience,
which the shipped dogs, their tests and the summary lines all use.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from scripts.pets.plans import BUILDS, kinds, plan_for, resolved_knobs
from scripts.pets.plans.quadruped import BUILD_SIZE, QUADRUPED, breed_from_spec, layout
from scripts.pets.voxel import Color, check_fit

PLAN = "dog"  # the default kind
# The quadruped's options, re-exported: the shipped dogs and their tests
# speak this vocabulary by name.
LENGTHS = QUADRUPED.vocabulary.knobs["body_length"]
DEPTHS = QUADRUPED.vocabulary.knobs["body_depth"]
HEADS = QUADRUPED.vocabulary.knobs["head"]
LEGS = QUADRUPED.vocabulary.knobs["legs"]
EARS = QUADRUPED.vocabulary.knobs["ears"]
EAR_SIZES = QUADRUPED.vocabulary.knobs["ear_size"]
TAILS = QUADRUPED.vocabulary.knobs["tail"]
MUZZLES = QUADRUPED.vocabulary.knobs["muzzle"]
REGIONS = QUADRUPED.vocabulary.regions
_QUADRUPED_KNOBS = tuple(QUADRUPED.vocabulary.knobs)
PAINTS = ("coat", "coat_deep", "muzzle", "accent", "accent_deep")
PATTERNS = ("none", "spots", "brindle")
DENSITIES = ("sparse", "medium", "dense")
# v2 (2026-09-13): body_depth, ear_size, pointed/none ears, long/none tails, a
# flat muzzle, and kinds beyond the dog; then the mascot and bird plans with
# their own knobs. A v1 spec still parses — the new knobs take their defaults
# — and renders under the current rig, which is why the renderer version
# moved too.
SPEC_VERSION = 2
ACCEPTED_SPEC_VERSIONS = (1, 2)
MAX_SEED = 9999
# Bumped when a plan or the renderer would draw an old spec differently.
RENDERER_VERSION = "voxel-2"

_HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")

_COMMON_KEYS = frozenset({"spec_version", "plan", "name", "description", "build", "palette", "pattern", "markings"})
_PALETTE_KEYS = frozenset({"coat", "coat_deep", "muzzle", "accent", "accent_deep", "ear", "eyes", "nose", "tongue"})
_PATTERN_KEYS = frozenset({"kind", "color", "density", "seed"})
_MARKING_KEYS = frozenset({"where", "color"})


def _only(obj: dict, allowed: frozenset, what: str) -> None:
    """The parser is the schema: a field the schema does not name is refused,
    at every level, so a drifting model cannot smuggle anything past it."""
    extra = sorted(str(k) for k in obj if k not in allowed)
    if extra:
        raise SpecError(f"{what} has unexpected field(s): {', '.join(extra)}; allowed: {', '.join(sorted(allowed))}")


class SpecError(ValueError):
    """A spec the renderer will not accept. The message is written to be sent
    back to the model as the repair instruction."""


class UnsupportedPlanError(SpecError):
    """The model designed something no plan draws. Not a repair: the user
    asked for a spider, and the honest answer names what is available."""

    def __init__(self, plan: str) -> None:
        super().__init__(f"body plan {plan!r} is not available; try one of {', '.join(sorted(kinds()))}")
        self.plan = plan


def _schema() -> dict[str, Any]:
    """A JSON Schema over every plan's knobs — the union, for tooling; the
    parser is the authority on which knobs go with which plan."""
    knob_props: dict[str, Any] = {}
    regions: set[str] = set()
    for plan in {p.name: p for p in kinds().values()}.values():
        for knob, options in plan.vocabulary.knobs.items():
            merged = list(dict.fromkeys([*knob_props.get(knob, {}).get("enum", []), *options]))
            knob_props[knob] = {"enum": merged}
        regions.update(plan.vocabulary.regions)
    colour = {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}
    optional_colour = {"type": ["string", "null"], "pattern": "^#[0-9a-fA-F]{6}$"}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["spec_version", "plan", "name", "description", "build", "palette", "pattern", "markings"],
        "properties": {
            "spec_version": {"enum": list(ACCEPTED_SPEC_VERSIONS)},
            "plan": {"enum": sorted(kinds())},
            "name": {"type": "string", "minLength": 1, "maxLength": 40},
            "description": {"type": "string", "maxLength": 200},
            "build": {"enum": list(BUILDS)},
            **knob_props,
            "palette": {
                "type": "object",
                "additionalProperties": False,
                "required": ["coat", "coat_deep", "muzzle"],
                "properties": {
                    "coat": colour,
                    "coat_deep": colour,
                    "muzzle": colour,
                    "accent": optional_colour,
                    "accent_deep": optional_colour,
                    "ear": optional_colour,
                    "eyes": optional_colour,
                    "nose": optional_colour,
                    "tongue": optional_colour,
                },
            },
            "pattern": {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind"],
                "properties": {
                    "kind": {"enum": list(PATTERNS)},
                    "color": {"enum": list(PAINTS)},
                    "density": {"enum": list(DENSITIES)},
                    "seed": {"type": "integer", "minimum": 0, "maximum": MAX_SEED},
                },
            },
            "markings": {
                "type": "array",
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["where", "color"],
                    "properties": {"where": {"enum": sorted(regions)}, "color": {"enum": list(PAINTS)}},
                },
            },
        },
    }


PET_SPEC_SCHEMA: dict[str, Any] = _schema()


@dataclass(frozen=True)
class Marking:
    where: str
    color: str


@dataclass(frozen=True)
class Pattern:
    kind: str = "none"
    color: str = "accent_deep"
    density: str = "medium"
    seed: int = 0


@dataclass(frozen=True)
class PetSpec:
    name: str
    description: str = ""
    build: str = "medium"
    # The quadruped's knobs as typed fields (see the module docstring).
    body_length: str = "medium"
    body_depth: str = "medium"
    head: str = "medium"
    legs: str = "medium"
    ears: str = "drop"
    ear_size: str = "medium"
    tail: str = "curl"
    muzzle: str = "medium"
    coat: Color = (245, 243, 238)
    coat_deep: Color = (226, 221, 211)
    muzzle_color: Color = (252, 251, 248)
    accent: Color | None = None
    accent_deep: Color | None = None
    ear_color: Color | None = None
    eyes: Color | None = None
    nose: Color | None = None
    tongue: Color | None = None
    pattern: Pattern = field(default_factory=Pattern)
    markings: tuple[Marking, ...] = field(default_factory=tuple)
    plan: str = PLAN
    spec_version: int = SPEC_VERSION
    # The plan's knobs, every one present: the truth for any plan. For the
    # quadruped it mirrors the typed fields above.
    knobs: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        body_plan = plan_for(self.plan)  # KeyError for a word no plan owns: a programming error here, a SpecError in from_dict
        if body_plan is QUADRUPED:
            mirrored = {k: getattr(self, k) for k in _QUADRUPED_KNOBS}
            if self.knobs and self.knobs != mirrored:
                raise ValueError("a quadruped's knobs are its typed fields; do not pass both")
            object.__setattr__(self, "knobs", mirrored)
        else:
            object.__setattr__(self, "knobs", resolved_knobs(body_plan, self.plan, dict(self.knobs)))

    @classmethod
    def from_dict(cls, data: Any) -> "PetSpec":
        """Parse and validate what a model wrote. Raises :class:`SpecError`
        with a message the model can act on."""
        if not isinstance(data, dict):
            raise SpecError("the spec must be a JSON object")
        version = data.get("spec_version", SPEC_VERSION)
        if version not in ACCEPTED_SPEC_VERSIONS:
            raise SpecError(f"spec_version must be {SPEC_VERSION}; got {version!r}")
        plan = str(data.get("plan", PLAN) or PLAN).strip().lower()
        try:
            body_plan = plan_for(plan)
        except KeyError:
            raise UnsupportedPlanError(plan) from None
        vocab = body_plan.vocabulary
        # What the kind implies where the spec is silent: a cat that says only
        # "cat" gets pointed ears and a long tail.
        defaults = resolved_knobs(body_plan, plan, {})
        _only(data, _COMMON_KEYS | frozenset(vocab.knobs), f"a {plan} spec")
        name = str(data.get("name") or "").strip()
        if not name:
            raise SpecError("name is required")
        if len(name) > 40:
            raise SpecError("name must be at most 40 characters")
        description = str(data.get("description") or "").strip()
        if len(description) > 200:
            raise SpecError("description must be at most 200 characters")

        def choice(key: str, options: tuple[str, ...], default: str) -> str:
            value = data.get(key, default)
            if value not in options:
                raise SpecError(f"{key} must be one of {', '.join(options)}; got {value!r}")
            return value

        palette = data.get("palette")
        if not isinstance(palette, dict):
            raise SpecError("palette must be an object with coat, coat_deep and muzzle as #rrggbb")
        _only(palette, _PALETTE_KEYS, "palette")

        def color(key: str, *, required: bool) -> Color | None:
            raw = palette.get(key)
            if raw in (None, ""):
                if required:
                    raise SpecError(f"palette.{key} is required, as #rrggbb")
                return None
            m = _HEX.match(str(raw).strip())
            if not m:
                raise SpecError(f"palette.{key} must be a hex colour like #8a8f9c; got {raw!r}")
            h = m.group(1)
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

        coat = color("coat", required=True)
        coat_deep = color("coat_deep", required=True)
        muzzle_color = color("muzzle", required=True)
        accent = color("accent", required=False)
        accent_deep = color("accent_deep", required=False)
        ear_color = color("ear", required=False)
        eyes = color("eyes", required=False)
        nose = color("nose", required=False)
        tongue = color("tongue", required=False)
        assert coat and coat_deep and muzzle_color

        raw_pattern = data.get("pattern") or {"kind": "none"}
        if not isinstance(raw_pattern, dict):
            raise SpecError("pattern must be an object like {kind, color, density, seed}")
        _only(raw_pattern, _PATTERN_KEYS, "pattern")
        kind = raw_pattern.get("kind", "none")
        if kind not in PATTERNS:
            raise SpecError(f"pattern.kind must be one of {', '.join(PATTERNS)}; got {kind!r}")
        paint = raw_pattern.get("color", "accent_deep")
        if paint not in PAINTS:
            raise SpecError(f"pattern.color must be one of {', '.join(PAINTS)}; got {paint!r}")
        density = raw_pattern.get("density", "medium")
        if density not in DENSITIES:
            raise SpecError(f"pattern.density must be one of {', '.join(DENSITIES)}; got {density!r}")
        seed = raw_pattern.get("seed", 0)
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= MAX_SEED:
            raise SpecError(f"pattern.seed must be an integer from 0 to {MAX_SEED}; got {seed!r}")
        if kind != "none":
            if paint == "accent" and accent is None:
                raise SpecError("the pattern uses accent but palette.accent is missing")
            if paint == "accent_deep" and accent_deep is None:
                raise SpecError("the pattern uses accent_deep but palette.accent_deep is missing")
        pattern = Pattern(kind=kind, color=paint, density=density, seed=seed)

        raw_markings = data.get("markings", [])
        if not isinstance(raw_markings, list):
            raise SpecError("markings must be a list of {where, color}")
        if len(raw_markings) > 8:
            raise SpecError("at most 8 markings")
        markings: list[Marking] = []
        for item in raw_markings:
            if not isinstance(item, dict):
                raise SpecError("each marking must be an object with where and color")
            _only(item, _MARKING_KEYS, "marking")
            where = item.get("where")
            paint = item.get("color")
            if where not in vocab.regions:
                raise SpecError(f"marking.where must be one of {', '.join(vocab.regions)} for a {plan}; got {where!r}")
            if paint not in PAINTS:
                raise SpecError(f"marking.color must be one of {', '.join(PAINTS)}; got {paint!r}")
            if paint == "accent" and accent is None:
                raise SpecError("a marking uses accent but palette.accent is missing")
            if paint == "accent_deep" and accent_deep is None:
                raise SpecError("a marking uses accent_deep but palette.accent_deep is missing")
            markings.append(Marking(where=where, color=paint))

        # The knobs last, so a repair instruction leads with the palette and
        # the pattern — what a model gets wrong first.
        build = choice("build", BUILDS, "medium")
        knobs = {knob: choice(knob, options, defaults[knob]) for knob, options in vocab.knobs.items()}
        typed = {k: knobs[k] for k in _QUADRUPED_KNOBS} if body_plan is QUADRUPED else {}
        return cls(
            name=name,
            description=description,
            build=build,
            **typed,
            plan=plan,
            coat=coat,
            coat_deep=coat_deep,
            muzzle_color=muzzle_color,
            accent=accent,
            accent_deep=accent_deep,
            ear_color=ear_color,
            eyes=eyes,
            nose=nose,
            tongue=tongue,
            pattern=pattern,
            markings=tuple(markings),
            knobs={} if body_plan is QUADRUPED else knobs,
        )

    def to_dict(self) -> dict[str, Any]:
        """The canonical JSON form (what is saved beside the pet): flat, the
        plan's knobs beside the common fields."""

        def hexed(c: Color | None) -> str | None:
            return None if c is None else "#%02x%02x%02x" % c

        return {
            "spec_version": self.spec_version,
            "plan": self.plan,
            "name": self.name,
            "description": self.description,
            "build": self.build,
            **self.knobs,
            "palette": {
                "coat": hexed(self.coat),
                "coat_deep": hexed(self.coat_deep),
                "muzzle": hexed(self.muzzle_color),
                "accent": hexed(self.accent),
                "accent_deep": hexed(self.accent_deep),
                "ear": hexed(self.ear_color),
                "eyes": hexed(self.eyes),
                "nose": hexed(self.nose),
                "tongue": hexed(self.tongue),
            },
            "pattern": {"kind": self.pattern.kind, "color": self.pattern.color, "density": self.pattern.density, "seed": self.pattern.seed},
            "markings": [{"where": m.where, "color": m.color} for m in self.markings],
        }


def _geometry(spec: PetSpec, slug: str):
    """(plan, geometry) for *spec* — the plan its kind word belongs to."""
    plan = plan_for(spec.plan)
    return plan, plan.geometry(spec, slug=slug)


def size_for(spec: PetSpec) -> float:
    """How big the desk draws *spec*: its plan's meaning of ``build``."""
    return plan_for(spec.plan).vocabulary.sizes[spec.build]


def extra_rows_for(spec: PetSpec) -> tuple[str, ...]:
    """The v4 optional rows *spec*'s plan draws, in sheet order (``pet.json`` ``extraRows``)."""
    from scripts.pets.plans import optional_rows

    return optional_rows(plan_for(spec.plan))


def fits(spec: PetSpec) -> tuple[int, int, int]:
    """The spans of *spec*'s idle pose; raises if it does not fit the frame."""
    plan, geometry = _geometry(spec, "spec")
    return check_fit(plan.build(geometry), spec.name)


def render_preview(spec: PetSpec, *, slug: str = "preview"):
    """The idle frame (frame 0), for a draft card."""
    from scripts.pets.sheet import FRAMES_PER_ROW, frame_for, model_for

    plan, geometry = _geometry(spec, slug)
    return frame_for(model_for(geometry, plan=plan), "idle", 0, FRAMES_PER_ROW["idle"])


def render_sheet(spec: PetSpec, *, slug: str):
    """The full v3 atlas."""
    from scripts.pets.sheet import build_sheet

    plan, geometry = _geometry(spec, slug)
    return build_sheet(geometry, plan=plan)


# ── The examples ──────────────────────────────────────────────────────────────
# The shipped dogs as specs (the proof that the vocabulary is complete enough:
# each must render byte-identical to its hand-written breed), a cat, and one
# of each other plan, in front of the model as examples.

GIGI_SPEC = PetSpec(
    name="Gigi",
    description="Atum's maltese. The master assistant's companion.",
    coat=(245, 243, 238),
    coat_deep=(226, 221, 211),
    muzzle_color=(252, 251, 248),
)

MOCHI_SPEC = PetSpec(
    name="Mochi",
    description="A white bichon: round everywhere, and pleased about it.",
    build="medium",
    body_length="short",
    body_depth="slim",
    head="large",
    legs="short",
    ears="round",
    ear_size="large",
    tail="plume",
    coat=(250, 250, 250),
    coat_deep=(226, 226, 230),
    muzzle_color=(255, 247, 247),
)

COOKIE_SPEC = PetSpec(
    name="Cookie",
    description="A Yorkshire terrier: small, steel-blue and tan, ears up.",
    build="small",
    body_depth="slim",
    head="small",
    legs="short",
    ears="upright",
    ear_size="small",
    tail="stub",
    coat=(98, 104, 120),
    coat_deep=(72, 76, 90),
    muzzle_color=(206, 160, 96),
    accent=(196, 146, 84),
    accent_deep=(150, 106, 56),
    ear_color=(72, 76, 90),
    markings=(Marking("face", "accent"), Marking("chest", "accent"), Marking("legs", "accent"), Marking("paws", "accent_deep")),
)

BAILEY_SPEC = PetSpec(
    name="Bailey",
    description="A Saint Bernard: big, gentle, and mostly asleep.",
    build="large",
    body_length="long",
    legs="long",
    ears="drop",
    ear_size="large",
    tail="plume",
    muzzle="long",
    coat=(240, 236, 228),
    coat_deep=(218, 211, 199),
    muzzle_color=(246, 243, 236),
    accent=(150, 96, 52),
    accent_deep=(60, 42, 34),
    ear_color=(60, 42, 34),
    markings=(
        Marking("saddle", "accent"),
        Marking("head", "accent"),
        Marking("front", "coat"),
        Marking("mask", "accent_deep"),
        Marking("ears", "accent_deep"),
        Marking("tail_base", "accent"),
    ),
)

MISO_SPEC = PetSpec(
    name="Miso",
    plan="cat",
    description="A grey tabby: pointed ears, a long tail, and opinions.",
    body_depth="slim",
    ears="pointed",
    tail="long",
    muzzle="short",
    coat=(152, 152, 160),
    coat_deep=(112, 112, 122),
    muzzle_color=(232, 232, 234),
    accent=(232, 232, 234),
    accent_deep=(72, 72, 82),
    pattern=Pattern("brindle", "accent_deep", "medium", 3),
    markings=(Marking("chest", "accent"), Marking("paws", "accent")),
)

MINT_SPEC = PetSpec(
    name="Mint",
    plan="slime",
    description="A mint slime with a sprout, mostly smiling.",
    knobs={"body": "round", "arms": "stub", "legs": "none", "face": "eyes_mouth", "topper": "sprout"},
    coat=(128, 206, 168),
    coat_deep=(96, 176, 138),
    muzzle_color=(96, 168, 84),
    accent=(160, 224, 192),
    accent_deep=(72, 132, 64),
    markings=(Marking("belly", "accent"),),
)

PIP_SPEC = PetSpec(
    name="Pip",
    plan="chick",
    build="small",
    description="A round yellow chick, all fluff and beak.",
    knobs={"body": "round", "neck": "short", "beak": "short", "wings": "folded", "legs": "short", "tail": "short", "crest": "none"},
    coat=(243, 201, 74),
    coat_deep=(218, 172, 52),
    muzzle_color=(238, 132, 48),
    accent=(250, 226, 140),
    accent_deep=(200, 150, 40),
    markings=(Marking("belly", "accent"), Marking("wings", "coat_deep")),
)

EXAMPLES: dict[str, PetSpec] = {
    "gigi": GIGI_SPEC,
    "mochi": MOCHI_SPEC,
    "cookie": COOKIE_SPEC,
    "bailey": BAILEY_SPEC,
    "miso": MISO_SPEC,
    "mint": MINT_SPEC,
    "pip": PIP_SPEC,
}

__all__ = [
    "ACCEPTED_SPEC_VERSIONS",
    "BUILDS",
    "BUILD_SIZE",
    "DENSITIES",
    "DEPTHS",
    "EAR_SIZES",
    "EARS",
    "EXAMPLES",
    "HEADS",
    "LEGS",
    "LENGTHS",
    "MUZZLES",
    "PAINTS",
    "PATTERNS",
    "PET_SPEC_SCHEMA",
    "PLAN",
    "REGIONS",
    "RENDERER_VERSION",
    "SPEC_VERSION",
    "TAILS",
    "Marking",
    "Pattern",
    "PetSpec",
    "SpecError",
    "UnsupportedPlanError",
    "breed_from_spec",
    "fits",
    "layout",
    "render_preview",
    "render_sheet",
    "size_for",
]
