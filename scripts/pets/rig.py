"""The rig: where a body's poses pivot and how far they travel, derived from
its geometry rather than written down.

Every constant the dog animations used to carry — the head's turn and tilt
pivots, how far the body drops to lounge, how far a sitting rear sinks, how
high a waving paw goes — was Gigi's geometry copied into :mod:`poses` by
hand. That is why proportions could only move a voxel or two: a longer leg
floated in the lounge, a bigger head turned about its nose. A :class:`Rig`
is those numbers as expressions of the boxes, so a pose reads the body it is
moving. The proof that the expressions are right is that Gigi's rig equals
her old constants and her sheet is byte-identical to the shipped asset
(``tests/agent/test_pet_rig.py``).

The sign convention of the rotations, measured : a positive ``rotate_z`` leans a
column's top back (toward -x) and lifts a bar's front (nose up); negative
leans forward, nose down. Pivot on the edge that must stay on the floor.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from scripts.pets.breeds import Breed


@dataclass(frozen=True)
class Rig:
    # (x, z): the head turns about its own centre, so the face sweeps rather
    # than swings.
    turn_pivot: tuple[float, float]
    # (x, y): the neck — two rows above the barrel, low in the head — where a
    # nod, a tilt and a dejected droop rotate.
    tilt_pivot: tuple[float, float]
    # (x, y): where the look grid pitches; a little behind and below the
    # tilt pivot, so pitching up lifts the muzzle rather than the whole head.
    pitch_pivot: tuple[float, float]
    # Legs fill y = 0..leg_height; every crouch, sit and lounge is a fraction
    # of it.
    leg_height: int
    body_bottom: int
    body_top: int
    head_top: int
    # Plan-specific pivots by name — a bird's wing shoulders, a blob's arm
    # roots — so a plan's poses read them from the rig like everything else.
    anchors: dict[str, tuple[float, float]] = field(default_factory=dict)

    @property
    def lounge_body_drop(self) -> float:
        """Belly comes to rest one voxel above the floor."""
        return float(self.leg_height - 1)

    @property
    def lounge_head_drop(self) -> float:
        """The chin settles onto the paws: one row lower than the body."""
        return float(self.leg_height + 1)

    @property
    def sit_drop(self) -> float:
        """Sitting back sinks the rear half a leg."""
        return self.leg_height / 2

    @property
    def paw_raise(self) -> float:
        """A waved paw clears the legs' full height."""
        return self.leg_height + 0.5

    @property
    def stride(self) -> float:
        """Trot swing: a fraction of the leg, so short legs take short steps."""
        return 0.6 * self.leg_height


def rig_for(breed: Breed) -> Rig:
    """The rig for *breed*'s neutral geometry."""
    _, by0, _, _, by1, _ = breed.body
    hx0, hy0, hz0, hx1, hy1, hz1 = breed.head
    cx = (hx0 + hx1) / 2
    return Rig(
        turn_pivot=(cx, (hz0 + hz1) / 2),
        tilt_pivot=(cx, by1 + 2.0),
        pitch_pivot=(hx0 + 2.0, hy0 + 2.0),
        leg_height=breed.leg_top,
        body_bottom=by0,
        body_top=by1,
        head_top=hy1,
    )
