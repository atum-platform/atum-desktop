"""Render the PT-6 stills and silhouette measurements, never an animation atlas.

Run ``python -m scripts.pets.contact_sheet`` from the repository root. The
comparison uses the existing 192 x 208 cells; only the presentation sheet
scales the visible silhouette to the target standing height.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from scripts.pets.breeds import APPROVED_BREEDS
from scripts.pets.sheet import FRAMES_PER_ROW, frame_for, model_for
from scripts.pets.voxel import assert_unclipped

OUT = Path(__file__).resolve().parents[2] / ".artifacts/pet-contact-sheets"
HEIGHTS = {"gigi": 96, "cookie": 90, "mochi": 100, "bailey": 210}
ORDER = tuple(HEIGHTS)


def silhouette(frame: Image.Image) -> set[int]:
    return {i for i, alpha in enumerate(frame.getchannel("A").tobytes()) if alpha}


def render_stills(out: Path = OUT) -> dict:
    """Produce idle and one walk still per dog, and a reproducible IoU table."""
    out.mkdir(parents=True, exist_ok=True)
    frames = {}
    masks = {}
    for slug in ORDER:
        model = model_for(APPROVED_BREEDS[slug])
        for label, row, index in (("idle", "idle", 0), ("walk", "running-left", 2)):
            frame = frame_for(model, row, index, FRAMES_PER_ROW[row])
            assert_unclipped(frame, f"{slug} {label} still")
            frame.save(out / f"{slug}-{label}.png")
            frames[slug, label] = frame
            if label == "idle":
                masks[slug] = silhouette(frame)

    matrix = {
        a: {b: round(len(masks[a] & masks[b]) / len(masks[a] | masks[b]), 6)
            for b in ORDER} for a in ORDER
    }
    measurements = {
        "metric": "Idle-frame opaque-pixel intersection over union, unscaled 192 x 208 cells",
        "targetMaxIoU": 0.6,
        "standingHeightPt": HEIGHTS,
        "iou": matrix,
        "approval": "Public artwork reference; no owner acceptance receipt is included.",
    }
    (out / "measurements.json").write_text(
        json.dumps(measurements, indent=2) + "\n", encoding="utf-8"
    )

    # A neutral plate and a common ground line make the approved size ratio
    # visible without changing a single sprite cell or shipped pet asset.
    sheet = Image.new("RGBA", (1260, 780), (239, 242, 246, 255))
    draw = ImageDraw.Draw(sheet)
    title = ImageFont.load_default(size=25)
    label_font = ImageFont.load_default(size=18)
    detail_font = ImageFont.load_default(size=15)
    draw.text((32, 22), "Mochi & Bailey: draft stills for approval", font=title, fill=(27, 32, 44))
    draw.text((32, 58), "Gigi 96 pt · Cookie 90 pt · Mochi 100 pt · Bailey 210 pt", font=detail_font, fill=(75, 83, 96))
    draw.text((32, 82), "Proposed visible standing sizes at scale 1; no shipped asset changes", font=detail_font, fill=(75, 83, 96))
    for row_index, label in enumerate(("idle", "walk")):
        ground = 345 + row_index * 320
        draw.text((32, ground - 225), "Idle" if label == "idle" else "One walk frame", font=label_font, fill=(27, 32, 44))
        draw.line((32, ground, 1228, ground), fill=(189, 197, 208), width=1)
        for column, slug in enumerate(ORDER):
            frame = frames[slug, label]
            bbox = frame.getbbox()
            assert bbox is not None
            visible = frame.crop(bbox)
            # Use the idle silhouette as the constant scale for both stills.
            idle_bbox = frames[slug, "idle"].getbbox()
            assert idle_bbox is not None
            factor = HEIGHTS[slug] / (idle_bbox[3] - idle_bbox[1])
            size = (round(visible.width * factor), round(visible.height * factor))
            visible = visible.resize(size, Image.Resampling.NEAREST)
            cx = 157 + column * 315
            sheet.alpha_composite(visible, (cx - size[0] // 2, ground - size[1]))
            name = APPROVED_BREEDS[slug].display_name
            draw.text((cx, ground + 15), name, anchor="mt", font=label_font, fill=(27, 32, 44))
            breed = {"gigi": "Maltese", "cookie": "Yorkshire terrier", "mochi": "White bichon", "bailey": "Bernese Mountain Dog"}[slug]
            draw.text((cx, ground + 40), breed, anchor="mt", font=detail_font, fill=(75, 83, 96))
    sheet.convert("RGB").save(out / "idle-and-walk.png")
    return measurements


if __name__ == "__main__":
    print(json.dumps(render_stills(), indent=2))
