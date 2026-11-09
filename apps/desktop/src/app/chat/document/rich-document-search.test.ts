import { describe, expect, it } from 'vitest'

import { nextDocumentMatch, richDocumentMatches } from './rich-document-search'
import { parseRichMarkdown } from './rich-markdown-model'

function doc(source: string) {
  const parsed = parseRichMarkdown(source)

  if (parsed.kind !== 'parsed') { throw new Error(parsed.reason) }

  return parsed.doc
}

describe('visible document search', () => {
  it('finds across inline marks and decoded text, without matching source delimiters or link destinations', () => {
    const document = doc('Xin **chào** *Atum* &amp; bạn. [Link](https://hidden.test)')
    const matches = richDocumentMatches(document, 'Xin chào Atum & bạn')
    expect(matches).toEqual([{ from: 1, to: 1 + 'Xin chào Atum & bạn'.length }])
    expect(document.textBetween(matches[0]!.from, matches[0]!.to)).toBe('Xin chào Atum & bạn')
    expect(richDocumentMatches(document, '**')).toEqual([])
    expect(richDocumentMatches(document, 'hidden.test')).toEqual([])
    expect(richDocumentMatches(document, 'Link')).toHaveLength(1)
  })

  it('does not join separate paragraphs, list items, or table cells', () => {
    for (const source of ['foo\n\nbar', '- foo\n- bar', '| foo | bar |\n| --- | --- |']) {
      expect(richDocumentMatches(doc(source), 'foobar')).toEqual([])
      expect(richDocumentMatches(doc(source), 'foo bar')).toEqual([])
    }
  })

  it('maps UTF-16 positions for emoji and preserves hard breaks as a text boundary', () => {
    const document = doc('👩🏽‍💻 foo  \nbar')
    const match = richDocumentMatches(document, 'foo\nbar')[0]!
    expect(document.textBetween(match.from, match.to, '', '\n')).toBe('foo\nbar')
    expect(richDocumentMatches(document, 'foobar')).toEqual([])
  })

  it('wraps both directions and advances only nonoverlapping literal matches', () => {
    const matches = richDocumentMatches(doc('aaaa'), 'aa')
    expect(matches).toEqual([{ from: 1, to: 3 }, { from: 3, to: 5 }])
    expect(nextDocumentMatch(matches, { from: 0, to: 0 }, 1)).toEqual(matches[0])
    expect(nextDocumentMatch(matches, matches[0]!, -1)).toEqual(matches[1])
    expect(nextDocumentMatch(matches, matches[1]!, 1)).toEqual(matches[0])
    expect(nextDocumentMatch(matches, { from: 4, to: 4 }, -1)).toEqual(matches[0])
    expect(richDocumentMatches(doc('one'), '')).toEqual([])
    expect(nextDocumentMatch([], { from: 0, to: 0 }, 1)).toBeNull()
  })
})
