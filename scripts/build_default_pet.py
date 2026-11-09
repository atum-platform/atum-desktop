#!/usr/bin/env python3
"""Build Gigi, Atum's default pet.

Kept as the entry point this asset has always had; the model, the poses and
the atlas layout now live in ``scripts/pets`` (one spec per breed, shared
everything else — see ``scripts/pets/breeds.py``). This is ``python -m
scripts.pets gigi [outdir]`` with the old name.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.pets.sheet import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(["gigi", *sys.argv[1:]]))
