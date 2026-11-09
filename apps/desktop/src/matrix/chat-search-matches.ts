/**
 * Search in the open chat (launch night, 2026-10-04): what the header's search finds and how
 * it is ordered. It reads the words of the messages as the transcript shows them — the loaded
 * timeline, which the transcript renders whole — and never the controls around them: sender
 * lines, buttons, a quoted reply (its own message is found where it is), steps or the live
 * turn. Matching folds case and Vietnamese marks the way the roster search does, so "da lat"
 * finds "Đà Lạt", and a match may cross formatting ("Đà **Lạt**") but never a paragraph.
 */

/** A message's words: an answer's content, or your own bubble. */
export const CHAT_SEARCH_CONTENT = '[data-slot="aui_assistant-message-content"], [data-slot="aui_user-bubble-actions"]'

/** Inside a message, what is not its words. */
const NOT_WORDS = [
  'button',
  '[role="button"]',
  '[aria-hidden="true"]',
  '.sr-only',
  'svg',
  'input',
  'textarea',
  'script',
  'style',
  '.katex-mathml',
  '[data-matrix-reply-quote]',
  '[data-matrix-undecryptable]'
].join(', ')

const BLOCKS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BR',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL'
])

/** One character as search compares it: no marks, lower case, đ as d, any space as one. */
export function foldSearchChar(char: string): string {
  if (/\s/u.test(char)) {
    return ' '
  }

  return char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/gu, 'd')
}

/** A query as search compares it; empty when there is nothing to look for. */
export function foldSearchQuery(query: string): string {
  return Array.from(query, foldSearchChar).join('').trim().replace(/ +/gu, ' ')
}

/** Plain message text follows the same folding rules and never matches across a line break. */
export function textMatchesChatSearch(text: string, query: string): boolean {
  const needle = foldSearchQuery(query)

  return Boolean(
    needle &&
    text
      .split(/\r?\n/gu)
      .some(line => Array.from(line, foldSearchChar).join('').trim().replace(/ +/gu, ' ').includes(needle))
  )
}

interface Position {
  node: Text
  offset: number
  length: number
}

function blockOf(node: Node, root: Element): Element {
  for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
    if (BLOCKS.has(element.tagName)) {
      return element
    }
  }

  return root
}

/** A message's words folded into one string, each folded character pointing at its source. */
function foldMessage(content: Element): { text: string; positions: (Position | null)[] } {
  const walker = content.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT)
  const positions: (Position | null)[] = []
  let text = ''
  let block: Element | null = null

  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    // Only what is inside the message counts: a dialog hiding the whole window from screen
    // readers (aria-hidden on an ancestor) must not empty the search.
    const control = node.parentElement?.closest(NOT_WORDS)

    if (!node.data || (control && content.contains(control))) {
      continue
    }

    const nodeBlock = blockOf(node, content)

    // A new paragraph, item or cell: a break no query can cross.
    if (block && nodeBlock !== block) {
      text += '\n'
      positions.push(null)
    }

    block = nodeBlock
    let offset = 0

    for (const char of node.data) {
      const folded = foldSearchChar(char)

      for (const unit of folded) {
        // Runs of space read as one, as the query's do.
        if (unit === ' ' && (text.endsWith(' ') || text.endsWith('\n') || text === '')) {
          continue
        }

        text += unit
        positions.push({ node, offset, length: char.length })
      }

      offset += char.length
    }
  }

  return { text, positions }
}

/**
 * Every match of `query` among the messages under `root`, newest first (the one nearest the
 * message box is the first result), as DOM ranges over the words on screen.
 */
export function findChatMatches(root: ParentNode, query: string): Range[] {
  const needle = foldSearchQuery(query)

  if (!needle) {
    return []
  }

  const matches: Range[] = []

  for (const content of root.querySelectorAll(CHAT_SEARCH_CONTENT)) {
    const { text, positions } = foldMessage(content)

    for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) {
      const start = positions[index]
      const end = positions[index + needle.length - 1]

      if (!start || !end) {
        continue
      }

      const range = content.ownerDocument.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset + end.length)
      matches.push(range)
    }
  }

  return matches.reverse()
}

/** The same match after the transcript changed, or -1 when it is gone. */
export function sameMatchIndex(matches: readonly Range[], previous: Range | undefined): number {
  if (!previous) {
    return -1
  }

  return matches.findIndex(
    range =>
      range.startContainer === previous.startContainer &&
      range.startOffset === previous.startOffset &&
      range.endContainer === previous.endContainer &&
      range.endOffset === previous.endOffset
  )
}

/** Where a step lands: up is older (a higher number), down is newer; both wrap around. */
export function stepMatch(current: number, count: number, direction: 'older' | 'newer'): number {
  if (count === 0) {
    return -1
  }

  return direction === 'older' ? (current + 1) % count : (current - 1 + count) % count
}
