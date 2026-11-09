import { describe, expect, it } from 'vitest'

import { inspectRichMarkdown, RichMarkdownProofSession } from './rich-markdown-proof'

const CORPUS =
  '# Tiêu đề\r\n\r\nBefore **bold** and [link](https://example.test).\r\n\r\n| One | Two |\r\n| --- | --- |\r\n| cell | giữ nguyên |\r\n\r\nAfter  \r\n'

describe('RichMarkdownProofSession', () => {
  it('patches exactly one rich text source range and preserves all unaffected bytes', () => {
    const opened = RichMarkdownProofSession.open(CORPUS)
    expect(opened.kind).toBe('opened')

    if (opened.kind !== 'opened') {
      return
    }

    const selection = opened.session.selectionForText('bold')
    expect(selection).toEqual({ from: CORPUS.indexOf('bold'), to: CORPUS.indexOf('bold') + 4 })

    const patch = opened.session.replaceText(selection!, 'stronger')
    expect(patch).toEqual({ ...selection, insert: 'stronger' })
    expect(opened.session.source).toBe(CORPUS.slice(0, selection!.from) + 'stronger' + CORPUS.slice(selection!.to))
    expect(opened.session.source).toContain('\r\n| One | Two |\r\n| --- | --- |\r\n| cell | giữ nguyên |\r\n')
    expect(opened.session.source.endsWith('After  \r\n')).toBe(true)
  })

  it('maps a simple GFM table cell to its exact source text, then undoes without reserializing', () => {
    const opened = RichMarkdownProofSession.open(CORPUS)
    expect(opened.kind).toBe('opened')

    if (opened.kind !== 'opened') {
      return
    }

    const patch = opened.session.replaceTableCell(0, 1, 0, 'đã sửa')
    expect(patch).toEqual({
      from: CORPUS.indexOf('cell'),
      insert: 'đã sửa',
      to: CORPUS.indexOf('cell') + 4
    })
    expect(opened.session.source).toContain('| đã sửa | giữ nguyên |')
    expect(opened.session.undo()).toBe(true)
    expect(opened.session.source).toBe(CORPUS)
    expect(opened.session.undo()).toBe(false)
  })

  it('refuses unsupported block and inline syntax before a rich session can write', () => {
    const unsupported = [
      ['HTML block', '<div>opaque</div>\n'],
      ['inline HTML', 'Text <span>opaque</span>\n'],
      ['footnote', '[^note]\n\n[^note]: opaque\n'],
      ['reference link', '[reference][id]\n\n[id]: https://example.test\n'],
      ['front matter', '---\ntitle: document\n---\n\ntext\n'],
      ['escaped inline syntax', 'Escaped \\*stars\\*\n']
    ] as const

    for (const [_name, source] of unsupported) {
      const result = RichMarkdownProofSession.open(source)
      expect(result.kind).toBe('refused')
      expect(result.eligibility.textRanges).toEqual([])
    }
  })

  it('does not claim a no-op open or unsupported insertion changed the canonical buffer', () => {
    const opened = RichMarkdownProofSession.open(CORPUS)
    expect(opened.kind).toBe('opened')

    if (opened.kind !== 'opened') {
      return
    }

    const selection = opened.session.selectionForText('Before')
    expect(opened.session.source).toBe(CORPUS)
    expect(opened.session.replaceText(selection!, 'line\nbreak')).toBeNull()
    expect(opened.session.replaceTableCell(0, 1, 0, 'contains | pipe')).toBeNull()
    expect(opened.session.source).toBe(CORPUS)
  })

  it('exposes a concrete eligibility result for routing before the editor mounts', () => {
    const eligibility = inspectRichMarkdown(CORPUS)
    expect(eligibility.kind).toBe('eligible')
    expect(eligibility.textRanges.map(range => range.text)).toContain('giữ nguyên')
  })
})
