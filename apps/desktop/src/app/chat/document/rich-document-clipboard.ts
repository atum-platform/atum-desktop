import { Fragment, type Mark, type Node as PMNode, Slice } from 'prosemirror-model'

import { isSafeRichHref, RICH_MARKDOWN_LIMITS, richMarkdownSchema } from './rich-markdown-model'

export type RichDocumentClipboardParseResult =
  | { kind: 'parsed'; simplified: boolean; slice: Slice }
  | { kind: 'refused'; reason: string }

const MAX_DOM_NODES = 16_384
const MAX_DOM_DEPTH = 128

class ClipboardRefusal extends Error {}

interface ClipboardContext {
  wordMarkers: Set<Element>
  simplified: boolean
}

interface WordListItem {
  element: HTMLElement
  id: string
  level: number
  order: number
  ordered: boolean
}

function refusal(reason: string): never {
  throw new ClipboardRefusal(reason)
}

function addMark(marks: readonly Mark[], mark: Mark): Mark[] {
  return [...mark.addToSet(marks)]
}

function isWhitespaceText(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && !/\S/u.test(node.textContent ?? '')
}

function styleMap(element: Element): Map<string, string> {
  const result = new Map<string, string>()

  for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
    const separator = declaration.indexOf(':')

    if (separator < 0) {
      continue
    }

    const property = declaration.slice(0, separator).trim().toLowerCase()
    const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important$/u, '')

    if (property) {
      result.set(property, value)
    }
  }

  return result
}

function isHidden(element: Element, styles: ReadonlyMap<string, string>): boolean {
  return (
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    styles.get('display') === 'none' ||
    styles.get('visibility') === 'hidden' ||
    styles.get('mso-hide') === 'all'
  )
}

function isMetadataElement(element: Element): boolean {
  return ['base', 'link', 'meta', 'script', 'style', 'title'].includes(element.localName)
}

function isForbiddenElement(element: Element): boolean {
  return ['applet', 'audio', 'canvas', 'embed', 'frame', 'frameset', 'iframe', 'img', 'object', 'picture', 'source', 'svg', 'video'].includes(
    element.localName
  )
}

function isWordMetadataConditional(value: string): boolean {
  return /^\s*\[if\s+gte\s+mso\s+\d+\]>\s*<(?:style|xml)\b[\s\S]*<\/(?:style|xml)>\s*<!\[endif\]\s*$/iu.test(
    value
  )
}

/** Auditing happens before conversion so unsupported visible content cannot be
 * partially inserted. The template is owned by a detached document and never
 * reaches the live DOM. */
