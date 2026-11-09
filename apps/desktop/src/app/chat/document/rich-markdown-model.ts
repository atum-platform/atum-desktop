import { Schema } from 'prosemirror-model'
import type { Fragment, Mark, Node as PMNode } from 'prosemirror-model'
import { tableNodes } from 'prosemirror-tables'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

interface MarkdownPosition {
  end?: { offset?: number }
  start?: { offset?: number }
}

interface MarkdownNode {
  align?: Array<'center' | 'left' | 'right' | null>
  checked?: boolean | null
  children?: MarkdownNode[]
  depth?: number
  lang?: string | null
  meta?: string | null
  ordered?: boolean
  position?: MarkdownPosition
  start?: number | null
  title?: string | null
  type: string
  url?: string
  value?: string
}

interface SourceRange {
  from: number
  to: number
}

interface EmittedText {
  direct: boolean
  range: SourceRange
  text: string
}

export interface RichMarkdownBlock extends SourceRange {
  node: PMNode
  pos: number
}

export interface RichMarkdownTextRange extends SourceRange {
  pos: number
  text: string
}

export interface ParsedRichMarkdown {
  blocks: RichMarkdownBlock[]
  doc: PMNode
  kind: 'parsed'
  source: string
  textRanges: RichMarkdownTextRange[]
}

export interface RefusedRichMarkdown {
  kind: 'refused'
  reason: string
}

export type RichMarkdownParseResult = ParsedRichMarkdown | RefusedRichMarkdown

const table = tableNodes({
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: dom => dom.getAttribute('data-align'),
      setDOMAttr: (value, attrs) => {
        if (value) {
          attrs['data-align'] = value
        }
      }
    }
  },
  cellContent: 'paragraph+',
  tableGroup: 'block'
})

/** The rich editor's intentionally small, Markdown-representable document model. */
export const richMarkdownSchema = new Schema({
  marks: {
    emphasis: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }],
      toDOM: () => ['em', 0]
    },
    strong: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
      toDOM: () => ['strong', 0]
    },
    strike: {
      parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
      toDOM: () => ['s', 0]
    },
    code: {
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0]
    },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          getAttrs: dom => {
            const href = dom.getAttribute('href')

            return href && isSafeRichHref(href) ? { href } : false
          },
          tag: 'a[href]'
        }
      ],
      toDOM: mark => ['a', { href: mark.attrs.href, rel: 'noopener noreferrer' }, 0]
    }
  },
  nodes: {
    doc: {
      attrs: { markdown: { default: null } },
      content: 'block+'
    },
    text: { group: 'inline' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0]
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      defining: true,
      group: 'block',
      parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({ attrs: { level }, tag: `h${level}` })),
      toDOM: node => [`h${node.attrs.level}`, 0]
    },
    blockquote: {
      content: 'block+',
      defining: true,
      group: 'block',
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0]
    },
    bullet_list: {
      content: 'list_item+',
      group: 'block',
      parseDOM: [{ tag: 'ul' }],
      toDOM: () => ['ul', 0]
    },
    ordered_list: {
      attrs: { order: { default: 1 } },
      content: 'list_item+',
      group: 'block',
      parseDOM: [
        {
          getAttrs: dom => ({ order: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) : 1 }),
          tag: 'ol'
        }
      ],
      toDOM: node => (node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order }, 0])
    },
    list_item: {
      content: 'block+',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: () => ['li', 0]
    },
    code_block: {
      attrs: { params: { default: '' } },
      code: true,
      content: 'text*',
      defining: true,
      group: 'block',
      marks: '',
      parseDOM: [{ preserveWhitespace: 'full', tag: 'pre' }],
      toDOM: node => ['pre', ['code', node.attrs.params ? { 'data-params': node.attrs.params } : {}, 0]]
    },
    horizontal_rule: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr']
    },
    hard_break: {
      group: 'inline',
      inline: true,
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br']
    },
    ...table
  }
})

class MarkdownRefusal extends Error {}

class ParseContext {
  readonly emittedText: EmittedText[] = []
  readonly emptyText: SourceRange[] = []

  constructor(readonly source: string) {}

  text(node: MarkdownNode, direct = true): PMNode {
    return this.literal(node.value ?? '', sourceRange(node), direct)
  }

  literal(value: string, range: SourceRange, direct = true): PMNode {
    this.emittedText.push({
      direct: direct && this.source.slice(range.from, range.to) === value,
      range,
      text: value
    })

    return richMarkdownSchema.text(value)
  }

