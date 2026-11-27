# Work S4 and S5 authoring

Desktop runtime staging adds hash-locked native Office libraries to the CPython
3.14 environment and stages `validate-xlsx.py` and `validate-pptx.py` under
`runtime/work-authoring`. The runtime manifest records the new lock and script
digests. The existing DOCX dependencies and manifest fields remain compatible.

## Validation

- **XLSX.** Author a workbook with openpyxl. Convert it to XLSX in a separate
  directory using LibreOffice Calc and a new temporary profile. Run
  `python -I -B validate-xlsx.py source.xlsx recalculated.xlsx totals.json`.
  The JSON maps sheet names and formula cell addresses to independently known
  numbers. The validator compares sheet order, tokenized formulas at their
  original addresses, table names and ranges, and chart types and series
  references. It reads the recalculated cell cache for known totals and formula
  errors. Calc's proof copy is disposable. Keep the original workbook for editing.
- **PPTX.** Author from the supplied PPTX with python-pptx. Export to PDF with
  LibreOffice Impress using a temporary profile. Run
  `python -I -B validate-pptx.py deck.pptx template.pptx proof.pdf slides.json`.
  Each manifest entry specifies zero-based `master` and `layout` indices,
  the expected editable `text` in shape order, and `notes`. The gate checks
  template layout, master and theme parts, slide and proof page count, notes,
  text frames, an editable AutoShape per slide, canvas bounds, a 4.5:1 contrast
  floor, and expected text on each rendered page. The contrast gate covers
  explicit RGB text on solid RGB fills and inherited solid slide backgrounds.
  Inspect each rendered page for layout and overlap.

## Asset provenance

| Asset | License and notice | SHA-256 |
| --- | --- | --- |
| [openpyxl 3.1.5 wheel](https://pypi.org/project/openpyxl/3.1.5/) | MIT, `openpyxl-3.1.5.dist-info/LICENCE.rst` | `5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2` |
| [et-xmlfile 2.0.0 wheel](https://pypi.org/project/et-xmlfile/2.0.0/) | MIT and PSF notices, `et_xmlfile-2.0.0.dist-info/LICENCE.rst` and `LICENCE.python` | `7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa` |
| [python-pptx 1.0.2 wheel](https://pypi.org/project/python-pptx/1.0.2/) | MIT, `python_pptx-1.0.2.dist-info/LICENSE` | `160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba` |
| [XlsxWriter 3.2.9 wheel](https://pypi.org/project/XlsxWriter/3.2.9/) | BSD-2-Clause, `xlsxwriter-3.2.9.dist-info/LICENSE.txt`. Required by python-pptx. | `9a5db42bc5dff014806c58a20b9eae7322a134abb6fce3c92c181bfb275ec5b3` |
| Pillow 13.0.0 CPython 3.14 macOS wheels | MIT-CMU and component notices, `pillow-13.0.0.dist-info/licenses/`. Existing `uv.lock` pin. | arm64 `d9b0a2bee3f3e03e9f29057aedb807dbf1e1d96ee1b9d0f422d9db6c8583271d`, x64 `49c12af515073e9bf511e4ef736743bf70d531a643668722279314b937742ba4` |
| defusedxml 0.7.1 wheel | PSF-2.0, `defusedxml-0.7.1.dist-info/LICENSE`. Existing `uv.lock` pin used by openpyxl. | `a352e7e428770286cc899e2542b6cdaedb2b4953ff269a210103ec58f6198a61` |
| python-pptx template files | MIT, same wheel notice. | `default.pptx` `e10cc9e120961f6bd4074a373c9c80d2a06c497157e8f4972977b7bea83a8f34`, `notes.xml` `a8f14f275cf7616e15c61216afe36aac706c3e7c7c4e987bd433c65809110d03`, `notesMaster.xml` `1fb939714ad0571d747d9e573f9a0594062a89e73c6a076d943ba7f541072813`, `theme.xml` `76f7bdf39e5333483e42f9c4f6eba344330617b6e6171b7a4039c239131a9b4d` |
| `work-budget-template.pptx` | Test-only adaptation of the python-pptx default template. See `work-budget-template.LICENSE.txt` for the MIT notice. Rebuild with `work-office-fixture.py template <new file>`. | `e863c10fcdf5bd157f22a57a5c9865d46b31faa59c3fff710728fa83fe41a8c4` |
| Format requirements and validators | Repository source. Values also recorded in the runtime manifest. | Lock `d9a4e20540f385e623837d686954ad3c7b225acf8023476476a78a9c55847f27`, XLSX `c877697056ae0b9cd4cab4ad2f8d49076a4183ded1714ac3651d14b1d55b0b76`, PPTX `0629b32ce1b6ee51e5e98075b710cf907a88543b57bd725cb14022a93af74390` |

The reused lxml and typing-extensions wheels and the LibreOffice 26.8.3 arm64
proof DMG are documented in [S1](work-cowork-s1-desktop.md). The proof rendered
with the DMG's Liberation Sans fonts under SIL OFL 1.1, Regular
`76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8` and Bold
`788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173`.
Poppler 26.08.0 utilities ran locally for this proof. See
[Poppler upstream](https://poppler.freedesktop.org/) for its GPL notices.
The local arm64 `pdftotext` digest was
`e8fb86921c589674ee6ba880594e9dd3dba4d471d2b7c7fdb00eac55975db25a` and
`pdftoppm` was `ab4c415cb29a229b039221de9af5a4ba539acc1aebd3a3a0a6dd677d11093c8e`.

## Dry runs

Set `WORK_OFFICE_PYTHON` to an isolated interpreter containing the wheel pins,
`WORK_OFFICE_SOFFICE` to the verified LibreOffice executable, and put
`pdftotext` on PATH. From `apps/desktop` run:

```sh
../../node_modules/.bin/vitest run --project electron electron/matrix/work-office-formats.test.ts
```

The CSV fixture generates a budget with two sheets and opens it in Calc.
The revision changes one input in a separate XLSX via openpyxl and reopens it
in Calc. Planned spending moves from $6,000 to $6,200, actual stays at $5,750,
and remaining moves from $250 to $450. The five-slide fixture reuses its
supplied master and receives a one-line revision on slide two. Both original
files stay byte-identical after saving revisions. All ten rendered pages were
inspected locally.

Installed acceptance still needs the Work authoring skill and settlement
integration for both formats, provider-run revisions, and a clean signed Mac
with verified LibreOffice delivery and a shipped PDF proof reader. The S1
receiver currently admits DOCX only. These validators are quality checks for
local generated artifacts. Placement needs format-aware package admission
before accepting XLSX or PPTX bytes into Drive.
