# Work S1 desktop deliverables

## Native settlement contract

Work sends admission and settlement over the private Node IPC channel also used
for update trials. The Python supervisor passes that channel only to the Work
server. Desktop accepts messages from its current, committed sidecar while the
owning account generation remains active. The renderer can only look up a receipt
or open a saved file.

When Desktop starts Work in desktop mode, the same supervisor connection carries
Node IPC on descriptor 3 and the updater's report and control streams on
descriptors 4 and 5. Work can settle a deliverable after desktop-mode readiness
without interrupting updater commands.

```ts
type Identity = { threadId: string; runId: string; artifactId: string }
type Pin = Identity & { type: 'work-deliverable-pin'; outputRoot: string }
type Settle = Identity & {
  type: 'work-deliverable-settled'
  result: { path: string; format: 'docx'; preview: null }
}
```

The sidecar creates `.work-output-<artifact UUID>` inside its managed Scratch
thread folder before dispatch. Desktop checks ownership, directory identity and
containment. A standalone S1 thread uses the sole active assistant in the
owner's roster. The workspace RPC verifies the assistant's enrolled
`Agents/<agent>/deliverables` directory. Multiple active assistants need a
thread-to-assistant binding before Drive can admit the run. Desktop persists
the admission under the account before replying with
`{ type: 'work-deliverable-pinned', artifactId, accepted }`. Failed admission
leaves the file in Work. The server receives the bundled memo interpreter and
helper paths via `ATUM_WORK_MEMO_PYTHON` and `ATUM_WORK_MEMO_SCRIPT`.

The settled `result.path` is relative to that run's output directory. It is the
Work file reference with the path already normalized by the server. The S1 wire
contract uses a null preview. Desktop stores the settled result before invoking
the receiver and replies with `{ type: 'work-deliverable-ack', artifactId, status }`.
Replay the original settlement to retry placement. A revision gets a new artifact
ID. The embedded thread reads `window.atumWork.getDeliverable(identity)` to follow
the current state. The existing Work result card can show **Open in Drive** when
the state is `saved` and call `window.atumWork.openDeliverable(identity)`. The
opener rechecks the journal and resolves a current opaque Drive row. The card
belongs to the Work UI lane.

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

The tests round-trip a fixture over the supervisor's private Node channel and
exercise native placement, status acknowledgement, Open in Drive, and duplicate
replay with a simulated OpenCloud journal. Release acceptance needs the matching Work build, a signed
or verified automatic LibreOffice install, a clean signed Mac, a real Claude
subscription turn, and OpenCloud sync verified from a second signed-in client.
The import stage needs to share the destination volume. A restart before the
first durable native placement intent leaves the original output in Work.
XLSX, PPTX, design, and serving previews are later slices.
