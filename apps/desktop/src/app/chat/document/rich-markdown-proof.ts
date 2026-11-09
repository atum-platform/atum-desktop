import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * A deliberately narrow D3 proof mapper. It does not serialize a rich tree:
 * it retains the Markdown buffer and makes a validated source-range patch for
 * a supported text leaf. ProseMirror can own the corresponding rich selection
 * and history transaction once the editor-neutral host is introduced.
 */

interface MarkdownPosition {
  end?: { offset?: number }
  start?: { offset?: number }
}

interface MarkdownNode {
  children?: MarkdownNode[]
  position?: MarkdownPosition
  type: string
  value?: string
}

export interface RichMarkdownSourceRange {
  from: number
  to: number
}

export interface RichMarkdownTextRange extends RichMarkdownSourceRange {
  text: string
}

export interface RichMarkdownPatch extends RichMarkdownSourceRange {
  insert: string
}

export interface RichMarkdownRefusal {
  feature: string
  kind: 'refused'
}

export interface RichMarkdownEligible {
  kind: 'eligible'
  refusals: RichMarkdownRefusal[]
  textRanges: RichMarkdownTextRange[]
}

export interface RichMarkdownIneligible {
  kind: 'refused'
  refusals: RichMarkdownRefusal[]
  textRanges: []
}

export type RichMarkdownEligibility = RichMarkdownEligible | RichMarkdownIneligible

export type RichMarkdownOpenResult =
  | { eligibility: RichMarkdownEligible; kind: 'opened'; session: RichMarkdownProofSession }
  | { eligibility: RichMarkdownEligibility; kind: 'refused' }

const SUPPORTED_NODES = new Set([
  'root',
  'paragraph',
  'heading',
  'text',
  'emphasis',
  'strong',
  'delete',
  'link',
  'inlineCode',
  'break',
  'blockquote',
  'list',
  'listItem',
  'code',
  'table',
  'tableRow',
  'tableCell',
  'thematicBreak'
])

const PLAIN_TEXT_INSERTION = /^[^\\\r\n|*_~[\]`<>]*$/u

function parse(source: string): MarkdownNode {
  return unified().use(remarkParse).use(remarkGfm).parse(source) as unknown as MarkdownNode
}

function sourceRange(node: MarkdownNode): RichMarkdownSourceRange | null {
  const from = node.position?.start?.offset
  const to = node.position?.end?.offset

  return typeof from === 'number' && typeof to === 'number' ? { from, to } : null
}

function frontMatter(source: string): boolean {
  const firstLine = /^(---|\+\+\+)\r?\n/u.exec(source)

  if (!firstLine) {
    return false
  }

  const delimiter = firstLine[1]!
  const closing = new RegExp(`^${delimiter.replace(/[+]/gu, '\\+')}\\r?$`, 'mu')

  return closing.test(source.slice(firstLine[0].length))
}

function refusal(feature: string): RichMarkdownRefusal {
  return { feature, kind: 'refused' }
}

function inspectTree(
  source: string,
  node: MarkdownNode,
  refusals: RichMarkdownRefusal[],
  textRanges: RichMarkdownTextRange[]
) {
  if (!SUPPORTED_NODES.has(node.type)) {
    refusals.push(refusal(node.type))

    return
  }

  const range = sourceRange(node)

  if (!range) {
    refusals.push(refusal(`${node.type}: missing source range`))

    return
  }

  if (node.type === 'text') {
    const raw = source.slice(range.from, range.to)

    // Escape sequences have a different source and visible length. Refusing
    // them is safer than mapping a rich cursor onto a non-identical source run.
    if (raw.includes('\\')) {
      refusals.push(refusal('escaped inline syntax'))

      return
    }

    textRanges.push({ ...range, text: node.value ?? raw })
  }

  for (const child of node.children ?? []) {
    inspectTree(source, child, refusals, textRanges)
  }
}

export function inspectRichMarkdown(source: string): RichMarkdownEligibility {
  const refusals: RichMarkdownRefusal[] = []
  const textRanges: RichMarkdownTextRange[] = []

  if (frontMatter(source)) {
    refusals.push(refusal('front matter'))
  }

  inspectTree(source, parse(source), refusals, textRanges)

  return refusals.length > 0
    ? { kind: 'refused', refusals, textRanges: [] }
    : { kind: 'eligible', refusals, textRanges }
}

function applyPatch(source: string, patch: RichMarkdownPatch): string {
  return source.slice(0, patch.from) + patch.insert + source.slice(patch.to)
}

function sameRange(left: RichMarkdownSourceRange, right: RichMarkdownSourceRange): boolean {
  return left.from === right.from && left.to === right.to
}

function tableCellRange(
  source: string,
  tableIndex: number,
  rowIndex: number,
  columnIndex: number
): RichMarkdownSourceRange | null {
  const root = parse(source)
  const tables = (root.children ?? []).filter(node => node.type === 'table')
  const row = tables[tableIndex]?.children?.[rowIndex]
  const cell = row?.children?.[columnIndex]
  const text = cell?.children?.[0]

  // This proof edits a cell as a plain text transaction. Marks, line breaks,
  // escaped syntax and empty cells need a real schema/range-mapping extension.
  if (cell?.type !== 'tableCell' || cell.children?.length !== 1 || text?.type !== 'text') {
    return null
  }

  const range = sourceRange(text)

  return range && !source.slice(range.from, range.to).includes('\\') ? range : null
}

export class RichMarkdownProofSession {
  private readonly undoSources: string[] = []
  private currentSource: string

  private constructor(source: string) {
    this.currentSource = source
  }

  static open(source: string): RichMarkdownOpenResult {
    const eligibility = inspectRichMarkdown(source)

    return eligibility.kind === 'eligible'
      ? { eligibility, kind: 'opened', session: new RichMarkdownProofSession(source) }
      : { eligibility, kind: 'refused' }
  }

  get source(): string {
    return this.currentSource
  }

  get textRanges(): RichMarkdownTextRange[] {
    const eligibility = inspectRichMarkdown(this.currentSource)

    return eligibility.kind === 'eligible' ? eligibility.textRanges : []
  }

  replaceText(range: RichMarkdownSourceRange, insert: string): RichMarkdownPatch | null {
    if (!PLAIN_TEXT_INSERTION.test(insert) || !this.textRanges.some(candidate => sameRange(candidate, range))) {
      return null
    }

    const patch = { ...range, insert }
    this.undoSources.push(this.currentSource)
    this.currentSource = applyPatch(this.currentSource, patch)

    return patch
  }

  replaceTableCell(
    tableIndex: number,
    rowIndex: number,
    columnIndex: number,
    insert: string
  ): RichMarkdownPatch | null {
    if (!PLAIN_TEXT_INSERTION.test(insert)) {
      return null
    }

    const range = tableCellRange(this.currentSource, tableIndex, rowIndex, columnIndex)

    return range ? this.replaceText(range, insert) : null
  }

  selectionForText(text: string, occurrence = 0): RichMarkdownSourceRange | null {
    const range = this.textRanges.filter(candidate => candidate.text === text)[occurrence]

    return range ? { from: range.from, to: range.to } : null
  }

  undo(): boolean {
    const previous = this.undoSources.pop()

    if (previous === undefined) {
      return false
    }

    this.currentSource = previous

    return true
  }
}