function auditTree(root: DocumentFragment): void {
  let nodes = 0

  const walk = (node: Node, depth: number): void => {
    nodes += 1

    if (nodes > MAX_DOM_NODES) {
      refusal('clipboard has too many HTML nodes')
    }

    if (depth > MAX_DOM_DEPTH) {
      refusal('clipboard HTML is nested too deeply')
    }

    if (node.nodeType === Node.COMMENT_NODE) {
      const value = node.nodeValue ?? ''

      // Word exposes list markers between these comments. Other conditional
      // payloads can hide meaningful nodes from the DOM parser, so refuse.
      if (
        /\[if\s+/iu.test(value) &&
        !/\[if\s+!supportlists\]/iu.test(value) &&
        !isWordMetadataConditional(value)
      ) {
        refusal('conditional Word content')
      }

      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return
    }

    const element = node as Element
    const styles = styleMap(element)

    if (isForbiddenElement(element)) {
      refusal(`${element.localName} clipboard content is not supported`)
    }

    if (isHidden(element, styles)) {
      refusal('clipboard contains hidden content')
    }

    if (isMetadataElement(element)) {
      return
    }

    for (const child of Array.from(element.childNodes)) {
      walk(child, depth + 1)
    }
  }

  for (const child of Array.from(root.childNodes)) {
    walk(child, 1)
  }
}

function marksFor(element: Element, marks: readonly Mark[], context: ClipboardContext): Mark[] {
  let result = [...marks]
  const name = element.localName
  const styles = styleMap(element)
  const weight = styles.get('font-weight')
  const fontStyle = styles.get('font-style')
  const decoration = styles.get('text-decoration') ?? styles.get('text-decoration-line')

  if (name === 'strong' || name === 'b' || weight === 'bold' || (weight !== undefined && Number(weight) >= 600)) {
    result = addMark(result, richMarkdownSchema.marks.strong!.create())
  }

  if (weight === 'normal' || (weight !== undefined && Number(weight) > 0 && Number(weight) < 600)) {
    result = result.filter(mark => mark.type.name !== 'strong')
  }

  if (name === 'em' || name === 'i' || fontStyle === 'italic' || fontStyle === 'oblique') {
    result = addMark(result, richMarkdownSchema.marks.emphasis!.create())
  }

  if (fontStyle === 'normal') {
    result = result.filter(mark => mark.type.name !== 'emphasis')
  }

  if (name === 's' || name === 'del' || name === 'strike' || decoration?.includes('line-through')) {
    result = addMark(result, richMarkdownSchema.marks.strike!.create())
  }

  if (name === 'a' && element.hasAttribute('href')) {
    const href = element.getAttribute('href')

    if (!href || !isSafeRichHref(href)) {
      refusal('unsafe clipboard link')
    }

    result = addMark(result, richMarkdownSchema.marks.link!.create({ href }))

    if (element.hasAttribute('target') || element.hasAttribute('title')) {
      context.simplified = true
    }
  }

  if (name === 'code') {
    if (result.length > 0) {
      refusal('nested inline code')
    }

    result = addMark(result, richMarkdownSchema.marks.code!.create())
  }

  if (
    name === 'font' ||
    name === 'u' ||
    ['vertical-align', 'font-family', 'font-size', 'color', 'background', 'background-color', 'line-height', 'letter-spacing', 'word-spacing', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'text-align', 'text-indent'].some(property =>
      styles.has(property)
    ) ||
    (decoration !== undefined && !/^(?:none|line-through)$/u.test(decoration)) ||
    (weight !== undefined && !/^(?:normal|bold|[1-9]00)$/u.test(weight)) ||
    (fontStyle !== undefined && !/^(?:normal|italic|oblique)$/u.test(fontStyle))
  ) {
    context.simplified = true
  }

  return result
}

function isWordListMarker(element: Element): boolean {
  return /(?:^|;)\s*mso-list\s*:\s*ignore\b/iu.test(element.getAttribute('style') ?? '')
}

function inlineNodes(nodes: readonly Node[], context: ClipboardContext, marks: readonly Mark[] = [], tableCell = false): PMNode[] {
  const output: PMNode[] = []

  const appendText = (value: string, textMarks: readonly Mark[]) => {
    // HTML collapses ordinary whitespace, but NBSP remains significant. Do the
    // same before serializing to Markdown so Word's indented source does not
    // turn into hard line breaks in a canonical paragraph.
    let normalized = value.replace(/[ \t\n\r\f]+/gu, ' ')
    const previous = output.at(-1)

    if (normalized.startsWith(' ') && previous?.isText && previous.text?.endsWith(' ')) {
      normalized = normalized.slice(1)
    }

    if (normalized) {
      output.push(richMarkdownSchema.text(normalized, textMarks))
    }
  }

  for (const node of nodes) {
    if (node.nodeType === Node.COMMENT_NODE || isWhitespaceText(node) && !node.textContent) {
      continue
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? ''

      if (value) {
        appendText(value, marks)
      }

      continue
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue
    }

    const element = node as Element
    const name = element.localName

    if (isMetadataElement(element)) {
      continue
    }

    if (isWordListMarker(element)) {
      if (!context.wordMarkers.has(element)) {
        refusal('Word list marker has no validated list context')
      }

      continue
    }

    if (name === 'o:p') {
      if (!/^[\s\u00a0]*$/u.test(element.textContent ?? '')) {
        refusal('Word placeholder contains text')
      }

      continue
    }

    if (name === 'br') {
      if (tableCell) {
        refusal('multiline table cell')
      }

      output.push(richMarkdownSchema.nodes.hard_break!.create())

      continue
    }

    if (['b', 'strong', 'i', 'em', 's', 'del', 'strike', 'span', 'font', 'u', 'a', 'code'].includes(name)) {
      output.push(...inlineNodes(Array.from(element.childNodes), context, marksFor(element, marks, context), tableCell))

      continue
    }

    if (['small', 'mark'].includes(name)) {
      context.simplified = true
      output.push(...inlineNodes(Array.from(element.childNodes), context, marks, tableCell))

      continue
    }

    refusal(`unsupported inline ${name}`)
  }

  return output
}

function paragraph(element: Element, context: ClipboardContext, marks: readonly Mark[] = []): PMNode {
  return richMarkdownSchema.nodes.paragraph!.create(null, inlineNodes(Array.from(element.childNodes), context, marks))
}

function wordListItem(element: Element, context: ClipboardContext): WordListItem | null {
  const styles = styleMap(element)
  const value = styles.get('mso-list')

  if (!value) {
    if (/\bmsolistparagraph\b/iu.test(element.className)) {
      refusal('Word list has no list metadata')
    }

    return null
  }

  const match = /\bl(\d+)\s+level(\d+)\b/iu.exec(value)

  if (!match) {
    refusal('Word list has invalid list metadata')
  }

  const marker = Array.from(element.querySelectorAll('[style]')).find(candidate => isWordListMarker(candidate))

  if (!marker) {
    refusal('Word list marker is unavailable')
  }

  const text = (marker.textContent ?? '').replace(/\u00a0/gu, ' ').trim()
  const numeric = /^(\d+)[.)]$/u.exec(text)
  const bullet = text.length > 0 && !/[\p{L}\p{N}]/u.test(text)

  if (!numeric && !bullet) {
    refusal('Word list marker is unsupported')
  }

  context.wordMarkers.add(marker)

  return {
    element: element as HTMLElement,
    id: match[1]!,
    level: Number(match[2]),
    order: numeric ? Number(numeric[1]) : 1,
    ordered: Boolean(numeric)
  }
}

