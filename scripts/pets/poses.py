"""The animations. One function per atlas row, plus the look grid.

Every pose is expressed as per-part offsets and rotations of the neutral model
(see :mod:`scripts.pets.breeds`), so the same animation drives every breed:
a Saint Bernard trots with the same diagonal leg pairs as a maltese, just on a
different body. Part names are the contract — body, head, ears, face,
leg_fl / leg_fr / leg_bl / leg_br, tail.

Where a pose pivots and how far it travels comes from the breed's
:class:`~scripts.pets.rig.Rig`, never from a constant: a longer leg lounges
lower, a bigger head turns about its own centre. The amplitudes that are
feel rather than geometry — a breath, an ear sway, a jump's arc — stay here.
"""

from __future__ import annotations

import math

from scripts.pets.rig import Rig
from scripts.pets.voxel import Pose

# ── Look grid (v2/v3 atlases) ────────────────────────────────────────────────
#
# Five yaw headings by three pitches. Yaw 0 looks toward the screen-left edge,
# yaw 4 toward the screen-right; pitch rows are up / level / down.
YAW_STEPS = 5
PITCH_STEPS = 3
YAW_HEADINGS = [45.0 + 45.0 * i for i in range(YAW_STEPS)]
PITCH_ANGLES = [-16.0, 0.0, 14.0]
LOOK_ORIGIN = "yaw5-pitch3-mirrored"

HEAD_PARTS = ("head", "face")
LEGS = ("leg_fl", "leg_fr", "leg_bl", "leg_br")


def _wave(i: int, n: int, amp: float, phase: float = 0.0) -> float:
    return amp * math.sin(2 * math.pi * (i / n) + phase)


def _head_tilt(p: Pose, rig: Rig, deg: float) -> None:
    for part in HEAD_PARTS:
        p.rotations[part] = (rig.tilt_pivot, deg)


def pose_idle(i: int, n: int, rig: Rig) -> Pose:
    """Breathing, a slow ear sway, one blink per loop."""
    p = Pose(lift=_wave(i, n, 0.5))
    sway = _wave(i, n, 0.6, phase=0.9)
    p.offsets["ears"] = (0, sway, 0)
    p.offsets["tail"] = (0, _wave(i, n, 1.0, phase=1.6), 0)
    p.blink = i == n - 2
    return p


def pose_run(i: int, n: int, rig: Rig, *, travelling: bool) -> Pose:
    """Trot cycle: diagonal leg pairs, body bob, ears and tail trailing."""
    p = Pose(lift=abs(_wave(i, n, 1.2)))
    swing = _wave(i, n, rig.stride)
    p.offsets["leg_fl"] = (swing, abs(swing) * 0.4, 0)
    p.offsets["leg_br"] = (swing, abs(swing) * 0.4, 0)
    p.offsets["leg_fr"] = (-swing, abs(swing) * 0.4, 0)
    p.offsets["leg_bl"] = (-swing, abs(swing) * 0.4, 0)
    p.offsets["ears"] = (-1, _wave(i, n, 1.0, phase=1.2) - 0.5, 0)
    p.offsets["tail"] = (-0.5, 1.0 + _wave(i, n, 0.8, phase=2.0), 0)
    if travelling:
        # Lean into the direction of travel.
        _head_tilt(p, rig, -4)
    return p


def pose_wave(i: int, n: int, rig: Rig) -> Pose:
    """Sit back and raise the near front paw."""
    p = Pose(lift=-1)
    p.offsets["leg_fl"] = (2.5, rig.paw_raise + _wave(i, n, 1.2), 0)
    p.offsets["leg_fr"] = (0.5, 0, 0)
    p.offsets["ears"] = (0, _wave(i, n, 0.8), 0)
    p.offsets["tail"] = (0, 1.5 + _wave(i, n, 1.2, phase=1.0), 0)
    _head_tilt(p, rig, _wave(i, n, 5))
    return p


def pose_jump(i: int, n: int, rig: Rig) -> Pose:
    """Crouch, launch, float, land — a celebration hop."""
    curve = [-1.5, 1.2, 3.5, 2.0, -0.5]
    tuck = [0.0, -1.0, -2.5, -1.5, 0.0]
    p = Pose(lift=curve[i % len(curve)])
    t = tuck[i % len(tuck)]
    for leg in LEGS:
        p.offsets[leg] = (0, -t, 0)
    p.offsets["ears"] = (0, -t * 1.4, 0)
    p.offsets["tail"] = (0, 1.5, 0)
    return p


def pose_failed(i: int, n: int, rig: Rig) -> Pose:
    """Head down, ears and tail dropped, a slow dejected sway."""
    droop = min(1.0, i / 3)
    p = Pose(lift=-1.5 * droop)
    p.offsets["head"] = (0.5 * droop, -2.0 * droop, 0)
    p.offsets["face"] = (0.5 * droop, -2.0 * droop, 0)
    p.offsets["ears"] = (0.5 * droop, -3.0 * droop + _wave(i, n, 0.4), 0)
    p.offsets["tail"] = (0, -3.5 * droop, 0)
    _head_tilt(p, rig, 9 * droop)
    p.blink = True
    return p


def pose_waiting(i: int, n: int, rig: Rig) -> Pose:
    """Sitting, tail wagging — the 'your turn' pose, so it has to read as alert."""
    p = Pose(lift=-rig.sit_drop)
    tuck = -0.75 * rig.sit_drop  # the back legs fold under the sunk rear
    p.offsets["leg_bl"] = (tuck, tuck, 0)
    p.offsets["leg_br"] = (tuck, tuck, 0)
    p.offsets["tail"] = (0, 2.0, _wave(i, n, 2.2))
    p.offsets["ears"] = (0, _wave(i, n, 0.5), 0)
    _head_tilt(p, rig, _wave(i, n, 3, phase=0.5))
    return p


