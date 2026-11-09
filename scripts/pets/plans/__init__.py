"""Body plans: what a pet is made of and how it moves, behind one interface.

A plan turns a spec into its own resolved geometry, builds that geometry
into named :class:`~scripts.pets.voxel.Part`s, derives the
:class:`~scripts.pets.rig.Rig` its poses pivot on, and answers every atlas
row (see ``agent.pet.constants.V3_STATE_ROWS``) and the look grid in its own
idiom — a bird's "run" is a hop, a blob turns its whole body to look. The
rasteriser (:mod:`scripts.pets.voxel`) and the atlas layout
(:mod:`scripts.pets.sheet`) never learn a plan.

A plan also owns its **vocabulary**: the knobs a model may set (each an
enum), their defaults, the regions a marking may name, and the on-screen
size each ``build`` means. :mod:`scripts.pets.spec` validates a spec against
the vocabulary of the plan its ``plan`` word belongs to — so the parser is
the schema for every plan, and the prompt is generated from the same tables.

Plans: quadruped (dogs, cats, foxes, rabbits, pigs, bears), mascot (blobs,
ghosts, slimes, robots…), bird (chicks, owls, penguins…) — plan
2026-09-13-pet-plans-rig-and-activities, decisions 4–6.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from scripts.pets.rig import Rig
from scripts.pets.voxel import Color, Part, Pose

BUILDS = ("small", "medium", "large")


@dataclass(frozen=True)
class Vocabulary:
    """What a model may write for one plan, and what it means."""

    # knob name -> its options, in the order the prompt lists them.
    knobs: dict[str, tuple[str, ...]]
    # Plan-wide default per knob; a kind may override (Plan.defaults).
    defaults: dict[str, str]
    # Regions a marking may name.
    regions: tuple[str, ...]
    # build -> how big the desk draws it (pet.json `size`).
    sizes: dict[str, float]
    # Which knobs a draft card mentions, after the kind and the build.
    card: tuple[str, ...]
    # One-line hints for the prompt: per knob, and what each palette slot paints.
    notes: dict[str, str] = field(default_factory=dict)
    palette: str = ""


class Plan(Protocol):
    """One body plan. ``geometry`` is the plan's own resolved shape — for the
    quadruped a :class:`~scripts.pets.breeds.Breed` — produced by the plan
    from a spec; nothing outside the plan reads it."""

    name: str
    kinds: tuple[str, ...]
    vocabulary: Vocabulary
    # Of the optional atlas rows (v4, plan decision 10), which this plan draws.
    optional_rows: frozenset[str]

    def defaults(self, kind: str) -> dict[str, Any]:
        """Knob defaults for *kind*, applied where a spec is silent."""

    def geometry(self, spec: Any, *, slug: str) -> Any:
        """The resolved shape for *spec*: boxes that fit by construction."""

    def build(self, geometry: Any, *, blink: bool = False) -> dict[str, Part]:
        """The neutral pose as named parts."""

    def rig(self, geometry: Any) -> Rig: ...

    def fur(self, geometry: Any) -> frozenset[Color]:
        """The colours that get per-voxel jitter (fur, feathers — not eyes)."""

    def pose(self, row: str, i: int, n: int, rig: Rig) -> Pose:
        """Frame *i* of *n* for an animation row."""

    def look(self, yaw: int, pitch: int, rig: Rig) -> Pose:
        """One cell of the look grid."""


def plans() -> dict[str, Plan]:
    """Every plan by name. Imported lazily so a plan module can import this one."""
    from scripts.pets.plans.bird import BIRD
    from scripts.pets.plans.mascot import MASCOT
    from scripts.pets.plans.quadruped import QUADRUPED

    return {QUADRUPED.name: QUADRUPED, MASCOT.name: MASCOT, BIRD.name: BIRD}


def kinds() -> dict[str, Plan]:
    """Every kind word a spec may say, and the plan that draws it."""
    return {kind: plan for plan in plans().values() for kind in plan.kinds}


def plan_for(kind: str) -> Plan:
    """The plan for a kind word; ``KeyError`` for one no plan owns."""
    return kinds()[kind]


def resolved_knobs(plan: Plan, kind: str, given: dict[str, str]) -> dict[str, str]:
    """Every knob of *plan*, with the kind's and the plan's defaults filled in."""
    return {**plan.vocabulary.defaults, **plan.defaults(kind), **given}


def optional_rows(plan: Plan) -> tuple[str, ...]:
    """The v4 optional rows *plan* draws, in the canonical sheet order — what
    the sheet appends after the look rows and ``pet.json`` declares."""
    from agent.pet.constants import OPTIONAL_STATE_ROWS

    return tuple(row for row in OPTIONAL_STATE_ROWS if row in plan.optional_rows)


__all__ = ["BUILDS", "Plan", "Vocabulary", "kinds", "optional_rows", "plan_for", "plans", "resolved_knobs"]
