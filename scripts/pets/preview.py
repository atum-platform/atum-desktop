"""Static Store previews of the four house dogs, rendered from their voxel models.

The Store card and detail panel show each dog as a still portrait instead of a
generic paw. The portrait is the first ``idle`` frame of the shipped atlas —
the same pose the pet rests in on screen — trimmed to the dog and enlarged with
nearest-neighbour sampling so the voxels stay crisp.

    python -m scripts.pets.preview            # every breed, into the renderer assets
    python -m scripts.pets.preview gigi OUT   # one breed, into OUT

Deterministic: same source, same bytes. No new art is drawn here.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

from scripts.pets.breeds import BREEDS
from scripts.pets.sheet import FRAMES_PER_ROW, REPO_ROOT, frame_for, model_for

DEFAULT_OUT = REPO_ROOT / "apps" / "desktop" / "src" / "assets" / "pets"
# Transparent breathing room around the trimmed dog, in source pixels.
PAD = 4
# Integer upscale keeps every voxel edge sharp at the panel size (~136px tall).
UPSCALE = 2


def idle_cell(slug: str) -> Image.Image:
    """The atlas's first idle cell for *slug*, exactly as the sheet builder draws it."""
    return frame_for(model_for(BREEDS[slug]), "idle", 0, FRAMES_PER_ROW["idle"])


def portrait(cell: Image.Image) -> Image.Image:
    """Trim a cell to its opaque pixels, pad it, and enlarge it without smoothing."""
    box = cell.getchannel("A").getbbox()
    if box is None:
        raise ValueError("empty pet frame")
    left, top, right, bottom = box
    trimmed = cell.crop((left - PAD, top - PAD, right + PAD, bottom + PAD))
    return trimmed.resize((trimmed.width * UPSCALE, trimmed.height * UPSCALE), Image.NEAREST)


def write_preview(slug: str, out_root: Path) -> Path:
    out_root.mkdir(parents=True, exist_ok=True)
    path = out_root / f"{slug}-preview.webp"
    portrait(idle_cell(slug)).save(path, "WEBP", lossless=True, quality=100, method=6)
    print(f"{slug}: wrote {path} {path.stat().st_size / 1024:.0f} KiB")
    return path


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    which = args[0] if args else "all"
    out_root = Path(args[1]) if len(args) > 1 else DEFAULT_OUT
    slugs = sorted(BREEDS) if which == "all" else [which]
    unknown = [s for s in slugs if s not in BREEDS]
    if unknown:
        print(f"unknown breed(s): {', '.join(unknown)}; known: {', '.join(sorted(BREEDS))}", file=sys.stderr)
        return 2
    for slug in slugs:
        write_preview(slug, out_root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
