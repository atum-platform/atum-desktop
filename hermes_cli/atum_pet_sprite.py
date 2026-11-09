"""Read a shipped pet for a cold desktop. Never installs or selects a pet."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from agent.pet.payload import _pet_sprite_payload
from agent.pet.store import _pet_in

BUNDLED = ("gigi", "cookie", "bailey", "mochi")


def _read_sprite(root: Path, slug: str, scale: float, *, bundled: bool) -> dict:
    if (bundled and slug not in BUNDLED) or not math.isfinite(scale) or not 0.1 <= scale <= 3:
        raise ValueError("matrix_pet_asset_unavailable")
    root = root.resolve(strict=True)
    directory = root / slug
    if directory.is_symlink() or directory.resolve(strict=True).parent != root:
        raise ValueError("matrix_pet_asset_unavailable")
    manifest = directory / "pet.json"
    if manifest.is_symlink() or manifest.stat().st_size > 32768:
        raise ValueError("matrix_pet_asset_unavailable")
    pet = _pet_in(slug, directory)
    if (
        pet is None
        or pet.spritesheet.is_symlink()
        or pet.spritesheet.resolve(strict=True).parent != directory
        or pet.spritesheet.stat().st_size > 4 * 1024 * 1024
    ):
        raise ValueError("matrix_pet_asset_unavailable")
    from PIL import Image

    with Image.open(pet.spritesheet) as image:
        if image.format not in ("PNG", "WEBP") or not (
            192 <= image.width <= 4096 and 208 <= image.height <= 4096
        ):
            raise ValueError("matrix_pet_asset_unavailable")
        image.verify()
    return {"enabled": True, **_pet_sprite_payload(pet, scale=scale)}


def read_bundled_sprite(root: Path, slug: str, scale: float) -> dict:
    return _read_sprite(root, slug, scale, bundled=True)


def read_personal_sprite(root: Path, slug: str, scale: float) -> dict:
    """Read a main-materialised personal bundle; no profile or pet store access."""
    return _read_sprite(root, slug, scale, bundled=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--scale", type=float, required=True)
    parser.add_argument("--personal", action="store_true")
    args = parser.parse_args()
    try:
        reader = read_personal_sprite if args.personal else read_bundled_sprite
        print(json.dumps(reader(args.root, args.slug, args.scale)))
    except (OSError, ValueError):
        raise SystemExit("matrix_pet_asset_unavailable") from None


if __name__ == "__main__":
    main()