function buildWordList(items: readonly WordListItem[], start: number, context: ClipboardContext): { next: number; node: PMNode } {
  const first = items[start]

  if (!first) {
    refusal('empty Word list')
  }

  const entries: PMNode[] = []
  let index = start

  while (index < items.length) {
    const item = items[index]!

    if (item.level < first.level) {
      break
    }

    if (item.level > first.level) {
      if (item.level !== first.level + 1 || entries.length === 0) {
        refusal('Word list skips a nesting level')
      }

      const nested = buildWordList(items, index, context)
      const previous = entries.pop()!
      const content = Array.from({ length: previous.childCount }, (_, at) => previous.child(at))
      content.push(nested.node)
      entries.push(richMarkdownSchema.nodes.list_item!.create(null, content))
      index = nested.next

      continue
    }

    if (item.id !== first.id || item.ordered !== first.ordered) {
      break
    }

    if (item.ordered && item.order !== first.order + entries.length) {
      refusal('restarted or discontinuous Word numbering')
    }

    entries.push(
      richMarkdownSchema.nodes.list_item!.create(null, paragraph(item.element, context, marksFor(item.element, [], context)))
    )
    index += 1
  }

  const node = first.ordered
    ? richMarkdownSchema.nodes.ordered_list!.create({ order: first.order }, entries)
    : richMarkdownSchema.nodes.bullet_list!.create(null, entries)

  return { next: index, node }
}

function list(element: Element, context: ClipboardContext, ordered: boolean, marks: readonly Mark[] = []): PMNode {
  if (Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && !isWhitespaceText(node))) {
    refusal('text outside list items')
  }

  const items: PMNode[] = []
  const order = ordered && element.hasAttribute('start') ? Number(element.getAttribute('start')) : 1

  if (ordered && (element.hasAttribute('reversed') || (element.hasAttribute('type') && element.getAttribute('type') !== '1'))) {
    refusal('non-decimal or reversed list numbering')
  }

  if (!Number.isInteger(order) || order < 1) {
    refusal('invalid ordered list start')
  }

  for (const child of Array.from(element.children)) {
    if (child.localName !== 'li') {
      refusal('invalid list content')
    }

    if (child.hasAttribute('value') && Number(child.getAttribute('value')) !== order + items.length) {
      refusal('discontinuous list numbering')
    }

    const blocks: PMNode[] = []
    const inline: Node[] = []

    const flush = () => {
      if (inline.length) {
        blocks.push(richMarkdownSchema.nodes.paragraph!.create(null, inlineNodes(inline, context, marks)))
        inline.length = 0
      }
    }

    for (const grandchild of Array.from(child.childNodes)) {
      if (grandchild.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes((grandchild as Element).localName)) {
        flush()
        blocks.push(list(grandchild as Element, context, (grandchild as Element).localName === 'ol', marks))
      } else if (grandchild.nodeType === Node.ELEMENT_NODE && (grandchild as Element).localName === 'p') {
        flush()
        blocks.push(paragraph(grandchild as Element, context, marksFor(grandchild as Element, marks, context)))
      } else {
        inline.push(grandchild)
      }
    }

    flush()

    if (!blocks.length) {
      blocks.push(richMarkdownSchema.nodes.paragraph!.create())
    }

    items.push(richMarkdownSchema.nodes.list_item!.create(null, blocks))
  }

  if (!items.length) {
    refusal('empty list')
  }

  return ordered
    ? richMarkdownSchema.nodes.ordered_list!.create({ order }, items)
    : richMarkdownSchema.nodes.bullet_list!.create(null, items)
}

