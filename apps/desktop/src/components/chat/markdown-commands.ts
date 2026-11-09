import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, Transaction } from '@codemirror/state'
import { type Command, type EditorView, type KeyBinding } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

export interface ActiveFormats {
  code: boolean
  codeBlock: boolean
  emphasis: boolean
  heading: 0 | 1 | 2 | 3 | 4 | 5 | 6
  link: boolean
  list: boolean
  orderedList: boolean
  quote: boolean
  strikethrough: boolean
  strong: boolean
}

interface Replacement {
  from: number
  insert: string
  selection: { anchor: number; head?: number }
  to: number
}

const userEvent = Transaction.userEvent.of('input.format')

function dispatchReplacement(view: EditorView, replacement: Replacement): boolean {
  view.dispatch({
    annotations: userEvent,
    changes: { from: replacement.from, insert: replacement.insert, to: replacement.to },
    scrollIntoView: true,
    selection: replacement.selection
  })

  return true
}

function ancestorAt(state: EditorState, names: readonly string[]): SyntaxNode | null {
  const range = state.selection.main
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(range.head, -1)

  while (node) {
    if (names.includes(node.name) && range.from >= node.from && range.to <= node.to) {
      return node
    }

    node = node.parent
  }

  return null
}

function delimiterBounds(node: SyntaxNode, markName: string): { contentFrom: number; contentTo: number } | null {
  const first = node.firstChild
  const last = node.lastChild

  if (!first || !last || first.name !== markName || last.name !== markName) {
    return null
  }

  return { contentFrom: first.to, contentTo: last.from }
}

function wordAt(state: EditorState, position: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(position)
  const offset = position - line.from

  if (typeof Intl.Segmenter === 'function') {
    const segments = new Intl.Segmenter('vi', { granularity: 'word' }).segment(line.text)

    for (const segment of segments) {
      const end = segment.index + segment.segment.length

      // Leading boundary belongs to the word; the trailing boundary is whitespace.
      if (segment.isWordLike && segment.index <= offset && offset < end) {
        return { from: line.from + segment.index, to: line.from + end }
      }
    }
  }

  const word = /[\p{L}\p{M}\p{N}]+/gu
  let match: RegExpExecArray | null

  while ((match = word.exec(line.text))) {
    const end = match.index + match[0].length

    if (match.index <= offset && offset < end) {
      return { from: line.from + match.index, to: line.from + end }
    }
  }

  return null
}

/** A code-span delimiter must be a backtick run longer than any run inside the content. */
function codeSpanDelimiter(content: string): string {
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/gu), match => match[0].length))

  return '`'.repeat(longest + 1)
}

function toggleInline(delimiter: string | ((content: string) => string), nodeName: string, markName: string): Command {
  return view => {
    const state = view.state
    const enclosing = ancestorAt(state, [nodeName])

    if (enclosing) {
      const bounds = delimiterBounds(enclosing, markName)

      if (bounds) {
        const content = state.sliceDoc(bounds.contentFrom, bounds.contentTo)

        return dispatchReplacement(view, {
          from: enclosing.from,
          insert: content,
          selection: { anchor: enclosing.from, head: enclosing.from + content.length },
          to: enclosing.to
        })
      }
    }

    const main = state.selection.main
    const target = main.empty ? wordAt(state, main.head) : { from: main.from, to: main.to }

    if (!target) {
      const empty = typeof delimiter === 'string' ? delimiter : delimiter('')

      return dispatchReplacement(view, {
        from: main.head,
        insert: empty + empty,
        selection: { anchor: main.head + empty.length },
        to: main.head
      })
    }

    const raw = state.sliceDoc(target.from, target.to)
    const mark = typeof delimiter === 'string' ? delimiter : delimiter(raw)
    // A code span whose content starts or ends with a backtick needs one space
    // of padding on both sides, which CommonMark strips again on parse.
    const pad = typeof delimiter !== 'string' && (raw.startsWith('`') || raw.endsWith('`')) ? ' ' : ''
    const content = `${pad}${raw}${pad}`

    return dispatchReplacement(view, {
      from: target.from,
      insert: `${mark}${content}${mark}`,
      selection: {
        anchor: target.from + mark.length,
        head: target.from + mark.length + content.length
      },
      to: target.to
    })
  }
}

export const toggleStrong: Command = toggleInline('**', 'StrongEmphasis', 'EmphasisMark')
export const toggleEmphasis: Command = toggleInline('*', 'Emphasis', 'EmphasisMark')
export const toggleStrikethrough: Command = toggleInline('~~', 'Strikethrough', 'StrikethroughMark')
export const toggleInlineCode: Command = toggleInline(codeSpanDelimiter, 'InlineCode', 'CodeMark')

function touchedLines(state: EditorState): { from: number; text: string; to: number }[] {
  const range = state.selection.main
  const first = state.doc.lineAt(range.from).number
  let last = state.doc.lineAt(range.to).number

  if (!range.empty && last > first && range.to === state.doc.line(last).from) {
    last--
  }

  const lines = []

  for (let number = first; number <= last; number++) {
    const line = state.doc.line(number)
    lines.push({ from: line.from, text: line.text, to: line.to })
  }

  return lines
}

