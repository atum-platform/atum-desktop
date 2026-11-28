"""Verify editable slides and their LibreOffice PDF proof against a template."""

import argparse
import json
import math
import subprocess
from pathlib import Path

from pptx import Presentation
from pptx.dml.fill import FillFormat
from pptx.enum.dml import MSO_COLOR_TYPE, MSO_FILL_TYPE
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.opc.constants import RELATIONSHIP_TYPE


def in_bounds(shape, width, height):
    center_x = shape.left + shape.width / 2
    center_y = shape.top + shape.height / 2
    angle = math.radians(shape.rotation % 180)
    half_width = (shape.width * abs(math.cos(angle)) + shape.height * abs(math.sin(angle))) / 2
    half_height = (shape.width * abs(math.sin(angle)) + shape.height * abs(math.cos(angle))) / 2
    return (half_width <= center_x + 1 and center_x + half_width <= width + 1
            and half_height <= center_y + 1 and center_y + half_height <= height + 1)


def luminance(rgb):
    channels = [value / 255 for value in rgb]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722), strict=True))


def solid_rgb(fill):
    if fill.type is not None and fill.type != MSO_FILL_TYPE.BACKGROUND:
        if fill.type != MSO_FILL_TYPE.SOLID or fill.fore_color.type != MSO_COLOR_TYPE.RGB:
            raise ValueError("Contrast proof requires explicit solid RGB backgrounds")
        return fill.fore_color.rgb
    return None


def check_contrast(shape, slide):
    background = solid_rgb(shape.fill)
    if background is None:
        for layer in (slide, slide.slide_layout, slide.slide_layout.slide_master):
            # Accessing layer.background.fill replaces inherited and theme
            # backgrounds with noFill. Inspect the existing properties.
            properties = layer.element.cSld.bg
            if properties is None:
                continue
            if properties.bgPr is None:
                raise ValueError("Contrast proof does not resolve theme background styles")
            background = solid_rgb(FillFormat.from_fill_parent(properties.bgPr))
            if background is not None:
                break
    if background is None:
        raise ValueError("No explicit slide background for contrast proof")
    for paragraph in shape.text_frame.paragraphs:
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            if run.font.color.type != MSO_COLOR_TYPE.RGB:
                raise ValueError("Contrast proof requires explicit RGB text")
            dark, light = sorted((luminance(run.font.color.rgb), luminance(background)))
            if (light + 0.05) / (dark + 0.05) < 4.5:
                raise ValueError("Text contrast is below 4.5:1")


def check_template(slide, template, expected):
    master = slide.slide_layout.slide_master
    source_master = template.slide_masters[expected["master"]]
    source_layout = source_master.slide_layouts[expected["layout"]]
    if (slide.slide_layout.part.blob != source_layout.part.blob or master.part.blob != source_master.part.blob
            or master.part.part_related_by(RELATIONSHIP_TYPE.THEME).blob
            != source_master.part.part_related_by(RELATIONSHIP_TYPE.THEME).blob):
        raise ValueError("Slide does not use the supplied master, layout and theme")


def rendered_pages(proof, pdftotext):
    output = subprocess.run(
        [pdftotext, "-layout", str(proof.resolve()), "-"],
        check=True, capture_output=True, text=True, encoding="utf-8", timeout=30,
    ).stdout
    # Keep empty interior pages so they cannot shift the slide-to-page mapping.
    return output.removesuffix("\f").split("\f")


def validate(source, template_path, proof, expectations, pdftotext):
    deck = Presentation(source)
    template = Presentation(template_path)
    visual_pages = rendered_pages(proof, pdftotext)
    if (not expectations or len(deck.slides) != len(expectations)
            or len(visual_pages) != len(expectations)):
        raise ValueError("Deck and proof must have the expected slide count")
    if (deck.slide_width, deck.slide_height) != (template.slide_width, template.slide_height):
        raise ValueError("Deck canvas differs from the template")

    for index, (slide, expected, page) in enumerate(zip(deck.slides, expectations, visual_pages, strict=True), 1):
        try:
            check_template(slide, template, expected)
            if not slide.has_notes_slide or not expected["notes"].strip():
                raise ValueError("Slide must have speaker notes")
            if slide.notes_slide.notes_text_frame.text != expected["notes"]:
                raise ValueError("Speaker notes differ from the supplied content")
            if any(not in_bounds(shape, deck.slide_width, deck.slide_height) for shape in slide.shapes):
                raise ValueError("A shape extends outside the canvas")

            authored_shapes = [shape for shape in slide.shapes if shape.has_text_frame and shape.text.strip()]
            if not expected["text"] or [shape.text for shape in authored_shapes] != expected["text"]:
                raise ValueError("Expected editable text is missing or changed")
            if not any(shape.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE for shape in authored_shapes):
                raise ValueError("Expected an editable AutoShape with text")
            rendered = " ".join(page.split())
            for shape in authored_shapes:
                check_contrast(shape, slide)
                if " ".join(shape.text.split()) not in rendered:
                    raise ValueError("Editable text is missing from or clipped in the proof")
        except ValueError as error:
            raise ValueError(f"Slide {index}: {error}") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("template", type=Path)
    parser.add_argument("proof", type=Path, help="PDF exported by LibreOffice Impress")
    parser.add_argument("expectations", type=Path, help="Per-slide JSON array of master and layout indices, notes and text")
    parser.add_argument("--pdftotext", default="pdftotext", help="Path to the Poppler pdftotext executable")
    args = parser.parse_args()
    validate(args.source, args.template, args.proof,
             json.loads(args.expectations.read_text(encoding="utf-8")), args.pdftotext)


if __name__ == "__main__":
    main()