function table(element: Element, context: ClipboardContext, marks: readonly Mark[] = []): PMNode {
  if (element.querySelector('caption')?.textContent?.trim()) {
    refusal('table captions are not supported')
  }

  const rows = Array.from(element.querySelectorAll('tr')).filter(row => row.closest('table') === element)

  if (!rows.length) {
    refusal('empty table')
  }

  const rowCells = rows.map(row => {
    const cells = Array.from(row.children).filter(cell => cell.localName === 'td' || cell.localName === 'th')

    if (cells.length !== row.children.length || !cells.length) {
      refusal('invalid table row')
    }

    return cells
  })

  const width = rowCells[0]!.length

  if (!width || rowCells.some(cells => cells.length !== width)) {
    refusal('non-rectangular table')
  }

  // GFM stores alignment by column. A body-cell-only alignment cannot survive
  // the canonical serializer, so the first row establishes the column value.
  const columnAlignment = rowCells[0]!.map(cell => {
    const styles = styleMap(cell)
    const value = cell.getAttribute('align') ?? styles.get('text-align') ?? null

    if (value === null) {
      return null
    }

    if (!/^(left|right|center)$/u.test(value)) {
      context.simplified = true

      return null
    }

    return value
  })

  const converted = rows.map((row, rowIndex) => {
    const cells = rowCells[rowIndex]!

    return richMarkdownSchema.nodes.table_row!.create(
      null,
      cells.map(cell => {
        const colspan = Number(cell.getAttribute('colspan') ?? '1')
        const rowspan = Number(cell.getAttribute('rowspan') ?? '1')

        if (colspan !== 1 || rowspan !== 1) {
          refusal('merged table cells are not supported')
        }

        const directElements = Array.from(cell.children).filter(
          child => !isMetadataElement(child) && child.localName !== 'o:p'
        )

        const paragraphElement = directElements.length === 1 && directElements[0]!.localName === 'p' ? directElements[0]! : null

        if (
          directElements.some(child =>
            ['div', 'ol', 'p', 'table', 'ul'].includes(child.localName) && child !== paragraphElement
          )
        ) {
          refusal('table cells must contain one paragraph')
        }

        const styles = styleMap(cell)
        const paragraphStyles = paragraphElement ? styleMap(paragraphElement) : null

        const specified =
          cell.getAttribute('align') ?? styles.get('text-align') ?? paragraphStyles?.get('text-align') ?? null

        const specifiedAlign = specified === null ? null : /^(left|right|center)$/u.test(specified) ? specified : null
        const align = columnAlignment[cells.indexOf(cell)]!

        if (specified !== null && (specifiedAlign === null || specifiedAlign !== align)) {
          context.simplified = true
        }

        const cellMarks = marksFor(cell, marks, context)

        const content = inlineNodes(
          Array.from(paragraphElement?.childNodes ?? cell.childNodes),
          context,
          paragraphElement ? marksFor(paragraphElement, cellMarks, context) : cellMarks,
          true
        )

        // Markdown tables always have a header row. Promoting a td-only first
        // row preserves its text but changes its table semantics, so tell the
        // caller that the document theme normalized this clipboard detail.
        if (rowIndex === 0 && cell.localName !== 'th') {
          context.simplified = true
        }

        const cellType = rowIndex === 0 ? richMarkdownSchema.nodes.table_header! : richMarkdownSchema.nodes.table_cell!

        return cellType.create({ align }, richMarkdownSchema.nodes.paragraph!.create(null, content))
      })
    )
  })

  return richMarkdownSchema.nodes.table!.create(null, converted)
}