  emptyParagraph(range: SourceRange): PMNode {
    this.emptyText.push(range)

    return richMarkdownSchema.nodes.paragraph!.create()
  }
}

function sourceRange(node: MarkdownNode): SourceRange {
  const from = node.position?.start?.offset
  const to = node.position?.end?.offset

  if (typeof from !== 'number' || typeof to !== 'number') {
    throw new MarkdownRefusal(`${node.type} has no source range`)
  }

  return { from, to }
}

export function isSafeRichHref(href: string): boolean {
  if (
    /^\s/u.test(href) ||
    Array.from(href).some(character => {
      const code = character.codePointAt(0)!

      return code < 32 || code === 127
    })
  ) {
    return false
  }

  if (!/^[a-z][a-z\d+.-]*:/iu.test(href)) {
    // Relative links and document anchors stay within the current document's
    // origin. Protocol-relative URLs are deliberately excluded.
    return !href.startsWith('//')
  }

  try {
    const parsed = new URL(href)

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
  } catch {
    return false
  }
}

function parseTree(source: string): MarkdownNode {
  return unified().use(remarkParse).use(remarkGfm).parse(source) as unknown as MarkdownNode
}

function hasFrontMatter(source: string): boolean {
  // remark-parse does not enable a front-matter extension, so treat an
  // opening delimiter at byte zero conservatively instead of mistaking it for
  // a rule/heading when a rich transaction later rewrites nearby source.
  return /^\uFEFF?(---|\+\+\+)[ \t]*(?:\r?\n|$)/u.test(source)
}

function convertInlineChildren(
  children: MarkdownNode[] | undefined,
  context: ParseContext,
  marks: readonly Mark[] = []
): PMNode[] {
  if (!children) {
    return []
  }

  const output: PMNode[] = []

  for (const child of children) {
    if (child.type === 'text') {
      output.push(context.text(child).mark(marks))

      continue
    }

    if (child.type === 'break') {
      output.push(richMarkdownSchema.nodes.hard_break!.create())

      continue
    }

    if (child.type === 'inlineCode') {
      if (marks.length > 0) {
        throw new MarkdownRefusal('nested inline code')
      }

      const span = inlineCodeRange(child, context.source)
      const value = child.value ?? ''
      output.push(
        context
          .literal(value, span, context.source.slice(span.from, span.to) === value)
          .mark([richMarkdownSchema.marks.code!.create()])
      )

      continue
    }

    const mark = inlineMark(child)

    if (!mark) {
      throw new MarkdownRefusal(`unsupported inline ${child.type}`)
    }

    output.push(...convertInlineChildren(child.children, context, [...marks, mark]))
  }

  return output
}

function inlineMark(node: MarkdownNode): Mark | null {
  if (node.type === 'emphasis') {
    return richMarkdownSchema.marks.emphasis!.create()
  }

  if (node.type === 'strong') {
    return richMarkdownSchema.marks.strong!.create()
  }

  if (node.type === 'delete') {
    return richMarkdownSchema.marks.strike!.create()
  }

  if (node.type === 'link') {
    if (!node.url || !isSafeRichHref(node.url)) {
      throw new MarkdownRefusal('unsafe link')
    }

    if (node.title !== undefined && node.title !== null) {
      throw new MarkdownRefusal('link title')
    }

    return richMarkdownSchema.marks.link!.create({ href: node.url })
  }

  return null
}

function inlineCodeRange(node: MarkdownNode, source: string): SourceRange {
  const range = sourceRange(node)
  const raw = source.slice(range.from, range.to)
  const opening = /^`+/u.exec(raw)?.[0]

  if (!opening || !raw.endsWith(opening) || raw.length < opening.length * 2) {
    throw new MarkdownRefusal('unrepresentable inline code')
  }

  return { from: range.from + opening.length, to: range.to - opening.length }
}

function codeParams(node: MarkdownNode, source: string): string {
  const range = sourceRange(node)
  const newline = source.indexOf('\n', range.from)
  const firstLine = source.slice(range.from, newline < 0 ? range.to : newline).replace(/\r$/u, '')
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(firstLine)

  if (!match) {
    throw new MarkdownRefusal('indented code block')
  }

  const params = match[2]!.trim()

  if (node.lang && !params.startsWith(node.lang)) {
    throw new MarkdownRefusal('unrepresentable code fence')
  }

  if (params.includes('`')) {
    throw new MarkdownRefusal('unrepresentable code fence')
  }

  return params
}

