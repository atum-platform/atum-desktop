"""Create an editable Work memo with the bundled python-docx runtime."""

import argparse
import json
from pathlib import Path

from docx import Document


def write_memo(memo, output):
    document = Document()
    document.core_properties.title = memo["title"]
    document.add_heading(memo["title"], 0)
    for section in memo["sections"]:
        if section.get("page_break"):
            document.add_page_break()
        document.add_heading(section["heading"], level=1)
        for paragraph in section.get("paragraphs", []):
            document.add_paragraph(paragraph)
        if "table" in section:
            headers = section["table"]["headers"]
            table = document.add_table(rows=1, cols=len(headers), style="Table Grid")
            for cell, text in zip(table.rows[0].cells, headers, strict=True):
                cell.text = text
                cell.paragraphs[0].runs[0].bold = True
            for row in section["table"]["rows"]:
                for cell, text in zip(table.add_row().cells, row, strict=True):
                    cell.text = text
    with output.open("xb") as handle:
        document.save(handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("memo", type=Path, help="Memo content as JSON")
    parser.add_argument("output", type=Path, help="New .docx under the run output directory")
    args = parser.parse_args()
    if args.output.suffix.lower() != ".docx":
        parser.error("output must end in .docx")
    write_memo(json.loads(args.memo.read_text(encoding="utf-8")), args.output)


if __name__ == "__main__":
    main()
