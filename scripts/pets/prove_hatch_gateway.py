#!/usr/bin/env python3
"""Credentialed acceptance harness for the catalog-funded voxel hatch lane.

Run only after a profile has been configured with the managed ``hatch`` alias
and a valid MAS gateway token.  It deliberately reads no secret itself: the
normal profile resolver supplies credentials.  The script creates no pet and
persists no photo; it reports a compact JSON receipt a release operator can
pair with the separately captured wallet-before/wallet-after evidence.
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--count", type=int, default=4, choices=range(1, 5))
    args = parser.parse_args()

    from agent.pet.generate import voxel
    from scripts.pets import spec as petspec

    availability = voxel.voxel_availability()
    if not availability.get("available") or availability.get("mode") != "managed":
        raise SystemExit("managed pet_hatch alias is not available")
    started = time.monotonic()
    design = voxel.design_pets(args.prompt, count=args.count)
    elapsed_ms = round((time.monotonic() - started) * 1000)
    with tempfile.TemporaryDirectory(prefix="atum-hatch-proof-") as temp:
        root = Path(temp)
        previews = []
        for index, pet in enumerate(design.specs):
            preview = petspec.render_preview(pet)
            path = root / f"draft-{index}.png"
            preview.save(path, format="PNG")
            previews.append({"index": index, "bytes": path.stat().st_size})
        sheet = petspec.render_sheet(design.specs[0], slug="proof")
        sheet_path = root / "spritesheet.webp"
        sheet.save(sheet_path, format="WEBP")
        receipt = {
            "ok": True,
            "kind": "voxel",
            "model": design.model,
            "drafts": len(design.specs),
            "repairs": design.repairs,
            "usage": design.usage,
            "latencyMs": elapsed_ms,
            "previews": previews,
            "sheetBytes": sheet_path.stat().st_size,
            "walletEvidence": "capture authenticated wallet before and after separately; this lane must show no customer debit",
        }
    print(json.dumps(receipt, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
