import { strToU8, zipSync } from 'fflate/browser'
import { toHtml } from 'hast-util-to-html'
import type { ListItem, PhrasingContent, Root, RootContent } from 'mdast'
import { toHast } from 'mdast-util-to-hast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { codeSizePt, type ResolvedDocumentTheme, resolveDocumentTheme } from '../../shared/atum-office/document-theme'
import {
  lineHeightToLineUnits,
  pageGeometryTwips,
  pointsToHalfPoints,
  pointsToTwips
} from '../../shared/atum-office/units'

import { DOCX_MAX_BLOCKS, DOCX_MAX_MARKDOWN_CHARS, DOCX_MAX_XML_ELEMENTS } from './docx-markdown'

export interface MarkdownExportLimits {
  maxMarkdownChars: number
  maxBlocks: number
  maxXmlElements: number
  maxPackageBytes: number
}

export const MARKDOWN_EXPORT_LIMITS: MarkdownExportLimits = {
  maxMarkdownChars: DOCX_MAX_MARKDOWN_CHARS,
  maxBlocks: DOCX_MAX_BLOCKS,
  maxXmlElements: DOCX_MAX_XML_ELEMENTS,
  maxPackageBytes: 16 * 1024 * 1024
}

export type MarkdownExportErrorCode = 'EXPORT_TOO_LARGE' | 'EXPORT_UNSUPPORTED' | 'EXPORT_INVALID_MARKDOWN'

export class MarkdownExportError extends Error {
  readonly code: MarkdownExportErrorCode

  constructor(code: MarkdownExportErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'MarkdownExportError'
  }
}

export interface MarkdownDocumentOptions {
  title: string
  locale?: string
  limits?: Partial<MarkdownExportLimits>
  /**
   * The document's presentation theme, resolved and pinned by the main process.
   * Absent means the inferred default, which reproduces the geometry and
   * heading scale this writer shipped with.
   */
  theme?: ResolvedDocumentTheme
}

interface RunStyle {
  bold?: boolean
  code?: boolean
  italic?: boolean
}

interface DocxRun {
  hyperlink?: string
  style: RunStyle
  text: string
}

interface DocxTable {
  align: ('left' | 'center' | 'right' | null)[]
  rows: DocxRun[][][]
}

interface DocxBlock {
  heading?: number
  list?: 'bullet' | 'number'
  monospace?: boolean
  runs: DocxRun[]
  table?: DocxTable
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const FIXED_DATE = new Date('1980-01-01T00:00:00.000Z')

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback
}

function limitsFor(options: MarkdownDocumentOptions): MarkdownExportLimits {
  return {
    maxMarkdownChars: positiveLimit(options.limits?.maxMarkdownChars, MARKDOWN_EXPORT_LIMITS.maxMarkdownChars),
    maxBlocks: positiveLimit(options.limits?.maxBlocks, MARKDOWN_EXPORT_LIMITS.maxBlocks),
    maxXmlElements: positiveLimit(options.limits?.maxXmlElements, MARKDOWN_EXPORT_LIMITS.maxXmlElements),
    maxPackageBytes: positiveLimit(options.limits?.maxPackageBytes, MARKDOWN_EXPORT_LIMITS.maxPackageBytes)
  }
}

function parseMarkdown(markdown: string, limits: MarkdownExportLimits): Root {
  if (markdown.length > limits.maxMarkdownChars) {
    throw new MarkdownExportError(
      'EXPORT_TOO_LARGE',
      `Markdown has ${markdown.length} characters; limit ${limits.maxMarkdownChars}`
    )
  }

  try {
    return unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root
  } catch (error) {
    throw new MarkdownExportError(
      'EXPORT_INVALID_MARKDOWN',
      error instanceof Error ? error.message : 'Markdown could not be parsed'
    )
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function plainText(node: { children?: unknown[]; type?: string; value?: string; alt?: null | string }): string {
  if (node.type === 'image') {
    return node.alt ?? ''
  }

  if (typeof node.value === 'string') {
    return node.value
  }

  return (node.children ?? []).map(child => plainText(child as Parameters<typeof plainText>[0])).join('')
}

function inlineRuns(nodes: PhrasingContent[], inherited: RunStyle = {}): DocxRun[] {
  const runs: DocxRun[] = []

  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push({ style: inherited, text: node.value })
    } else if (node.type === 'break') {
      runs.push({ style: inherited, text: '\n' })
    } else if (node.type === 'image') {
      runs.push({ style: inherited, text: node.alt ?? '' })
    } else if (node.type === 'inlineCode') {
      runs.push({ style: { ...inherited, code: true }, text: node.value })
    } else if (node.type === 'strong') {
      runs.push(...inlineRuns(node.children, { ...inherited, bold: true }))
    } else if (node.type === 'emphasis') {
      runs.push(...inlineRuns(node.children, { ...inherited, italic: true }))
    } else if (node.type === 'link') {
      for (const run of inlineRuns(node.children, inherited)) {
        runs.push({ ...run, hyperlink: node.url })
      }
    } else {
      runs.push({ style: inherited, text: plainText(node) })
    }
  }

  return runs
}