const structuralPrefix = /^(\s*(?:(?:>\s*)|(?:(?:[-+*]|\d+[.)])\s+))*)/

/** Apply a named paragraph style without cycling or rewriting inline text. */
export function setHeading(level: number): Command {
  return view => {
    if (!Number.isInteger(level) || level < 0 || level > 6) {
      return false
    }

    const state = view.state
    const lines = touchedLines(state)

    // A style command must never turn the contents of a code fence into prose.
    if (
      lines.some(line => {
        let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + line.text.length, -1)

        while (node) {
          if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'Table'].includes(node.name)) {
            return true
          }

          node = node.parent
        }

        return false
      })
    ) {
      return false
    }

    const changes = lines.map(line => {
      const prefix = structuralPrefix.exec(line.text)?.[0] ?? ''
      const rest = line.text.slice(prefix.length)
      const marker = /^(#{1,6})\s+/.exec(rest)?.[0] ?? ''

      return {
        from: line.from + prefix.length,
        to: line.from + prefix.length + marker.length,
        insert: level ? `${'#'.repeat(level)} ` : ''
      }
    })

    view.dispatch({
      annotations: userEvent,
      changes,
      selection: state.selection.map(state.changes(changes)),
      scrollIntoView: true
    })

    return true
  }
}

export const cycleHeading: Command = view => {
  const state = view.state
  const lines = touchedLines(state)

  const changes = lines.map(line => {
    const prefix = structuralPrefix.exec(line.text)?.[0] ?? ''
    const rest = line.text.slice(prefix.length)
    const heading = /^(#{1,6})(\s+)(.*)$/.exec(rest)
    const level = heading ? heading[1].length : 0
    const next = level >= 1 && level <= 3 ? (level + 1) % 4 : 1
    const content = heading ? heading[3] : rest
    const insert = `${prefix}${next ? `${'#'.repeat(next)} ` : ''}${content}`

    return { from: line.from, insert, to: line.to }
  })

  view.dispatch({
    annotations: userEvent,
    changes,
    scrollIntoView: true,
    selection: state.selection.map(state.changes(changes))
  })

  return true
}

function quotePrefix(text: string): string {
  return /^(\s*(?:>\s*)*)/.exec(text)?.[0] ?? ''
}

export const toggleBulletList: Command = view => {
  const state = view.state
  const lines = touchedLines(state)
  const allBulleted = lines.every(line => /^[-+*]\s+/.test(line.text.slice(quotePrefix(line.text).length)))

  const changes = lines.map(line => {
    const prefix = quotePrefix(line.text)
    const rest = line.text.slice(prefix.length)

    const insert = allBulleted
      ? prefix + rest.replace(/^[-+*]\s+/, '')
      : prefix + (rest.match(/^[-+*]\s+/) ? rest : `- ${rest}`)

    return { from: line.from, insert, to: line.to }
  })

  view.dispatch({
    annotations: userEvent,
    changes,
    scrollIntoView: true,
    selection: state.selection.map(state.changes(changes))
  })

  return true
}

/** Toggle a line prefix on every touched line, keeping whatever `keep` matches in front. */
function toggleLinePrefix(matches: RegExp, insert: string, keep: (text: string) => string): Command {
  return view => {
    const state = view.state
    const lines = touchedLines(state)
    const allOn = lines.every(line => matches.test(line.text.slice(keep(line.text).length)))

    const changes = lines.map(line => {
      const prefix = keep(line.text)
      const rest = line.text.slice(prefix.length)

      const next = allOn
        ? prefix + rest.replace(matches, '')
        : prefix + (matches.test(rest) ? rest : `${insert}${rest}`)

      return { from: line.from, insert: next, to: line.to }
    })

    view.dispatch({
      annotations: userEvent,
      changes,
      scrollIntoView: true,
      selection: state.selection.map(state.changes(changes))
    })

    return true
  }
}

export const toggleOrderedList: Command = toggleLinePrefix(/^\d+[.)]\s+/, '1. ', quotePrefix)
// Quotes wrap everything, so the leading indentation is all that stays in front.
export const toggleQuote: Command = toggleLinePrefix(/^>\s?/, '> ', text => /^\s*/.exec(text)?.[0] ?? '')

/**
 * Wrap the touched lines in a fence, or remove the fence that contains the
 * selection. Removal is by the fence's own lines, so the content is untouched.
 */