def pose_review(i: int, n: int, rig: Rig) -> Pose:
    """Head tilt — the universal 'thinking about it' dog gesture."""
    tilt = 12 * (0.5 + 0.5 * math.sin(2 * math.pi * i / n))
    p = Pose(lift=_wave(i, n, 0.4))
    _head_tilt(p, rig, tilt)
    p.offsets["ears"] = (0, -tilt * 0.06, 0)
    p.offsets["tail"] = (0, _wave(i, n, 0.8, phase=1.0), 0)
    p.blink = i in (n - 2, n - 1)
    return p


def pose_lounging(i: int, n: int, rig: Rig) -> Pose:
    """Lying down and staying: the pose a pet holds on a perch.

    Belly to the ground, front paws stretched forward, back legs tucked under,
    head resting low and turned a little toward the viewer, tail curled in.
    The only motion is breathing and a slow blink — a lounge that fidgets is
    not a lounge. Reads as the dog having decided to stay, which is the point.

    Nothing here uses the whole-body ``lift``: that would take the paws below
    the baseline. The body and head come down to the paws instead, which is
    also what a dog does — by the rig's leg height, so a long-legged dog
    comes all the way down and a short one does not sink through the floor.
    """
    breath = _wave(i, n, 0.35)
    p = Pose()
    # Front legs out along the ground; back legs folded under the body.
    p.offsets["leg_fl"] = (2.0, 0, 0)
    p.offsets["leg_fr"] = (2.0, 0, 0)
    p.hidden.update({"leg_bl", "leg_br"})
    # Body down onto the ground.
    p.offsets["body"] = (0, -rig.lounge_body_drop + breath, 0)
    # Head settles onto the paws, chin down, a small turn toward the viewer.
    head_drop = -rig.lounge_head_drop + breath
    p.offsets["head"] = (0, head_drop, 0)
    p.offsets["face"] = (0, head_drop, 0)
    p.offsets["ears"] = (0, head_drop + _wave(i, n, 0.3, phase=0.7), 0)
    # A shallow tilt and no turn: the chin rests, but the eyes stay readable.
    # Turned away, the face sank into the paws and she read as asleep or gone.
    _head_tilt(p, rig, 5)
    # Tail curled alongside the body.
    p.offsets["tail"] = (0.5, -rig.leg_height, 1.0)
    p.blink = i in (n - 3, n - 2)
    return p


def pose_sleep(i: int, n: int, rig: Rig) -> Pose:
    """Asleep on the perch: the lounge, gone all the way down.

    Chin flat on the paws, nose down rather than turned to the viewer, ears
    dropped, eyes shut the whole loop. The only motion is a slow breath; the
    desktop's tempo slows the loop further (v4 optional row, plan decision 10:
    the trigger is a long idle, the stand-in is lounging).
    """
    breath = _wave(i, n, 0.3)
    p = Pose()
    p.offsets["leg_fl"] = (2.0, 0, 0)
    p.offsets["leg_fr"] = (2.0, 0, 0)
    p.hidden.update({"leg_bl", "leg_br"})
    p.offsets["body"] = (0, -rig.lounge_body_drop + breath, 0)
    head_drop = -rig.lounge_head_drop - 1 + breath
    p.offsets["head"] = (0.5, head_drop, 0)
    p.offsets["face"] = (0.5, head_drop, 0)
    p.offsets["ears"] = (0.5, head_drop - 0.5, 0)
    _head_tilt(p, rig, -4)  # nose down: negative is beak/nose down (rig.py)
    p.offsets["tail"] = (1.0, -rig.leg_height, 1.0)
    p.blink = True
    return p


def pose_carried(i: int, n: int, rig: Rig) -> Pose:
    """Picked up: the person is dragging the pet, and it hangs from their hand.

    Legs dangle straight down and sway a little, the tail drops, the ears go
    back, the eyes stay open. No lift and no lean — the sprite's position is
    the cursor's, so the pose only has to read as *held*, not as moving.
    """
    sway = _wave(i, n, 0.6)
    p = Pose()
    for leg in LEGS:
        # One voxel down, not more: the baseline pad below the paws is 14 px,
        # and two voxels of dangle touch the frame.
        p.offsets[leg] = (sway, -1.0, 0)
    p.offsets["tail"] = (0.5, -1.5, 0)
    p.offsets["ears"] = (-0.5, 0.5, 0)
    _head_tilt(p, rig, 3)
    return p


def pose_look(yaw: int, pitch: int, rig: Rig) -> Pose:
    """Turn and tilt the head toward one grid cell.

    Only the head, face and ears move; the body stays put. That is what a real
    dog does, and it keeps the silhouette stable so the gaze reads as attention
    rather than as the whole pet twitching.
    """
    p = Pose()
    heading = YAW_HEADINGS[max(0, min(YAW_STEPS - 1, yaw))]
    tilt = PITCH_ANGLES[max(0, min(PITCH_STEPS - 1, pitch))]

    for part in ("head", "face", "ears"):
        p.turns[part] = (rig.turn_pivot, heading)
        if tilt:
            # Pitch is a rotation in the facing plane about the neck, applied
            # after the yaw (see `posed`).
            p.rotations[part] = (rig.pitch_pivot, tilt)

    return p
