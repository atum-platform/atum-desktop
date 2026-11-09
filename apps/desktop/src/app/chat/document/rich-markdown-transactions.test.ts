import { splitBlock, toggleMark } from 'prosemirror-commands'
import { EditorState, TextSelection } from 'prosemirror-state'
import { addRowAfter } from 'prosemirror-tables'
import { describe, expect, it } from 'vitest'

import { parseRichMarkdown, richMarkdownSchema as schema } from './rich-markdown-model'
import { prepareRichTransaction, richSelectionToSource } from './rich-markdown-transactions'

function open(source: string) {
  const parsed = parseRichMarkdown(source)

  if (parsed.kind !== 'parsed') {
    throw new Error(parsed.reason)
  }

  return { parsed, state: EditorState.create({ doc: parsed.doc }) }
}

describe('rich transactions into canonical source', () => {
  it('ordinary typing patches existing marked text and preserves all other CRLF bytes', () => {
    const source = '# Tiêu đề\r\n\r\nBefore **bold** 👩🏽‍💻.  \r\nNext.\r\n'
    const { parsed, state } = open(source)
    const range = parsed.textRanges.find(item => item.text === 'bold')!
    const result = prepareRichTransaction(parsed, state, state.tr.insertText('er', range.pos + 4))
    expect(result.kind).toBe('accepted')

    if (result.kind !== 'accepted') {
      return
    }

    expect(result.parsed.source).toBe(source.replace('**bold**', '**bolder**'))
    expect(result.patch).toEqual({ from: source.indexOf('bold') + 4, to: source.indexOf('bold') + 4, insert: 'er' })
    expect(result.state.doc.content.eq(result.parsed.doc.content)).toBe(true)
  })

  it('edits existing and empty table cells without normalizing other cells or delimiter padding', () => {
    const source = '| One  | Two |\r\n| :--- | ---: |\r\n| cell |     |\r\n'
    const { parsed, state } = open(source)

    for (const text of ['cell', '']) {
      const range = parsed.textRanges.find(item => item.text === text)!
      expect(range).toBeDefined()

      const result = prepareRichTransaction(
        parsed,
        state,
        state.tr.insertText('đã sửa', range.pos, range.pos + text.length)
      )

      expect(result.kind).toBe('accepted')

      if (result.kind !== 'accepted') {
        continue
      }

      expect(result.parsed.source).toBe(source.slice(0, range.from) + 'đã sửa' + source.slice(range.to))
    }
  })

  it('serializes only the formatted block and keeps untouched prefix and suffix bytes', () => {
    const source = 'First   \r\n\r\nhello world\r\n\r\nLast.  \r\n'
    const { parsed, state } = open(source)
    const range = parsed.textRanges.find(item => item.text === 'hello world')!
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, range.pos, range.pos + 5)))
    toggleMark(schema.marks.strong!)(selected, tr => {
      const result = prepareRichTransaction(parsed, selected, tr)
      expect(result.kind).toBe('accepted')

      if (result.kind === 'accepted') {
        expect(result.parsed.source).toBe(source.replace('hello world', '**hello** world'))
      }
    })
  })

  it('supports ordinary Enter at the end and typing in the new empty paragraph', () => {
    const { parsed, state } = open('Hello')
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6)))
    let called = false
    splitBlock(selected, tr => {
      called = true
      const result = prepareRichTransaction(parsed, selected, tr)
      expect(result.kind).toBe('accepted')

      if (result.kind !== 'accepted') {
        return
      }

      expect(result.parsed.source).toBe('Hello\n\n')
      const next = prepareRichTransaction(result.parsed, result.state, result.state.tr.insertText('Next'))
      expect(next.kind).toBe('accepted')

      if (next.kind === 'accepted') {
        expect(next.parsed.source).toBe('Hello\n\nNext')
      }
    })
    expect(called).toBe(true)
  })

  it('types in each leading, middle, trailing and whitespace-only paragraph without merging neighbors', () => {
    for (const source of ['Alpha\n\n\n\nBeta\n\n', '\n\n\n\nAlpha', 'Alpha\r\n\r\n\r\n\r\n', '\n\n\n\n']) {
      const { parsed, state } = open(source)
      const empties = parsed.textRanges.filter(range => range.text === '')
      expect(empties.length).toBeGreaterThan(0)

      for (const range of empties) {
        const result = prepareRichTransaction(parsed, state, state.tr.insertText('x', range.pos))
        expect(result.kind).toBe('accepted')

        if (result.kind === 'accepted') {
          const full = open(result.parsed.source)
          expect(full.parsed.doc.content.eq(result.state.doc.content)).toBe(true)
          expect(result.parsed.source).toBe(source.slice(0, range.from) + 'x' + source.slice(range.to))
        }
      }
    }
  })

  it('keeps incremental validation equivalent to a full document parse at text boundaries', () => {
    const fixtures = [
      'Alpha\n\nBeta\n\nGamma\n',
      '# Alpha\r\n\r\nBefore **bold** and *italic*.\r\n\r\nAfter\r\n',
      'Above\n\n| Header | Two |\n| --- | --- |\n| cell |  |\n\nBelow\n',
      '- Alpha\n- Beta\n\nAfter\n',
      '> First\n>\n> Second\n\nAfter\n',
      'Before\n\n```js\nvalue\n```\n\nAfter\n',
      'Alpha\n\n\n\nBeta\n\n',
      '\n\n\n\n',
      '\n\n\n\nAlpha',
      'Alpha\r\n\r\n\r\n\r\n'
    ]

    for (const source of fixtures) {
      const { parsed, state } = open(source)

      for (const range of parsed.textRanges) {
        for (const offset of new Set([0, Math.floor(range.text.length / 2), range.text.length])) {
          for (const text of ['x', ' ', '*', '\\', '[', ']', '|', '#', '-', '`', '\n', 'ế', '😀']) {
            const result = prepareRichTransaction(parsed, state, state.tr.insertText(text, range.pos + offset))

            if (result.kind === 'accepted') {
              const full = open(result.parsed.source)
              expect(full.parsed.doc.content.eq(result.state.doc.content)).toBe(true)
            } else {
              expect(state.doc.eq(parsed.doc)).toBe(true)
              expect(parsed.source).toBe(source)
            }
          }
        }
      }
    }
  })

  it('can add a table row while keeping surrounding blocks exact', () => {
    const { parsed, state } = open('Before\n\n| A | B |\n| --- | --- |\n| one | two |\n\nAfter\n')
    const range = parsed.textRanges.find(item => item.text === 'one')!
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, range.pos)))
    let called = false
    addRowAfter(selected, tr => {
      called = true
      const result = prepareRichTransaction(parsed, selected, tr)
      expect(result.kind).toBe('accepted')

      if (result.kind === 'accepted') {
        expect(result.parsed.source.startsWith('Before\n\n')).toBe(true)
        expect(result.parsed.source.endsWith('\n\nAfter\n')).toBe(true)
        expect(result.state.doc.child(1).childCount).toBe(3)
      }
    })
    expect(called).toBe(true)
  })

  it('rejects nonrepresentable table spans without changing source, state or selection', () => {
    const { parsed, state } = open('| A | B |\n| --- | --- |\n| one | two |\n')
    let cell = 0
    state.doc.descendants((node, pos) => {
      if (!cell && node.type.name === 'table_cell') {
        cell = pos
      }
    })
    const original = state.toJSON()

    const result = prepareRichTransaction(
      parsed,
      state,
      state.tr.setNodeMarkup(cell, undefined, { colspan: 2, rowspan: 1, colwidth: null, align: null })
    )

    expect(result.kind).toBe('refused')
    expect(state.toJSON()).toEqual(original)
    expect(parsed.source).toBe('| A | B |\n| --- | --- |\n| one | two |\n')
  })

  it('maps exact UTF-16 selected source and refuses guessed offsets in decoded text', () => {
    const { parsed } = open('A **👩🏽‍💻** and &amp; text.')
    const emoji = parsed.textRanges.find(item => item.text === '👩🏽‍💻')!
    expect(richSelectionToSource(parsed, emoji.pos, emoji.pos + emoji.text.length)).toEqual({
      from: emoji.from,
      to: emoji.to
    })
    expect(richSelectionToSource(parsed, parsed.doc.content.size - 3, parsed.doc.content.size - 2)).toBeNull()
  })
})
