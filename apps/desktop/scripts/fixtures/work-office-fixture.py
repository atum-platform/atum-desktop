"""Author and revise synthetic S4 and S5 acceptance fixtures with native Office objects."""

import argparse
import csv
import json
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.worksheet.table import Table, TableStyleInfo
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE
from pptx.util import Inches, Pt


def budget(source):
    book = Workbook()
    inputs = book.active
    inputs.title = "Budget"
    inputs.append(["Category", "Planned", "Actual"])
    with source.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            inputs.append([row["Category"], int(row["Planned"]), int(row["Actual"])])
    table = Table(displayName="BudgetInputs", ref=inputs.dimensions)
    table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
    inputs.add_table(table)
    inputs.column_dimensions["A"].width = 20

    summary = book.create_sheet("Summary")
    summary.append(["Metric", "Amount"])
    summary.append(["Planned", f"=SUM(Budget!B2:B{inputs.max_row})"])
    summary.append(["Actual", f"=SUM(Budget!C2:C{inputs.max_row})"])
    summary.append(["Remaining", "=B2-B3"])
    summary.column_dimensions["A"].width = 20
    chart = BarChart()
    chart.title = "Planned and actual by category"
    chart.add_data(Reference(inputs, min_col=2, max_col=3, min_row=1, max_row=inputs.max_row), titles_from_data=True)
    chart.set_categories(Reference(inputs, min_col=1, min_row=2, max_row=inputs.max_row))
    summary.add_chart(chart, "D2")
    return book


def template():
    deck = Presentation()
    deck.slide_width = Inches(13.333)
    deck.slide_height = Inches(7.5)
    deck.slide_layouts[6].name = "Quarterly budget"
    background = deck.slide_masters[0].background.fill
    background.solid()
    background.fore_color.rgb = RGBColor.from_string("F3F5FA")
    return deck


def set_text(shape, text, color, size, bold=False):
    shape.text = text
    run = shape.text_frame.paragraphs[0].runs[0]
    run.font.name = "Liberation Sans"
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)


def presentation(source, content):
    deck = Presentation(source)
    for spec in content:
        title, body, metric = spec["text"]
        slide = deck.slides.add_slide(deck.slide_masters[spec["master"]].slide_layouts[spec["layout"]])
        title_shape = slide.shapes.add_textbox(Inches(0.9), Inches(1.0), Inches(11.5), Inches(0.9))
        body_shape = slide.shapes.add_textbox(Inches(0.9), Inches(2.2), Inches(11.5), Inches(0.8))
        metric_shape = slide.shapes.add_shape(
            MSO_AUTO_SHAPE_TYPE.RECTANGLE, Inches(0.9), Inches(3.55), Inches(5.0), Inches(0.9),
        )
        metric_shape.fill.solid()
        metric_shape.fill.fore_color.rgb = RGBColor.from_string("233758")
        metric_shape.line.fill.background()
        set_text(title_shape, title, "182A46", 42, bold=True)
        set_text(body_shape, body, "243854", 26)
        set_text(metric_shape, metric, "FFFFFF", 24, bold=True)
        slide.notes_slide.notes_text_frame.text = spec["notes"]
    return deck


def edit_budget(source, change):
    book = load_workbook(source)
    if change == "input":
        book["Budget"]["B3"] = 1400
    elif change == "formula":
        book["Summary"]["B4"] = 250
    elif change == "chart":
        book["Summary"]._charts.clear()
    return book


def edit_deck(source, change):
    deck = Presentation(source)
    slide = deck.slides[1]
    if change == "revise":
        set_text(slide.shapes[1], "Advance orders kept staffing below plan.", "243854", 26)
    elif change == "contrast":
        set_text(slide.shapes[1], slide.shapes[1].text, "F3F5FA", 26)
    elif change == "bounds":
        slide.shapes[1].left = deck.slide_width
    elif change == "notes":
        slide.notes_slide.notes_text_frame.clear()
    elif change == "master":
        slide.slide_layout.slide_master.background.fill.fore_color.rgb = RGBColor.from_string("FFFFFF")
    return deck


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("budget", "template", "deck", "edit-budget", "edit-deck"))
    parser.add_argument("output", type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--content", type=Path)
    parser.add_argument("--change", choices=("input", "formula", "chart", "revise", "contrast", "bounds", "notes", "master"))
    args = parser.parse_args()
    if args.operation == "budget":
        document = budget(args.source)
    elif args.operation == "template":
        document = template()
    elif args.operation == "deck":
        document = presentation(args.source, json.loads(args.content.read_text(encoding="utf-8")))
    elif args.operation == "edit-budget":
        document = edit_budget(args.source, args.change)
    else:
        document = edit_deck(args.source, args.change)
    with args.output.open("xb") as output:
        document.save(output)


if __name__ == "__main__":
    main()