function itemRuns(item: ListItem): DocxRun[] {
  const runs: DocxRun[] = []

  const appendSpace = () => {
    if (runs.length && !runs.at(-1)?.text.endsWith(' ')) {
      runs.push({ style: {}, text: ' ' })
    }
  }

  for (const child of item.children) {
    if (child.type === 'paragraph') {
      appendSpace()
      runs.push(...inlineRuns(child.children))
    } else if (child.type !== 'list') {
      appendSpace()
      runs.push({ style: {}, text: plainText(child) })
    }
  }

  return runs
}

function blocksFromAst(root: Root, limits: MarkdownExportLimits): DocxBlock[] {
  const blocks: DocxBlock[] = []
  let blockCount = 0

  const push = (block: DocxBlock) => {
    blockCount += block.table ? block.table.rows.reduce((count, row) => count + row.length, 0) : 1

    if (blockCount > limits.maxBlocks) {
      throw new MarkdownExportError('EXPORT_TOO_LARGE', `Document exceeds ${limits.maxBlocks} blocks`)
    }

    blocks.push(block)
  }

  const visit = (node: RootContent) => {
    switch (node.type) {
      case 'heading':
        push({ heading: node.depth, runs: inlineRuns(node.children) })

        break

      case 'paragraph':
        push({ runs: inlineRuns(node.children) })

        break

      case 'list':
        for (const item of node.children) {
          push({ list: node.ordered ? 'number' : 'bullet', runs: itemRuns(item) })

          for (const child of item.children) {
            if (child.type === 'list') {
              visit(child)
            }
          }
        }

        break

      case 'code':
        for (const line of node.value.split('\n')) {
          push({ monospace: true, runs: [{ style: { code: true }, text: line }] })
        }

        break

      case 'blockquote':
        for (const child of node.children) {
          const text = plainText(child)

          if (text) {
            push({ runs: [{ style: {}, text }] })
          }
        }

        break

      case 'table':
        push({
          runs: [],
          table: {
            align: node.align ?? [],
            rows: node.children.map((row, index) =>
              row.children.map(cell => inlineRuns(cell.children, index === 0 ? { bold: true } : {}))
            )
          }
        })

        break

      case 'html':
        push({ runs: [{ style: {}, text: node.value }] })

        break

      case 'thematicBreak':
        push({ runs: [{ style: {}, text: '---' }] })

        break
      default: {
        const text = plainText(node)

        if (text) {
          push({ runs: [{ style: {}, text }] })
        }
      }
    }
  }

  for (const node of root.children) {
    visit(node)
  }

  return blocks
}

function runXml(run: DocxRun): string {
  const properties = [
    run.style.bold ? '<w:b/>' : '',
    run.style.italic ? '<w:i/>' : '',
    run.style.code ? '<w:rStyle w:val="Code"/>' : ''
  ].join('')

  const chunks = run.text.split('\n')

  const body = chunks
    .map((chunk, index) => {
      const preserve = /^\s|\s$/.test(chunk) ? ' xml:space="preserve"' : ''

      return `${index ? '<w:br/>' : ''}<w:t${preserve}>${escapeXml(chunk)}</w:t>`
    })
    .join('')

  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${body}</w:r>`
}

function sameRunStyle(left: DocxRun, right: DocxRun): boolean {
  return (
    left.hyperlink === right.hyperlink &&
    Boolean(left.style.bold) === Boolean(right.style.bold) &&
    Boolean(left.style.italic) === Boolean(right.style.italic) &&
    Boolean(left.style.code) === Boolean(right.style.code)
  )
}

/** Adjacent runs with the same formatting (e.g. text around escaped inline HTML) become one run. */
function mergeRuns(runs: DocxRun[]): DocxRun[] {
  const merged: DocxRun[] = []

  for (const run of runs) {
    const last = merged[merged.length - 1]

    if (last && sameRunStyle(last, run)) {
      merged[merged.length - 1] = { ...last, text: last.text + run.text }
    } else {
      merged.push({ ...run })
    }
  }

  return merged
}

/** The page box, derived from the one geometry authority in shared/atum-office. */
function sectPrXml(theme: ResolvedDocumentTheme): string {
  const page = pageGeometryTwips(theme.pageSize, theme.marginMm)

  return `<w:sectPr><w:pgSz w:w="${page.widthTwips}" w:h="${page.heightTwips}"/><w:pgMar w:top="${page.topTwips}" w:right="${page.rightTwips}" w:bottom="${page.bottomTwips}" w:left="${page.leftTwips}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`
}