function convertBlock(node: MarkdownNode, context: ParseContext): PMNode {
  const schema = richMarkdownSchema.nodes

  switch (node.type) {
    case 'paragraph':
      return schema.paragraph!.create(null, convertInlineChildren(node.children, context))
    case 'heading': {
      const level = Number(node.depth)

      if (!Number.isInteger(level) || level < 1 || level > 6) {
        throw new MarkdownRefusal('invalid heading')
      }

      return schema.heading!.create({ level }, convertInlineChildren(node.children, context))
    }

    case 'blockquote':
      return schema.blockquote!.create(null, convertBlocks(node.children, context))
    case 'list': {
      if (node.children?.some(item => item.checked !== null && item.checked !== undefined)) {
        throw new MarkdownRefusal('task list')
      }

      const items = node.children?.map(item => {
        if (item.type !== 'listItem') {
          throw new MarkdownRefusal('invalid list item')
        }

        return schema.list_item!.create(null, convertBlocks(item.children, context))
      })

      if (!items?.length) {
        throw new MarkdownRefusal('empty list')
      }

      return node.ordered
        ? schema.ordered_list!.create({ order: node.start ?? 1 }, items)
        : schema.bullet_list!.create(null, items)
    }

    case 'code':
      return schema.code_block!.create({ params: codeParams(node, context.source) }, context.text(node, false))

    case 'thematicBreak':
      return schema.horizontal_rule!.create()

    case 'table':
      return convertTable(node, context)

    default:
      throw new MarkdownRefusal(`unsupported block ${node.type}`)
  }
}

function convertBlocks(children: MarkdownNode[] | undefined, context: ParseContext): PMNode[] {
  if (!children) {
    return []
  }

  return children.map(node => convertBlock(node, context))
}

function convertTable(node: MarkdownNode, context: ParseContext): PMNode {
  const rows = node.children ?? []
  const width = rows[0]?.children?.length ?? 0

  if (!width || rows.some(row => row.type !== 'tableRow' || row.children?.length !== width)) {
    throw new MarkdownRefusal('non-rectangular table')
  }

  const align = node.align ?? []

  if (
    align.length > width ||
    align.some(value => value !== null && value !== 'left' && value !== 'right' && value !== 'center')
  ) {
    throw new MarkdownRefusal('invalid table alignment')
  }

  return richMarkdownSchema.nodes.table!.create(
    null,
    rows.map((row, rowIndex) =>
      richMarkdownSchema.nodes.table_row!.create(
        null,
        row.children!.map(cell => {
          if (cell.type !== 'tableCell') {
            throw new MarkdownRefusal('invalid table cell')
          }

          const cellType =
            rowIndex === 0 ? richMarkdownSchema.nodes.table_header! : richMarkdownSchema.nodes.table_cell!

          const cellRange = sourceRange(cell)
          const content = convertInlineChildren(cell.children, context)

          const paragraph =
            content.length > 0
              ? richMarkdownSchema.nodes.paragraph!.create(null, content)
              : context.emptyParagraph(emptyCellInsertionRange(context.source, cellRange))

          return cellType.create({ align: align[row.children!.indexOf(cell)] ?? null }, paragraph)
        })
      )
    )
  )
}

function directTextRanges(doc: PMNode, emitted: readonly EmittedText[]): RichMarkdownTextRange[] {
  const result: RichMarkdownTextRange[] = []
  let emittedIndex = 0
  let consumed = 0

  doc.descendants((node, pos) => {
    if (!node.isText) {
      return true
    }

    let textOffset = 0

    while (textOffset < node.text!.length) {
      const expected = emitted[emittedIndex]

      if (!expected) {
        throw new MarkdownRefusal('text mapping drift')
      }

      const remaining = expected.text.length - consumed
      const available = node.text!.length - textOffset

      if (
        remaining <= 0 ||
        node.text!.slice(textOffset, textOffset + Math.min(remaining, available)) !==
          expected.text.slice(consumed, consumed + Math.min(remaining, available))
      ) {
        throw new MarkdownRefusal('text mapping drift')
      }

      const count = Math.min(remaining, available)

      if (expected.direct && consumed === 0 && count === expected.text.length) {
        result.push({ ...expected.range, pos: pos + textOffset, text: expected.text })
      }

      textOffset += count
      consumed += count

      if (consumed === expected.text.length) {
        emittedIndex += 1
        consumed = 0
      }
    }

    return true
  })

  if (emittedIndex !== emitted.length || consumed !== 0) {
    throw new MarkdownRefusal('text mapping drift')
  }

  return result
}

