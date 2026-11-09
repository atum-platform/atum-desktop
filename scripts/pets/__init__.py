"""First-party pets, rendered from voxel models.

    python -m scripts.pets [all|<slug>] [outdir]

Why a generator and not the gallery: petdex's manifest carries ``submittedBy``
and no licence field, so a community asset cannot be shipped as a default;
and the in-app hatch flow needs a configured image provider and varies with
it. So our pets are modelled here — one :mod:`scripts.pets.breeds` spec each,
drawn by a body plan (:mod:`scripts.pets.plans`: quadruped, mascot, bird —
vocabulary, fit, rig and poses in one place), one rasteriser — and rebuilt
deterministically from source as v4 atlases (``size`` and ``extraRows`` in
``pet.json``).
"""

from __future__ import annotations

import sys
from pathlib import Path

# The package imports `agent.pet.constants`; make the repo importable no matter
# where the interpreter was started (python -m from the root, or the shim).
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