function documentXml(blocks: DocxBlock[], links: Map<string, string>, theme: ResolvedDocumentTheme): string {
  const paragraphXml = (block: DocxBlock, alignment?: string | null) => {
    const properties = block.heading
      ? `<w:pPr><w:pStyle w:val="Heading${block.heading}"/></w:pPr>`
      : block.list
        ? `<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${block.list === 'bullet' ? 1 : 2}"/></w:numPr></w:pPr>`
        : block.monospace
          ? '<w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>'
          : alignment
            ? `<w:pPr><w:jc w:val="${alignment}"/></w:pPr>`
            : ''

    const runs = mergeRuns(block.runs)
      .map(run => {
        if (!run.hyperlink) {
          return runXml(run)
        }

        let id = links.get(run.hyperlink)

        if (!id) {
          id = `rId${links.size + 3}`
          links.set(run.hyperlink, id)
        }

        return `<w:hyperlink r:id="${id}" w:history="1">${runXml(run)}</w:hyperlink>`
      })
      .join('')

    return `<w:p>${properties}${runs}</w:p>`
  }

  const paragraphs = blocks.map(block => {
    if (!block.table) {
      return paragraphXml(block)
    }

    const { rows, align } = block.table
    const columns = Math.max(0, ...rows.map(row => row.length))

    if (!columns) {
      return ''
    }

    const page = pageGeometryTwips(theme.pageSize, theme.marginMm)
    const width = Math.max(1, Math.floor((page.widthTwips - page.leftTwips - page.rightTwips) / columns))

    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map(edge => `<w:${edge} w:val="single" w:sz="4" w:color="D4D1CA"/>`)
      .join('')

    const properties = `<w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>`
    const grid = `<w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`

    const body = rows
      .map((row, index) => {
        const cells = Array.from({ length: columns }, (_, column) => {
          const shade = index === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F3F0"/>' : ''

          return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr>${paragraphXml({ runs: row[column] ?? [] }, align[column])}</w:tc>`
        }).join('')

        return `<w:tr>${index === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`
      })
      .join('')

    return `<w:tbl>${properties}${grid}${body}</w:tbl>`
  })

  return `${XML_HEADER}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${paragraphs.join('')}${sectPrXml(theme)}</w:body></w:document>`
}

/** The default is inferred here so neither writer has to branch on absence. */
function themeFor(options: MarkdownDocumentOptions): ResolvedDocumentTheme {
  return options.theme ?? resolveDocumentTheme(null)
}

/**
 * `w:docDefaults` must be the FIRST child of `w:styles`: CT_Styles is an
 * ordered sequence (docDefaults, latentStyles, style) and Word offers to
 * repair a file that breaks it. CT_DocDefaults is itself ordered
 * rPrDefault-then-pPrDefault, which is the reverse of the familiar
 * pPr-then-rPr found inside a style, and is the easiest thing here to get
 * wrong. Within w:rPr the order is rFonts, sz, szCs, lang.
 */
function docDefaultsXml(theme: ResolvedDocumentTheme, locale: string): string {
  const size = pointsToHalfPoints(theme.bodySizePt)
  const font = theme.bodyFont.docx
  const rFonts = `<w:rFonts w:ascii="${escapeXml(font.ascii)}" w:hAnsi="${escapeXml(font.hAnsi)}" w:eastAsia="${escapeXml(font.eastAsia)}" w:cs="${escapeXml(font.cs)}"/>`
  const spacing = `<w:spacing w:before="0" w:after="${pointsToTwips(theme.paragraphSpacingPt)}" w:line="${lineHeightToLineUnits(theme.lineHeight)}" w:lineRule="auto"/>`

  return `<w:docDefaults><w:rPrDefault><w:rPr>${rFonts}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="${escapeXml(locale)}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${spacing}</w:pPr></w:pPrDefault></w:docDefaults>`
}

function stylesXml(theme: ResolvedDocumentTheme, locale: string): string {
  // Code follows the body at one point under it; a fixed 10 pt would be
  // conspicuous the moment the body size moved. ListParagraph carries
  // contextualSpacing so the document-default after-spacing does not open a
  // gap between every list item.
  const code = pointsToHalfPoints(codeSizePt(theme))
  const headingFont = theme.headingFont.docx
  const headingRFonts = `<w:rFonts w:ascii="${escapeXml(headingFont.ascii)}" w:hAnsi="${escapeXml(headingFont.hAnsi)}" w:eastAsia="${escapeXml(headingFont.eastAsia)}" w:cs="${escapeXml(headingFont.cs)}"/>`

  const headings = Array.from({ length: 6 }, (_, index) => {
    const level = index + 1
    const size = pointsToHalfPoints(theme.headingSizesPt[index] ?? theme.bodySizePt)
    // Inside w:pPr, w:spacing precedes w:outlineLvl (CT_PPrBase is ordered).
    const pPr = `<w:pPr><w:keepNext/><w:spacing w:before="${pointsToTwips(theme.paragraphSpacingPt * 2)}" w:after="${pointsToTwips(theme.paragraphSpacingPt)}" w:line="${lineHeightToLineUnits(1.2)}" w:lineRule="auto"/><w:outlineLvl w:val="${index}"/></w:pPr>`

    return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>${pPr}<w:rPr>${headingRFonts}<w:b/><w:color w:val="${escapeXml(theme.accentHex)}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`
  }).join('')

  return `${XML_HEADER}<w:styles xmlns:w="${W_NS}">${docDefaultsXml(theme, locale)}<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:lang w:val="${escapeXml(locale)}"/></w:rPr></w:style>${headings}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:contextualSpacing/></w:pPr></w:style><w:style w:type="character" w:styleId="Code"><w:name w:val="Code"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="${code}"/><w:szCs w:val="${code}"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="${code}"/><w:szCs w:val="${code}"/></w:rPr></w:style></w:styles>`
}

function numberingXml(): string {
  return `${XML_HEADER}<w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`
}

function relationshipsXml(links: Map<string, string>): string {
  const rows = [...links].map(
    ([target, id]) =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(target)}" TargetMode="External"/>`
  )

  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rows.join('')}</Relationships>`
}

function elementCount(parts: string[]): number {
  return parts.reduce((total, xml) => total + (xml.match(/<([A-Za-z_][\w:.-]*)(?:\s|\/?>)/g)?.length ?? 0), 0)
}

export function markdownToDocx(markdown: string, options: MarkdownDocumentOptions): Uint8Array {
  const limits = limitsFor(options)
  const root = parseMarkdown(markdown, limits)
  const blocks = blocksFromAst(root, limits)
  const theme = themeFor(options)
  const locale = options.locale?.trim() || 'vi-VN'
  const links = new Map<string, string>()
  const document = documentXml(blocks, links, theme)
  const styles = stylesXml(theme, locale)
  const numbering = numberingXml()
  const relationships = relationshipsXml(links)
  const contentTypes = `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`
  const rootRels = `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`
  const core = `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(options.title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`

  const parts = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'word/document.xml': document,
    'word/styles.xml': styles,
    'word/numbering.xml': numbering,
    'word/_rels/document.xml.rels': relationships,
    'docProps/core.xml': core
  }

  if (elementCount(Object.values(parts)) > limits.maxXmlElements) {
    throw new MarkdownExportError('EXPORT_TOO_LARGE', `OOXML exceeds ${limits.maxXmlElements} elements`)
  }

  const zipped = zipSync(
    Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, [strToU8(value), { mtime: FIXED_DATE }]])),
    { level: 6, mtime: FIXED_DATE }
  )

  if (zipped.byteLength > limits.maxPackageBytes) {
    throw new MarkdownExportError(
      'EXPORT_TOO_LARGE',
      `DOCX package has ${zipped.byteLength} bytes; limit ${limits.maxPackageBytes}`
    )
  }

  return zipped
}

/** Trim a computed length to a stable CSS number. */
function css(value: number): string {
  const fixed = value.toFixed(3)

  return fixed.includes('.') ? fixed.replace(/0+$/u, '').replace(/\.$/u, '') : fixed
}

/**
 * The print stylesheet.
 *
 * It deliberately carries NO page box. `printToPDF` is the single page-geometry
 * authority, so there is no `@page` rule to win or lose a precedence argument
 * with it, and no CSS page size that could make Chromium silently rescale the
 * document to fit. `body.document` likewise has no `max-width`: the old 170 mm
 * was a third, hidden authority that happened to equal A4 minus two 20 mm
 * margins, and it would have clamped the text column under any theme with
 * narrower margins, quietly desynchronising the PDF from the Word file. The
 * body margin is zeroed explicitly: with the old `margin: 0 auto` gone, the
 * user-agent stylesheet's 8px body margin would otherwise inset the column a
 * further 2.12 mm per side inside the `printToPDF` margins.
 *
 * Every interpolated value here is a number formatted by `css()` or a string
 * from the frozen, closed catalogue. Nothing from the metadata store reaches
 * this template, which is emitted into `<style>` without escaping.
 */
function documentCss(theme: ResolvedDocumentTheme): string {
  const [h1, h2, h3, h4, h5, h6] = theme.headingSizesPt
  const heading = (size: number | undefined) => css(size ?? theme.bodySizePt)
  const gap = css(theme.paragraphSpacingPt)

  return `
html { font-size: ${css(theme.bodySizePt)}pt; }
body.document { margin: 0; color: #171717; line-height: ${css(theme.lineHeight)}; font-family: ${theme.bodyFont.css}; }
h1, h2, h3, h4, h5, h6 { page-break-inside: avoid; break-after: avoid; line-height: 1.2; color: #${theme.accentHex}; font-family: ${theme.headingFont.css}; margin: ${css(theme.paragraphSpacingPt * 2)}pt 0 ${gap}pt; }
h1 { font-size: ${heading(h1)}pt; } h2 { font-size: ${heading(h2)}pt; } h3 { font-size: ${heading(h3)}pt; }
h4 { font-size: ${heading(h4)}pt; } h5 { font-size: ${heading(h5)}pt; } h6 { font-size: ${heading(h6)}pt; }
p, ul, ol, blockquote, pre, table { margin: 0 0 ${gap}pt; }
ul, ol { padding-left: 1.6em; }
blockquote { border-left: 3px solid #aaa; margin-left: 0; padding-left: 1em; color: #444; }
code, pre { font-family: ui-monospace, Menlo, monospace; font-size: ${css(codeSizePt(theme))}pt; } code { background: #f1f1f1; padding: .08em .25em; } pre { background: #f5f5f5; padding: .8em; white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #aaa; padding: .35em .5em; text-align: left; }
a { color: inherit; text-decoration: underline; overflow-wrap: anywhere; }
@media print { a[href]::after { content: " (" attr(href) ")"; } }
`.trim()
}

const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem'])

function htmlSafeAst(root: Root): Root {
  const rewrite = (node: unknown, parentType: string): unknown => {
    const current = node as { alt?: string; children?: unknown[]; type: string; value?: string }

    if (current.type === 'image') {
      return { type: 'text', value: current.alt ?? '' }
    }

    if (current.type === 'html') {
      const text = { type: 'text', value: current.value ?? '' }

      // A block-level html node becomes a paragraph of escaped text; a bare
      // text node is not valid under flow parents and would be dropped.
      return FLOW_PARENTS.has(parentType) ? { type: 'paragraph', children: [text] } : text
    }

    return current.children
      ? { ...current, children: current.children.map(child => rewrite(child, current.type)) }
      : { ...current }
  }

  return rewrite(root, '') as Root
}

export function markdownToDocumentHtml(markdown: string, options: MarkdownDocumentOptions): string {
  const limits = limitsFor(options)
  const root = parseMarkdown(markdown, limits)

  if (blocksFromAst(root, limits).length > limits.maxBlocks) {
    throw new MarkdownExportError('EXPORT_TOO_LARGE', `Document exceeds ${limits.maxBlocks} blocks`)
  }

  const body = toHtml(toHast(htmlSafeAst(root), { allowDangerousHtml: false })!, {
    allowDangerousHtml: false,
    // Named references (&lt; &gt; &amp;) keep escaped raw HTML readable and testable.
    characterReferences: { useNamedReferences: true }
  })

  const locale = options.locale?.trim() || 'vi'

  return `<!doctype html><html lang="${escapeXml(locale)}"><head><meta charset="utf-8"><title>${escapeXml(options.title)}</title><style>${documentCss(themeFor(options))}</style></head><body class="document">${body}</body></html>`
}