function withEmptyTextRanges(
  doc: PMNode,
  ranges: readonly SourceRange[],
  existing: RichMarkdownTextRange[]
): RichMarkdownTextRange[] {
  let index = 0

  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.childCount === 0) {
      const range = ranges[index]

      if (!range) {
        throw new MarkdownRefusal('empty text mapping drift')
      }

      existing.push({ ...range, pos: pos + 1, text: '' })
      index += 1
    }

    return true
  })

  if (index !== ranges.length) {
    throw new MarkdownRefusal('empty text mapping drift')
  }

  return existing.sort((left, right) => left.pos - right.pos)
}

function emptyCellInsertionRange(source: string, range: SourceRange): SourceRange {
  const raw = source.slice(range.from, range.to)
  const delimiter = raw.indexOf('|')

  if (delimiter < 0) {
    throw new MarkdownRefusal('empty table cell has no delimiter')
  }

  const offset = range.from + delimiter + 1

  return { from: offset, to: offset }
}

interface ConvertedTopLevelBlock {
  node: PMNode
  range: SourceRange
}

function emptyParagraphsBetween(
  source: string,
  from: number,
  to: number,
  trailing: boolean,
  leading = false
): SourceRange[] {
  const gap = source.slice(from, to)

  if (!/^[ \t\r\n]*$/u.test(gap)) {
    return []
  }

  const lineBreaks = (gap.match(/\n/gu) ?? []).length
  // A normal block separator takes two line breaks. Every further pair is an
  // intentional empty ProseMirror paragraph. At EOF a single separator is the
  // paragraph created by pressing Enter at the end of a block.
  const count = trailing ? Math.floor(lineBreaks / 2) : Math.floor(Math.max(0, lineBreaks - 2) / 2)

  const breaks = Array.from(gap.matchAll(/\n/gu), match => from + match.index + 1)

  return Array.from({ length: count }, (_, index) => {
    // Each visible empty paragraph owns its actual place in the whitespace
    // gap. Mapping all empties to gapEnd merges input into the next block.
    const offset = leading && index === 0 ? from : breaks[(index + (leading ? 0 : 1)) * 2 - 1]!

    return { from: offset, to: offset }
  })
}

function convertTopLevelBlocks(root: MarkdownNode, context: ParseContext): ConvertedTopLevelBlock[] {
  const sourceNodes = root.children ?? []
  const converted: ConvertedTopLevelBlock[] = []

  if (sourceNodes.length === 0) {
    const range = { from: 0, to: 0 }

    return [range, ...emptyParagraphsBetween(context.source, 0, context.source.length, true)].map(emptyRange => ({
      node: context.emptyParagraph(emptyRange),
      range: emptyRange
    }))
  }

  const firstRange = sourceRange(sourceNodes[0]!)

  for (const emptyRange of emptyParagraphsBetween(context.source, 0, firstRange.from, true, true)) {
    converted.push({ node: context.emptyParagraph(emptyRange), range: emptyRange })
  }

  for (let index = 0; index < sourceNodes.length; index += 1) {
    const sourceNode = sourceNodes[index]!
    const range = sourceRange(sourceNode)
    converted.push({ node: convertBlock(sourceNode, context), range })

    const next = sourceNodes[index + 1]
    const gapEnd = next ? sourceRange(next).from : context.source.length
    const emptyRanges = emptyParagraphsBetween(context.source, range.to, gapEnd, !next)

    for (const emptyRange of emptyRanges) {
      converted.push({ node: context.emptyParagraph(emptyRange), range: emptyRange })
    }
  }

  return converted
}

/**
 * Parses only the intentional Markdown subset. The source is retained byte for
 * byte as a doc attribute; source ranges are offered only where they are exact.
 */
// Match the existing live-source rendering budget before building any AST/DOM.
export const RICH_MARKDOWN_LIMITS = { maxDocLength: 128 * 1024, maxLineLength: 32 * 1024 } as const

