/**
 * docx-markdown.ts
 *
 * Read-only OOXML (`.docx`) → Markdown conversion, entirely in-process.
 *
 * Why this route :
 *  - `soffice --headless --convert-to pdf|html` produces a faithful *print*
 *    render, but LibreOffice is NOT bundled with the packaged app and its HTML
 *    output carries hard-coded Times/black-on-white styling that fights the
 *    app's own tokens (unreadable in dark mode, wrong on a projector).
 *  - The bundled Python runtime ships `lxml`/`defusedxml` for the docx *skill*,
 *    but reaching it from the renderer means spawning a process per render.
 *  - `fflate` is already a dependency and the XML we need is a thin slice of the
 *    format, so unzip → parse → Markdown costs nothing new and reuses the
 *    preview rail's existing Markdown renderer — which is styled with the app's
 *    typography and is therefore the best-looking option on a projector, in
 *    both themes.
 *
 * This is a READ view. It deliberately does not round-trip: styling, headers,
 * footers, and floating shapes are dropped. Structure that carries meaning —
 * headings, bold/italic, lists (bulleted vs numbered), tables — is kept.
 *
 * Where this runs (changed 2026-08-17): the conversion now runs in the ELECTRON
 * MAIN PROCESS — `electron/docx-extract.ts` calls straight into this module and
 * the renderer receives only the finished Markdown. The original route pulled
 * the whole package into the renderer through `hermes:readFileDataUrl`, which
 * base64-expands the file in memory and is hard-capped at 16 MB, so a real
 * 101 MB document failed outright. That is why nothing here may depend on the
 * DOM: XML is parsed by `xml-lite.ts`, which works in both processes.
 */

// `fflate/browser` — the worker-free build. This module is compiled into the
// ELECTRON MAIN bundle too, where the node build's `createRequire` import
// collides with the bundle banner (scripts/bundle-electron-main.test.mjs).
import { strFromU8, unzipSync } from 'fflate/browser'

import type { XmlElement } from './xml-lite'
import { parseXmlDocument, XmlParseError, xmlText } from './xml-lite'

export const DOCX_DOCUMENT_PART = 'word/document.xml'
export const DOCX_NUMBERING_PART = 'word/numbering.xml'

/**
 * Rendered-output ceilings. A 100 MB package can hold a document.xml with
 * hundreds of thousands of paragraphs; the preview rail is a READ view on a
 * projector, not a document engine, so we stop converting once there is far
 * more Markdown than anyone will scroll and tell the user plainly that the rest
 * was left out. The caps bound the string that crosses IPC AND the DOM the
 * Markdown renderer builds — both were unbounded before.
 */
export const DOCX_MAX_MARKDOWN_CHARS = 200_000
export const DOCX_MAX_BLOCKS = 20_000

/**
 * Ceiling on the XML tree itself. The block cap above bounds the OUTPUT, but a
 * 73 MB `document.xml` still costs several hundred MB of objects to parse in
 * full before the first block is even emitted. Parsing is in document order, so
 * a budget this size (roughly two orders of magnitude more elements than the
 * block cap can consume) keeps the head of the document intact while bounding
 * the tree.
 */
export const DOCX_MAX_XML_ELEMENTS = 400_000

export interface DocxConvertLimits {
  maxBlocks?: number
  maxChars?: number
  maxElements?: number
}

export type DocxConvertErrorCode = 'not-a-docx' | 'no-document-part' | 'unreadable-xml'

export class DocxConvertError extends Error {
  readonly code: DocxConvertErrorCode

  constructor(code: DocxConvertErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'DocxConvertError'
  }
}

export interface DocxRender {
  /** Paragraph/table blocks that produced visible output. */
  blockCount: number
  markdown: string
  /** True when the document was longer than the preview caps allow. */
  truncated: boolean
}

interface NumberingFormats {
  /** `${numId}:${ilvl}` → OOXML numFmt (`bullet`, `decimal`, `lowerLetter`, …). */
  byLevel: Map<string, string>
}

const EMPTY_NUMBERING: NumberingFormats = { byLevel: new Map() }

