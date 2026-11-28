# Work S6 design authoring

Work can hand Desktop an editable HTML flyer or SVG diagram. Desktop creates
a companion PNG from the validated source and uses the S1 native Drive
importer for both files. Revisions use a fresh run output folder and artifact
ID in the same thread. A second `Design.html` becomes `Design (2).html` with
`Design (2).html.png`. Source and preview use separate durable placement
intents. A replay resumes missing placement and reuses the preview already
prepared for that source. Both Drive journal entries need a server resource
and ETag before Desktop reports the pair saved.

## Validation and rendering

The Drive helper validates the no-follow, same-volume copy before publishing
either file. The source must be UTF-8 and at most 512 KiB. HTML uses static,
XML-compatible markup with an explicit UTF-8 declaration, head and body,
inline CSS, and a single
1200 × 1600 page. The HTML preview rejects overflowing pages. Static SVG
uses integer width and height, at most 2048 px each. The allowlist rejects
scripts, event attributes, external references and embedded documents.
Inline styles and local SVG fragment references support editable design
without fetched assets. The generated PNG must be nonempty, at most 8 MiB,
and match the expected dimensions.

HTML uses Electron's offscreen BrowserWindow and capturePage. If the
compositor copy fails after a successful paint, it uses that same offscreen
frame. Its in-memory session allows only the exact temporary document as a
main-frame request.
It has sandboxing, no preload, no Node integration and JavaScript disabled.
SVG uses the upstream resvg 0.50.0 CLI with system fonts. Runtime staging
verifies the archive and executable hashes for both Mac architectures and
includes the MIT and Apache-2.0 notices. See
[`resvg-lock.json`](../apps/desktop/scripts/work-design/resvg-lock.json) and
the [upstream release](https://github.com/linebender/resvg/releases/tag/v0.50.0).
The bundled `work-design` skill adapts the MIT-licensed Hermes Agent
HTML, brand token and concept diagram guidance.

## Work runtime contract

Desktop passes `ATUM_WORK_DESIGN_SKILL` to the Work server when the staged
skill exists. A matching Work server needs to load it for its Design starter
and use S1's private pin and settlement channel. Pin a fresh artifact ID and
output directory for each turn, then send the explicit relative source path
in `result: { path: 'Design.html', format: 'html', preview: null }` or its
SVG equivalent. Desktop owns raster generation. The receipt adds
`previewName`; open the source with the existing receipt identity and the
preview with the same identity plus `asset: 'preview'`.

The pinned Work 0.1.21 runtime creates a Design starter and only settles
DOCX. Connecting the Design starter to output admission, finalization and
the receipt UI requires a companion Work runtime change. Desktop's fixture
exercises the private protocol with a simulated enrolled Drive journal.

## Verify locally

```sh
cd apps/desktop
WORK_DESIGN_ELECTRON=/path/to/Electron WORK_DESIGN_RESVG=/path/to/resvg \
  ../../node_modules/.bin/vitest run --project electron \
  electron/matrix/work-design-formats.test.ts electron/matrix/work-deliverable.test.ts
```

Use the repository's pinned Electron and the matching resvg pin above. The
tests check malformed, active, external and oversized input, real HTML and
SVG raster output, quota interruption, partial sync, replay, and a
same-thread title-size revision that preserves the original.
