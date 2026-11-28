---
name: work-design
description: Create and revise standalone branded flyers and editable diagrams in Work.
---

Use the requested brand guide or `DESIGN.md` for colors, typography, and spacing.
Choose one visual hierarchy for the brief, with a clearly readable title.
Use a small palette that distinguishes categories in diagrams. Keep labels as
editable text and use SVG arrow markers and shapes for connections.

Use the host's private output folder for this turn. Write one UTF-8
`Design.html` or `Design.svg` file, at most 512 KiB. For HTML use
`<!doctype html>`, one `html` element with explicit `head` and `body`,
quoted attributes, paired tags and XML-compatible void tags. Start the head
with `<meta charset="utf-8" />`. Keep CSS inline and fit the page in a 1200 × 1600
pixel viewport without scrolling. For SVG set the standard SVG namespace
and explicit width and height in pixels, each between 1 and 2048. Use the same
namespace on any inline SVG in HTML.

Use static markup, system fonts and local SVG shapes. Keep graphics within the
canvas. Use fragment references such as `url(#arrow)` for SVG paint servers
and use `@media` for responsive layouts. The host rejects scripts, event
handlers, embedded documents, external resources and imports. The host creates
the PNG from the validated editable file at settlement.

For a revision, read the earlier editable copy as input and write the result in
the new output folder for this turn. Keep earlier copies intact.

Design guidance draws on the MIT-licensed Hermes Agent skills
`claude-design`, `design-md`, and `concept-diagrams`.