export function parseRichMarkdown(source: string): RichMarkdownParseResult {
  try {
    if (
      source.length > RICH_MARKDOWN_LIMITS.maxDocLength ||
      source.split('\n').some(line => line.length > RICH_MARKDOWN_LIMITS.maxLineLength)
    ) {
      throw new MarkdownRefusal('document exceeds rich editing limit')
    }

    if (hasFrontMatter(source)) {
      throw new MarkdownRefusal('front matter')
    }

    const root = parseTree(source)

    if (root.type !== 'root') {
      throw new MarkdownRefusal('invalid markdown root')
    }

    const context = new ParseContext(source)
    const topLevel = convertTopLevelBlocks(root, context)
    const children = topLevel.map(block => block.node)
    const doc = richMarkdownSchema.nodes.doc!.create({ markdown: source }, children)
    const blocks: RichMarkdownBlock[] = []
    let pos = 0

    for (let index = 0; index < children.length; index += 1) {
      blocks.push({ ...topLevel[index]!.range, node: children[index]!, pos })
      pos += children[index]!.nodeSize
    }

    return {
      blocks,
      doc,
      kind: 'parsed',
      source,
      textRanges: withEmptyTextRanges(doc, context.emptyText, directTextRanges(doc, context.emittedText))
    }
  } catch (error) {
    return { kind: 'refused', reason: error instanceof Error ? error.message : 'invalid markdown' }
  }
}