function attr(node: XmlElement, name: string): string {
  // OOXML attributes are namespaced (`w:val`). The prefixed name is what a real
  // document carries; fall back to a scan by localName so an unusual prefix (or
  // a namespace-stripped fixture) still resolves.
  const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name

  for (const candidate of node.attributes) {
    if (candidate.name === name) {
      return candidate.value
    }
  }

  for (const candidate of node.attributes) {
    if (candidate.localName === local) {
      return candidate.value
    }
  }

  return ''
}

function childrenByLocalName(node: null | XmlElement, localName: string): XmlElement[] {
  if (!node) {
    return []
  }

  return node.children.filter(child => child.localName === localName)
}

function firstChild(node: null | XmlElement, localName: string): null | XmlElement {
  return childrenByLocalName(node, localName)[0] ?? null
}

/** A `w:b` / `w:i` toggle is ON when present unless it carries val 0/false/off. */
function toggleOn(properties: null | XmlElement, localName: string): boolean {
  const node = firstChild(properties, localName)

  if (!node) {
    return false
  }

  const value = attr(node, 'w:val')

  return value !== '0' && value !== 'false' && value !== 'off'
}

// Markdown metacharacters that would otherwise re-interpret document text.
// `|` is handled separately (only meaningful inside tables).
const ESCAPE_RE = /([\\`*_{}[\]<>])/g

function escapeInline(text: string): string {
  return text.replace(ESCAPE_RE, '\\$1')
}

/** Leading `#`, `-`, `>`, `1.` etc. would turn body text into block syntax. */
function escapeBlockStart(line: string): string {
  return line.replace(/^(\s*)([#>+-]|\d+[.)])(\s)/, '$1\\$2$3')
}

function headingLevel(styleId: string): number {
  const normalized = styleId.replace(/\s+/g, '').toLowerCase()

  if (normalized === 'title') {
    return 1
  }

  if (normalized === 'subtitle') {
    return 2
  }

  const match = /^heading([1-9])$/.exec(normalized)

  return match ? Math.min(6, Number(match[1])) : 0
}

interface RunText {
  bold: boolean
  italic: boolean
  text: string
}

function runText(run: XmlElement): RunText {
  const properties = firstChild(run, 'rPr')
  const bold = toggleOn(properties, 'b')
  const italic = toggleOn(properties, 'i')
  let text = ''

  for (const node of run.children) {
    switch (node.localName) {
      case 'br':

      case 'cr':
        text += '\n'

        break

      case 'noBreakHyphen':
        text += '-'

        break

      case 'tab':
        text += ' '

        break

      case 't':
        text += xmlText(node)

        break

      default:
        break
    }
  }

  return { bold, italic, text }
}

/** Runs in document order, following hyperlinks and accepted insertions, and
 *  skipping `w:del` (tracked deletions are not part of the current text). */
function collectRuns(container: XmlElement, out: XmlElement[] = []): XmlElement[] {
  for (const node of container.children) {
    if (node.localName === 'del' || node.localName === 'pPr' || node.localName === 'rPr') {
      continue
    }

    if (node.localName === 'r') {
      out.push(node)

      continue
    }

    if (node.localName === 'hyperlink' || node.localName === 'ins' || node.localName === 'smartTag') {
      collectRuns(node, out)
    }
  }

  return out
}

function emphasize(segment: RunText): string {
  const raw = segment.text

  if (!raw) {
    return ''
  }

  // Emphasis markers must hug the text, not the surrounding spaces, or the
  // Markdown parser drops them.
  const [, lead = '', core = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw) ?? []

  if (!core) {
    return raw
  }

  let body = escapeInline(core)

  if (segment.bold) {
    body = `**${body}**`
  }

  if (segment.italic) {
    body = `*${body}*`
  }

  return `${lead}${body}${trail}`
}

function paragraphInline(paragraph: XmlElement): string {
  const segments: RunText[] = []

  for (const run of collectRuns(paragraph)) {
    const next = runText(run)

    if (!next.text) {
      continue
    }

    const previous = segments.at(-1)

    if (previous && previous.bold === next.bold && previous.italic === next.italic) {
      previous.text += next.text

      continue
    }

    segments.push(next)
  }

  return segments.map(emphasize).join('')
}

interface ParagraphInfo {
  headingLevel: number
  indentLevel: number
  numFmt: string
  ordered: boolean
  text: string
}

function paragraphInfo(paragraph: XmlElement, numbering: NumberingFormats): ParagraphInfo {
  const properties = firstChild(paragraph, 'pPr')
  const styleId = attr(firstChild(properties, 'pStyle') ?? paragraph, 'w:val')
  const numberProperties = firstChild(properties, 'numPr')
  const numId = attr(firstChild(numberProperties, 'numId') ?? paragraph, 'w:val')
  const ilvl = attr(firstChild(numberProperties, 'ilvl') ?? paragraph, 'w:val') || '0'
  const numFmt = numberProperties ? (numbering.byLevel.get(`${numId}:${ilvl}`) ?? 'bullet') : ''

  return {
    headingLevel: firstChild(properties, 'pStyle') ? headingLevel(styleId) : 0,
    indentLevel: numberProperties ? Math.max(0, Math.min(5, Number(ilvl) || 0)) : 0,
    numFmt,
    ordered: Boolean(numberProperties) && numFmt !== 'bullet' && numFmt !== 'none',
    text: paragraphInline(paragraph)
  }
}

function cellText(cell: XmlElement, numbering: NumberingFormats): string {
  const lines = childrenByLocalName(cell, 'p')
    .map(paragraph => paragraphInfo(paragraph, numbering).text.trim())
    .filter(Boolean)

  // Pipes would split the GFM cell; `<br>` keeps multi-paragraph cells readable.
  return lines.join('<br>').replace(/\|/g, '\\|')
}

function tableMarkdown(table: XmlElement, numbering: NumberingFormats): string {
  const rows = childrenByLocalName(table, 'tr').map(row =>
    childrenByLocalName(row, 'tc').map(cell => cellText(cell, numbering))
  )

  if (rows.length === 0) {
    return ''
  }

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)

  if (width === 0) {
    return ''
  }

  const pad = (row: string[]) => Array.from({ length: width }, (_, index) => row[index] ?? '')
  const [header = [], ...body] = rows

  const lines = [
    `| ${pad(header).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(row => `| ${pad(row).join(' | ')} |`)
  ]

  return lines.join('\n')
}

function parseNumbering(xml: string | undefined): NumberingFormats {
  if (!xml) {
    return EMPTY_NUMBERING
  }

  const { root } = parseXml(xml, 'numbering')

  if (!root) {
    return EMPTY_NUMBERING
  }

  const abstractFormats = new Map<string, Map<string, string>>()

  for (const abstract of childrenByLocalName(root, 'abstractNum')) {
    const levels = new Map<string, string>()

    for (const level of childrenByLocalName(abstract, 'lvl')) {
      levels.set(attr(level, 'w:ilvl'), attr(firstChild(level, 'numFmt') ?? level, 'w:val') || 'bullet')
    }

    abstractFormats.set(attr(abstract, 'w:abstractNumId'), levels)
  }

  const byLevel = new Map<string, string>()

  for (const num of childrenByLocalName(root, 'num')) {
    const numId = attr(num, 'w:numId')
    const abstractId = attr(firstChild(num, 'abstractNumId') ?? num, 'w:val')

    for (const [ilvl, format] of abstractFormats.get(abstractId) ?? []) {
      byLevel.set(`${numId}:${ilvl}`, format)
    }
  }

  return { byLevel }
}

function parseXml(xml: string, part: string, maxElements?: number): { root: null | XmlElement; truncated: boolean } {
  try {
    return parseXmlDocument(xml, { maxElements })
  } catch (error) {
    if (error instanceof XmlParseError) {
      throw new DocxConvertError('unreadable-xml', `${part}: ${error.message}`)
    }

    throw error
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback
}

/** Convert the `word/document.xml` body (plus optional numbering) to Markdown. */
export function docxXmlToMarkdown(
  documentXml: string,
  numberingXml?: string,
  limits: DocxConvertLimits = {}
): DocxRender {
  const parsed = parseXml(documentXml, DOCX_DOCUMENT_PART, positiveLimit(limits.maxElements, DOCX_MAX_XML_ELEMENTS))
  const body = parsed.root ? firstChild(parsed.root, 'body') : null

  if (!body) {
    throw new DocxConvertError('no-document-part', 'document.xml has no <w:body>')
  }

  const maxBlocks = positiveLimit(limits.maxBlocks, DOCX_MAX_BLOCKS)
  const maxChars = positiveLimit(limits.maxChars, DOCX_MAX_MARKDOWN_CHARS)
  const numbering = parseNumbering(numberingXml)
  const blocks: Array<{ list: boolean; text: string }> = []
  const counters = new Map<number, number>()
  let chars = 0
  let truncated = parsed.truncated

  const push = (text: string, list = false) => {
    blocks.push({ list, text })
    chars += text.length + 2
  }

  // A block loop, not a slice of the finished string: stopping here means the
  // rest of the document is never converted, so the cost of a very long
  // document is bounded in TIME as well as in memory.
  const full = () => blocks.length >= maxBlocks || chars >= maxChars

  for (const node of body.children) {
    if (full()) {
      truncated = true

      break
    }

    if (node.localName === 'tbl') {
      const table = tableMarkdown(node, numbering)
      counters.clear()

      if (table) {
        push(table)
      }

      continue
    }

    if (node.localName !== 'p') {
      continue
    }

    const info = paragraphInfo(node, numbering)

    if (!info.text.trim()) {
      // Blank paragraphs are spacing, not content — Markdown block separation
      // already provides it, and keeping them produces ragged vertical rhythm.
      counters.clear()

      continue
    }

    if (info.headingLevel > 0) {
      counters.clear()
      push(`${'#'.repeat(info.headingLevel)} ${info.text.trim()}`)

      continue
    }

    if (info.numFmt) {
      const indent = '  '.repeat(info.indentLevel)

      if (info.ordered) {
        const next = (counters.get(info.indentLevel) ?? 0) + 1
        counters.set(info.indentLevel, next)
        push(`${indent}${next}. ${info.text.trim()}`, true)
      } else {
        push(`${indent}- ${info.text.trim()}`, true)
      }

      continue
    }

    counters.clear()
    push(
      info.text
        .split('\n')
        .map(line => escapeBlockStart(line))
        .join('  \n')
        .trim()
    )
  }

  // Consecutive list items are joined with a single newline so the Markdown
  // renderer produces a TIGHT list — a loose list wraps every item in its own
  // paragraph and the panel ends up with ragged, airy bullet spacing.
  const markdown = blocks
    .map((block, index) => {
      const previous = blocks[index - 1]

      if (!previous) {
        return block.text
      }

      return `${previous.list && block.list ? '\n' : '\n\n'}${block.text}`
    })
    .join('')

  return { blockCount: blocks.length, markdown, truncated }
}

/** Convert raw `.docx` bytes to Markdown. Throws `DocxConvertError`. */
export function docxToMarkdown(bytes: Uint8Array, limits: DocxConvertLimits = {}): DocxRender {
  let entries: Record<string, Uint8Array>

  try {
    entries = unzipSync(bytes, {
      filter: file => file.name === DOCX_DOCUMENT_PART || file.name === DOCX_NUMBERING_PART
    })
  } catch (error) {
    throw new DocxConvertError('not-a-docx', error instanceof Error ? error.message : String(error))
  }

  const document = entries[DOCX_DOCUMENT_PART]

  if (!document) {
    throw new DocxConvertError('no-document-part', `archive has no ${DOCX_DOCUMENT_PART}`)
  }

  const numbering = entries[DOCX_NUMBERING_PART]

  return docxXmlToMarkdown(strFromU8(document), numbering ? strFromU8(numbering) : undefined, limits)
}

/** Decode a `data:` URL (what `readFileDataUrl` returns) into raw bytes. */
export function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const [, metadata = '', data = ''] = /^data:([^,]*),([\s\S]*)$/.exec(dataUrl) ?? []

  if (!data && !metadata) {
    throw new DocxConvertError('not-a-docx', 'not a data: URL')
  }

  const raw = metadata.includes(';base64') ? atob(data) : decodeURIComponent(data)

  return Uint8Array.from(raw, char => char.charCodeAt(0))
}
