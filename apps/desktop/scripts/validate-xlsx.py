"""Compare an editable XLSX with a recalculated LibreOffice copy."""

import argparse
import json
import math
import re
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.formula import Tokenizer


def canonical_reference(value):
    # Calc may quote a simple worksheet name that Excel leaves unquoted.
    return re.sub(r"^'([A-Za-z_][A-Za-z0-9_.]*)'!", r"\1!", value)


def formula_tokens(formula):
    return tuple(
        (token.type, token.subtype,
         canonical_reference(token.value) if token.subtype == "RANGE" else token.value)
        for token in Tokenizer(formula).items
    )


def formulas(sheet):
    result = {}
    # Inspect populated cells only. Iterating the used rectangle can allocate
    # millions of blank cells for an otherwise sparse workbook.
    for cell in sheet._cells.values():
        if cell.data_type != "f":
            continue
        value = cell.value
        if isinstance(value, str):
            result[cell.coordinate] = formula_tokens(value)
        else:
            # Array and data-table formulas are openpyxl descriptors.
            text = getattr(value, "text", None)
            result[cell.coordinate] = (type(value).__name__, dict(value), formula_tokens(text) if text else None)
    return result


def series_references(series):
    references = {}
    for role in ("cat", "val", "xVal", "yVal", "bubbleSize"):
        data = getattr(series, role, None)
        for field in ("numRef", "strRef", "multiLvlStrRef"):
            reference = getattr(data, field, None)
            if reference is not None:
                # The source can be represented as numeric or string categories.
                references[role] = canonical_reference(reference.f)
                break
    return references


def charts(sheet):
    # openpyxl exposes chart construction publicly but stores loaded charts
    # and the plot groups of combined charts in these collections.
    return [
        [(type(plot).__name__, getattr(plot, "type", None), list(map(series_references, plot.series)))
         for plot in chart._charts]
        for chart in sheet._charts
    ]


def tables(sheet):
    return {table.name: table.ref for table in sheet.tables.values()}


def validate(source, proof, totals):
    if source.samefile(proof):
        raise ValueError("Recalculation must use a separate workbook copy")
    if not totals or any(not cells for cells in totals.values()):
        raise ValueError("Supply at least one known formula result")
    original = load_workbook(source, keep_links=False)
    recalculated = load_workbook(proof, keep_links=False)
    cached = load_workbook(proof, data_only=True, keep_links=False)
    try:
        if original.sheetnames != recalculated.sheetnames or not all(
            name in original.sheetnames for name in totals
        ):
            raise ValueError("Workbook sheets do not match the proof and expectations")

        editable_chart = False
        editable_table = False
        for before, after in zip(original, recalculated, strict=True):
            before_formulas = formulas(before)
            if before_formulas != formulas(after):
                raise ValueError(f"Formula tree changed on {before.title}")

            before_charts = charts(before)
            if before_charts != charts(after):
                raise ValueError(f"Chart structure changed on {before.title}")
            editable_chart |= any(
                {"val", "xVal", "yVal"} & refs.keys()
                for chart in before_charts for _, _, series in chart for refs in series
            )
            before_tables = tables(before)
            if before_tables != tables(after):
                raise ValueError(f"Table structure changed on {before.title}")
            editable_table |= bool(before_tables)

            for cell in before_formulas:
                if cached[before.title][cell].data_type == "e":
                    raise ValueError(f"Calc returned an error in {before.title}!{cell}")
            for cell, expected in totals.get(before.title, {}).items():
                actual = cached[before.title][cell].value
                if (cell not in before_formulas or type(expected) not in (int, float)
                        or type(actual) not in (int, float) or not math.isfinite(expected)
                        or not math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-9)):
                    raise ValueError(f"Unexpected recalculated result in {before.title}!{cell}")

        if not editable_chart:
            raise ValueError("Workbook must contain a chart with cell-backed values")
        if not editable_table:
            raise ValueError("Workbook must contain an editable table")
    finally:
        original.close()
        recalculated.close()
        cached.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("recalculated", type=Path, help="Separate workbook saved by LibreOffice Calc")
    parser.add_argument("totals", type=Path, help='JSON known results, for example {"Summary":{"B2":1200}}')
    args = parser.parse_args()
    validate(args.source, args.recalculated, json.loads(args.totals.read_text(encoding="utf-8")))


if __name__ == "__main__":
    main()
