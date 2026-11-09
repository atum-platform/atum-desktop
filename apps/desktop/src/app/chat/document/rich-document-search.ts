import type { Node as PMNode } from 'prosemirror-model'

import type { DocumentSelection } from './document-editor-controller'

/** PM text offsets are UTF-16, just like the query and the canonical buffer.
 * Adjacent marked runs share a text block; paragraphs and cells never do. */
export function richDocumentMatches(doc: PMNode, query: string): DocumentSelection[] {
  const matches: DocumentSelection[] = []

  if (!query) { return matches }

  doc.descendants((node, pos) => {
    if (!node.isTextblock) { return true }
    const text = node.textBetween(0, node.content.size, '', '\n')
    let index = text.indexOf(query)

    while (index !== -1) {
      matches.push({ from: pos + 1 + index, to: pos + 1 + index + query.length })
      index = text.indexOf(query, index + query.length)
    }

    return false
  })

  return matches
}

export function nextDocumentMatch(
  matches: readonly DocumentSelection[], selection: DocumentSelection, direction: 1 | -1
): DocumentSelection | null {
  if (!matches.length) { return null }
  const selected = matches.findIndex(match => match.from === selection.from && match.to === selection.to)

  if (selected !== -1) { return matches[(selected + direction + matches.length) % matches.length]! }

  return direction === 1
    ? matches.find(match => match.from >= selection.to) ?? matches[0]!
    : matches.findLast(match => match.to <= selection.from) ?? matches.at(-1)!
}