function escapeText(text: string, protectStart: boolean, protectEnd: boolean): string {
  // Markdown drops block-edge whitespace and decodes entity-shaped prose.
  // Protect those bytes, including whitespace inside mark delimiters, without
  // rewriting ordinary spaces between inline runs.
  const encode = (value: string) => Array.from(value, character => `&#${character.charCodeAt(0)};`).join('')
  const escaped = text.replace(/&(?=#[xX]?[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/gu, '&amp;').replace(/[\\`*_[\]~<>|#!+-]/gu, '\\$&')
  const start = protectStart ? escaped.replace(/^[ \t]+/u, encode) : escaped

  return protectEnd ? start.replace(/[ \t]+$/u, encode) : start
}

function serializeInlineCode(value: string): string {
  const delimiterLength = Math.max(1, ...(value.match(/`+/gu) ?? []).map(run => run.length + 1))
  const delimiter = '`'.repeat(delimiterLength)
  const padding = value.length > 0 && (/^\s/u.test(value) || /\s$/u.test(value)) ? ' ' : ''

  return `${delimiter}${padding}${value}${padding}${delimiter}`
}

function serializeInline(content: Fragment): string {
  let output = ''
  let active: Mark[] = []

  const orderedMarks = (marks: readonly Mark[]): Mark[] =>
    [...marks].sort((left, right) => {
      const order = { emphasis: 2, link: 0, strike: 3, strong: 1 }

      return (order[left.type.name as keyof typeof order] ?? 99) - (order[right.type.name as keyof typeof order] ?? 99)
    })

  const open = (mark: Mark): string => {
    if (mark.type.name === 'link' && typeof mark.attrs.href === 'string' && isSafeRichHref(mark.attrs.href)) {
      return '['
    }

    if (mark.type.name === 'strong') {
      return '**'
    }

    if (mark.type.name === 'emphasis') {
      return '*'
    }

    if (mark.type.name === 'strike') {
      return '~~'
    }

    throw new MarkdownRefusal(`cannot serialize mark ${mark.type.name}`)
  }

  const close = (mark: Mark): string => {
    if (mark.type.name === 'link') {
      return `](<${mark.attrs.href}>)`
    }

    if (mark.type.name === 'strong') {
      return '**'
    }

    if (mark.type.name === 'emphasis') {
      return '*'
    }

    if (mark.type.name === 'strike') {
      return '~~'
    }

    throw new MarkdownRefusal(`cannot serialize mark ${mark.type.name}`)
  }

  content.forEach((node, offset) => {
    const code = node.marks.find(mark => mark.type.name === 'code')

    if (code) {
      if (node.type.name !== 'text' || node.marks.length !== 1) {
        throw new MarkdownRefusal('cannot serialize nested inline code')
      }

      for (let index = active.length - 1; index >= 0; index -= 1) {
        output += close(active[index]!)
      }

      output += serializeInlineCode(node.text ?? '')
      active = []

      return
    }

    const marks = orderedMarks(node.marks)
    let shared = 0

    while (shared < active.length && shared < marks.length && active[shared]!.eq(marks[shared]!)) {
      shared += 1
    }

    for (let index = active.length - 1; index >= shared; index -= 1) {
      output += close(active[index]!)
    }

    for (let index = shared; index < marks.length; index += 1) {
      output += open(marks[index]!)
    }

    active = marks

    if (node.type.name === 'text') {
      output += escapeText(node.text ?? '', offset === 0 || marks.length > 0, offset + node.nodeSize === content.size || marks.length > 0)
    } else if (node.type.name === 'hard_break') {
      output += '\\\n'
    } else {
      throw new MarkdownRefusal(`cannot serialize inline ${node.type.name}`)
    }
  })

  for (let index = active.length - 1; index >= 0; index -= 1) {
    output += close(active[index]!)
  }

  return output
}

function indent(value: string, prefix: string): string {
  return value
    .split('\n')
    .map(line => (line ? prefix + line : prefix.trimEnd()))
    .join('\n')
}

function serializeBlocks(nodes: readonly PMNode[]): string {
  return nodes.map(serializeBlock).join('\n\n')
}

function serializeList(node: PMNode, ordered: boolean): string {
  const order = Number(node.attrs.order ?? 1)
  const items: string[] = []

  node.forEach((item, index) => {
    if (item.type.name !== 'list_item' || item.childCount === 0) {
      throw new MarkdownRefusal('cannot serialize list item')
    }

    const marker = ordered ? `${order + index}. ` : '- '
    const body = serializeBlocks(Array.from({ length: item.childCount }, (_, childIndex) => item.child(childIndex)))
    const lines = body.split('\n')
    const continuation = ' '.repeat(marker.length)
    items.push(marker + lines[0] + (lines.length > 1 ? `\n${indent(lines.slice(1).join('\n'), continuation)}` : ''))
  })

  return items.join('\n')
}

function serializeTable(node: PMNode): string {
  const rows: PMNode[] = []
  let width: number | null = null

  node.forEach(row => {
    if (row.type.name !== 'table_row') {
      throw new MarkdownRefusal('cannot serialize table row')
    }

    const cells: PMNode[] = []
    row.forEach(cell => cells.push(cell))
    width ??= cells.length

    if (!width || cells.length !== width) {
      throw new MarkdownRefusal('cannot serialize non-rectangular table')
    }

    rows.push(row)
  })

  if (!width || rows.length === 0) {
    throw new MarkdownRefusal('cannot serialize empty table')
  }

  const rowText = (row: PMNode): string => {
    const cells: string[] = []
    row.forEach(cell => {
      if (
        (cell.type.name !== 'table_header' && cell.type.name !== 'table_cell') ||
        cell.childCount !== 1 ||
        cell.firstChild?.type.name !== 'paragraph'
      ) {
        throw new MarkdownRefusal('cannot serialize table cell')
      }

      const inline = serializeInline(cell.firstChild.content)

      if (inline.includes('\n')) {
        throw new MarkdownRefusal('cannot serialize multiline table cell')
      }

      cells.push(inline)
    })

    return `| ${cells.join(' | ')} |`
  }

  const alignment = Array.from({ length: width }, (_, column) => {
    const cell = rows[0]!.child(column)

    switch (cell.attrs.align) {
      case 'left':
        return ':---'

      case 'right':
        return '---:'

      case 'center':
        return ':---:'

      default:
        return '---'
    }
  })

  return [rowText(rows[0]!), `| ${alignment.join(' | ')} |`, ...rows.slice(1).map(rowText)].join('\n')
}

function serializeBlock(node: PMNode): string {
  switch (node.type.name) {
    case 'paragraph':
      return serializeInline(node.content)

    case 'heading':
      return `${'#'.repeat(Number(node.attrs.level))} ${serializeInline(node.content)}`

    case 'blockquote':
      return serializeBlocks(Array.from({ length: node.childCount }, (_, index) => node.child(index)))
        .split('\n')
        .map(line => (line ? `> ${line}` : '>'))
        .join('\n')

    case 'bullet_list':
      return serializeList(node, false)

    case 'ordered_list':
      return serializeList(node, true)
    case 'code_block': {
      const value = node.textContent
      const params = String(node.attrs.params ?? '')
      const tickCount = Math.max(3, ...(value.match(/`+/gu) ?? []).map(run => run.length + 1))
      const fence = '`'.repeat(tickCount)

      return `${fence}${params ? params : ''}\n${value}\n${fence}`
    }

    case 'horizontal_rule':
      return '---'

    case 'table':
      return serializeTable(node)

    default:
      throw new MarkdownRefusal(`cannot serialize block ${node.type.name}`)
  }
}

/** Serializes a changed top-level block span. Callers retain untouched bytes. */
export function serializeRichBlocks(nodes: readonly PMNode[], newline: '\n' | '\r\n'): string {
  return nodes.map(serializeBlock).join(`${newline}${newline}`)
}
