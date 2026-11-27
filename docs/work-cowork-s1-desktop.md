# Work S1 desktop deliverables

## Native settlement contract

At run admission, the trusted local Work host calls
`MatrixWork.deliverables.pin(artifactId, agentPrincipal, outputRoot)` and stores
the returned scope with its run. The host creates the artifact UUID and the
private output directory. The assistant principal comes from the authenticated
thread binding. Desktop resolves the assistant's workspace through the existing
owner workspace RPC and checks for its existing `Agents/<agent>/deliverables`
directory under the enrolled Drive binding.

At successful settlement, with the producer stopped, the native host supplies one
explicit result for S1. The payload is identical across providers.

```json
{
  "path": "Weekly memo.docx",
  "format": "docx",
  "preview": null
}
```

`path` is a relative, normalized path within the managed run output directory.
`preview` is required and nullable. The optional PDF shape is
`{"path":"Weekly memo.pdf","format":"pdf"}`. S1 keeps render proofs local and
returns `null`. Desktop checks the optional shape. A preview stays in the private
output directory and is never copied or opened by this receiver. Formats beyond
DOCX will need their own validators and explicit contract versions.

The host calls `receive(scope, result, signal)` for placement and an explicit save
retry. The host can call `status(scope, result, signal)` to check for sync or to
reconcile after interruption without a placement. Reuse the original artifact ID,
scope and result on retry. Give an edited copy a new artifact ID. Present only
the projected state, name and artifact ID. Bind Open in Drive to that ID in the
owning run and call `open(scope, result)` on the main-side receiver. The open
rechecks sync and resolves a current opaque Drive row using the native opener.

The importer holds no-follow descriptors for the output and destination, copies
bounded bytes into the same-volume private import area, validates the S1 DOCX
package and records the digest, chosen sibling name and staged inode before
exclusive rename. The intent survives a process restart. Reconciliation fences
the current generation and requires the same owner binding, scope, inode and
digest at the recorded name. A scope from an earlier process can only recover a
recorded intent. If placement is
uncertain and the recorded file has moved or changed, the receiver returns
`changed`. A clean journal result with a server resource and ETag, plus a
second check of the placed bytes, gives `saved`. The negotiated Drive quota is
checked before placement. OpenCloud continues to sync normally.

## Authoring and provenance

Desktop runtime staging installs one additional hash-locked wheel. It uses the
existing bundled CPython 3.14 runtime and existing Hermes wheels for lxml and
typing-extensions. The runtime copies the memo helper to
`runtime/work-authoring/memo.py`; invoke it with the bundled interpreter
`-I -B`, a JSON content file and a new output filename. The JSON has a
`title` and `sections`, each with a `heading` and optional `page_break`,
`paragraphs`, and `table` with `headers` and `rows`. The helper writes native
Word paragraphs, headings and tables with python-docx's bundled template.

| Asset | License and notice | SHA-256 |
| --- | --- | --- |
| [python-docx 1.2.0 wheel](https://pypi.org/project/python-docx/1.2.0/) | MIT, `python_docx-1.2.0.dist-info/licenses/LICENSE` | `3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7` |
| python-docx default template | Same wheel and notice | `2094b5bddffe9cf973d61fe03388413804f034160718494a65db7e98da40d35d` |
| lxml 6.1.1 CPython 3.14 macOS universal2 wheel | BSD-3-Clause and bundled component notices, `lxml-6.1.1.dist-info/licenses/` | `19b7ab10b210b0b3ad7985d9ac4eb66ab09a90b20fe6e2f7ba55d01a234345d0` |
| lxml 6.1.1 CPython 3.14 macOS x64 wheel | Same lxml notices | `c08e5c694306507275f2290073350c4f32e383db15213b2c69e7ff39c1193840` |
| typing-extensions 4.16.0 wheel | PSF-2.0, `typing_extensions-4.16.0.dist-info/licenses/LICENSE` | `481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8` |
| Memo helper and dependency pin | Repository source, digests emitted in the staged runtime manifest | `57fe840224c1d1e3bf2fc5f51ca10b091ceab2f1fb3d36237179e87a107b5591` and `830ed8c7bcb38711a86b2794ad3f5a5a02ca67142685db847d0431fcd82e8199` |
| [LibreOffice 26.8.3 arm64 test DMG](https://download.documentfoundation.org/libreoffice/stable/26.8.3/mac/aarch64/LibreOffice_26.8.3_MacOS_aarch64.dmg.mirrorlist) | MPL-2.0 and component notices in the upstream app. Local proof tool. | `de943203795e5057785f65515063e2db5eb60b0bb6d8e2534fec59e5cc5fb988` |

## Dry run and installed handoff

From `apps/desktop`, run the focused Vitest test with
`WORK_DOCX_PYTHON` set to an isolated or bundled interpreter containing those
wheels. Set `WORK_DOCX_SOFFICE` to a verified LibreOffice executable to render
with a temporary profile and check the expected two pages with `pdftotext`.

```sh
../../node_modules/.bin/vitest run --project electron electron/matrix/work-deliverable.test.ts
```

The dry run uses real local placement and synthesizes the OpenCloud journal
response. Release acceptance still needs native Work to deliver the authenticated
settlement, persist its scope, provision the user-facing authoring skill and
connect the result UI. It also needs signed or verified automatic LibreOffice
delivery, a clean signed Mac, a real Claude subscription turn, real OpenCloud
sync and verification from a second signed-in client. Cross-volume enrollments
currently require the import staging area to share the destination volume.
XLSX, PPTX, design, and serving previews are later slices.