export const toggleCodeBlock: Command = view => {
  const state = view.state
  const fence = ancestorAt(state, ['FencedCode'])

  if (fence) {
    const first = state.doc.lineAt(fence.from)
    const last = state.doc.lineAt(fence.to)

    const changes = [
      { from: first.from, insert: '', to: Math.min(first.to + 1, state.doc.length) },
      ...(last.number !== first.number ? [{ from: Math.max(last.from - 1, 0), insert: '', to: last.to }] : [])
    ]

    view.dispatch({
      annotations: userEvent,
      changes,
      scrollIntoView: true,
      selection: state.selection.map(state.changes(changes))
    })

    return true
  }

  const lines = touchedLines(state)
  const from = lines[0]!.from
  const to = lines.at(-1)!.to
  const body = state.sliceDoc(from, to)
  // The fence must be longer than any backtick run in the body, or a line of
  // three backticks inside it would close the block early.
  const longest = Math.max(2, ...Array.from(body.matchAll(/`+/gu), match => match[0].length))
  const fenceMark = '`'.repeat(longest + 1)

  return dispatchReplacement(view, {
    from,
    insert: `${fenceMark}\n${body}\n${fenceMark}`,
    selection: { anchor: from + fenceMark.length + 1, head: from + fenceMark.length + 1 + body.length },
    to
  })
}

/** The top-level block containing `position`: a fence, list, quote or paragraph. */
function enclosingBlock(state: EditorState, position: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, -1)

  while (node && node.parent && node.parent.name !== 'Document') {
    node = node.parent
  }

  return node && node.name !== 'Document' ? node : null
}

/**
 * A two-column GFM table as its own block, after whatever block contains the
 * selection, so it can never land inside a fence, a list item or a quote where
 * it would be literal text rather than a table. The header words are the
 * caller's, because they are written into the person's document.
 */
export function insertTable(labels: { column: string }): Command {
  return view => {
    const state = view.state
    const block = enclosingBlock(state, state.selection.main.to)
    const at = block ? block.to : state.doc.lineAt(state.selection.main.to).to
    const lead = at === 0 || state.doc.lineAt(at).text.length === 0 ? (at === 0 ? '' : '\n') : '\n\n'
    const header = `${labels.column} 1`
    const table = `${lead}| ${header} | ${labels.column} 2 |\n| --- | --- |\n|  |  |`
    const cellFrom = at + lead.length + 2

    return dispatchReplacement(view, {
      from: at,
      insert: table,
      selection: { anchor: cellFrom, head: cellFrom + header.length },
      to: at
    })
  }
}

export const insertLink: Command = view => {
  const state = view.state
  const link = ancestorAt(state, ['Link'])

  if (link) {
    const url = link.getChild('URL')

    if (url) {
      view.dispatch({
        annotations: userEvent,
        scrollIntoView: true,
        selection: EditorSelection.single(url.from, url.to)
      })

      return true
    }
  }

  const range = state.selection.main

  if (range.empty) {
    return dispatchReplacement(view, {
      from: range.head,
      insert: '[văn bản](url)',
      selection: { anchor: range.head + 1, head: range.head + 8 },
      to: range.head
    })
  }

  const label = state.sliceDoc(range.from, range.to)
  const urlFrom = range.from + label.length + 3

  return dispatchReplacement(view, {
    from: range.from,
    insert: `[${label}](url)`,
    selection: { anchor: urlFrom, head: urlFrom + 3 },
    to: range.to
  })
}

export const markdownKeymap: KeyBinding[] = [
  { key: 'Mod-b', preventDefault: true, run: toggleStrong },
  { key: 'Mod-i', preventDefault: true, run: toggleEmphasis },
  { key: 'Mod-Shift-x', preventDefault: true, run: toggleStrikethrough },
  { key: 'Mod-e', preventDefault: true, run: toggleInlineCode },
  { key: 'Mod-Shift-8', preventDefault: true, run: toggleBulletList },
  { key: 'Mod-Shift-7', preventDefault: true, run: toggleOrderedList },
  { key: 'Mod-Shift-9', preventDefault: true, run: toggleQuote },
  { key: 'Mod-k', preventDefault: true, run: insertLink }
]

export function activeFormats(state: EditorState): ActiveFormats {
  const line = state.doc.lineAt(state.selection.main.head)
  const text = line.text
  const prefix = structuralPrefix.exec(text)?.[0] ?? ''
  const heading = /^(#{1,6})\s+/.exec(text.slice(prefix.length))

  let headingNode: SyntaxNode | null = syntaxTree(state).resolveInner(
    line.from + prefix.length + (heading?.[0].length ?? 0),
    1
  )

  while (headingNode && !/^ATXHeading[1-6]$/.test(headingNode.name)) {
    headingNode = headingNode.parent
  }

  const afterQuote = text.slice(quotePrefix(text).length)

  return {
    code: ancestorAt(state, ['InlineCode']) !== null,
    codeBlock: ancestorAt(state, ['FencedCode']) !== null,
    emphasis: ancestorAt(state, ['Emphasis']) !== null,
    heading: heading && headingNode ? (heading[1].length as ActiveFormats['heading']) : 0,
    link: ancestorAt(state, ['Link']) !== null,
    list: /^[-+*]\s+/.test(afterQuote),
    orderedList: /^\d+[.)]\s+/.test(afterQuote),
    quote: /^\s*>/.test(text),
    strikethrough: ancestorAt(state, ['Strikethrough']) !== null,
    strong: ancestorAt(state, ['StrongEmphasis']) !== null
  }
}