function block(element: Element, context: ClipboardContext, marks: readonly Mark[] = []): PMNode[] {
  const effectiveMarks = marksFor(element, marks, context)

  switch (element.localName) {
    case 'p':
      return [paragraph(element, context, effectiveMarks)]

    case 'h1':

    case 'h2':

    case 'h3':

    case 'h4':

    case 'h5':

    case 'h6':
      return [
        richMarkdownSchema.nodes.heading!.create(
          { level: Number(element.localName.slice(1)) },
          inlineNodes(Array.from(element.childNodes), context, effectiveMarks)
        )
      ]

    case 'ul':
      return [list(element, context, false, effectiveMarks)]

    case 'ol':
      return [list(element, context, true, effectiveMarks)]

    case 'table':
      return [table(element, context, effectiveMarks)]

    case 'blockquote':
      return [richMarkdownSchema.nodes.blockquote!.create(null, flow(element, context, effectiveMarks))]

    case 'pre':
      if (Array.from(element.children).some(child => child.localName !== 'code' || child.children.length > 0)) {
        refusal('unsupported code block content')
      }

      return [
        richMarkdownSchema.nodes.code_block!.create(
          { params: '' },
          element.textContent ? richMarkdownSchema.text(element.textContent) : null
        )
      ]

    case 'hr':
      return [richMarkdownSchema.nodes.horizontal_rule!.create()]

    case 'div':

    case 'article':

    case 'body':

    case 'html':

    case 'section':
      return flow(element, context, effectiveMarks)

    case 'head':
      return []

    default:
      refusal(`unsupported block ${element.localName}`)
  }
}

function flow(container: Element | DocumentFragment, context: ClipboardContext, marks: readonly Mark[] = []): PMNode[] {
  const output: PMNode[] = []
  const inline: Node[] = []
  const children = Array.from(container.childNodes)

  const flush = () => {
    if (inline.length) {
      output.push(richMarkdownSchema.nodes.paragraph!.create(null, inlineNodes(inline, context, marks)))
      inline.length = 0
    }
  }

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!

    if (child.nodeType === Node.COMMENT_NODE || (isWhitespaceText(child) && inline.length === 0)) {
      continue
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      inline.push(child)

      continue
    }

    const element = child as Element

    // Parsing a full Word HTML document into a template flattens its head.
    // Skip metadata before accumulating inline nodes, or its indentation
    // becomes a phantom whitespace paragraph ahead of the actual content.
    if (isMetadataElement(element)) {
      if (element.localName === 'style' || element.localName === 'link') {
        context.simplified = true
      }

      continue
    }

    const word = element.localName === 'p' ? wordListItem(element, context) : null

    if (word) {
      flush()
      const words = [word]
      let next = index + 1

      while (next < children.length) {
        const candidate = children[next]!

        if (candidate.nodeType === Node.COMMENT_NODE || isWhitespaceText(candidate)) {
          next += 1

          continue
        }

        if (candidate.nodeType !== Node.ELEMENT_NODE || (candidate as Element).localName !== 'p') {
          break
        }

        const nextWord = wordListItem(candidate as Element, context)

        if (!nextWord) {
          break
        }

        words.push(nextWord)
        next += 1
      }

      let wordIndex = 0

      while (wordIndex < words.length) {
        const built = buildWordList(words, wordIndex, context)
        output.push(built.node)
        wordIndex = built.next
      }

      index = next - 1

      continue
    }

    if (['article', 'blockquote', 'body', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'html', 'ol', 'p', 'pre', 'section', 'table', 'ul'].includes(element.localName)) {
      flush()
      output.push(...block(element, context, marks))

      continue
    }

    inline.push(element)
  }

  flush()

  return output
}

/**
 * Converts only the Markdown-representable portion of a clipboard HTML
 * payload. The caller owns selection replacement and canonical-source history.
 */
export function parseRichDocumentClipboard(html: string): RichDocumentClipboardParseResult {
  try {
    if (html.length > RICH_MARKDOWN_LIMITS.maxDocLength) {
      refusal('clipboard exceeds rich editing limit')
    }

    const inert = document.implementation.createHTMLDocument('rich-clipboard')
    const template = inert.createElement('template')
    template.innerHTML = html
    auditTree(template.content)

    const context: ClipboardContext = { simplified: false, wordMarkers: new Set() }
    const blocks = flow(template.content, context)

    if (!blocks.length) {
      return { kind: 'parsed', simplified: context.simplified, slice: Slice.empty }
    }

    // Match ProseMirror's clipboard shape: a single paragraph can splice into
    // an active paragraph, while multi-block/table content keeps its required
    // structure when the selection needs block replacement.
    return { kind: 'parsed', simplified: context.simplified, slice: Slice.maxOpen(Fragment.from(blocks), false) }
  } catch (error) {
    return { kind: 'refused', reason: error instanceof Error ? error.message : 'invalid clipboard HTML' }
  }
}
