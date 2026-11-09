import { describe, expect, it } from 'vitest'

import { parseRichMarkdown, RICH_MARKDOWN_LIMITS, richMarkdownSchema, serializeRichBlocks } from './rich-markdown-model'

function parsed(source: string) {
  const result = parseRichMarkdown(source)
  expect(result.kind).toBe('parsed')

  if (result.kind !== 'parsed') {
    throw new Error(result.reason)
  }

  return result
}

function roundTrips(source: string) {
  const first = parsed(source)

  const serialized = serializeRichBlocks(
    first.blocks.map(block => block.node),
    source.includes('\r\n') ? '\r\n' : '\n'
  )

  const second = parsed(serialized)

  expect(second.doc.content.eq(first.doc.content)).toBe(true)
}

describe('rich Markdown model', () => {
  it('declines oversized documents and lines before building the rich projection', () => {
    expect(parseRichMarkdown('x'.repeat(RICH_MARKDOWN_LIMITS.maxLineLength + 1)).kind).toBe('refused')
    expect(parseRichMarkdown('word\n\n'.repeat(RICH_MARKDOWN_LIMITS.maxDocLength / 6 + 1)).kind).toBe('refused')
  })

  it('keeps the exact source snapshot while parsing the supported Markdown subset', () => {
    const source =
      '# Tiêu đề\r\n\r\nBefore **bold** and *emphasis*, ~~old~~, [safe](https://example.test/a?q=1).\r\n\r\n> quote\r\n\r\n1. one\r\n2. two\r\n\r\n```ts\r\nconst xin = 1\r\n```\r\n\r\n---\r\n\r\n| Left | Right |\r\n| :--- | ---: |\r\n| một | hai |'

    const result = parsed(source)

    expect(result.source).toBe(source)
    expect(result.doc.attrs.markdown).toBe(source)
    expect(result.blocks[0]).toMatchObject({ from: 0, pos: 0, to: source.indexOf('\r\n\r\n') })
    expect(result.textRanges.find(range => range.text === 'bold')).toMatchObject({
      from: source.indexOf('bold'),
      pos: 17,
      to: source.indexOf('bold') + 4
    })
    expect(result.blocks.at(-1)?.node.type.name).toBe('table')
  })

  it('serializes supported rich blocks into Markdown that reparses to the same ProseMirror content', () => {
    roundTrips(
      '# Heading\n\nA soft\nline and **strong _nested_** [link](/notes), plus `code`.\n\n- first\n  - nested\n- second\n\n> quoted\n>\n> paragraph\n\n```python\nprint(`tick`)\n```\n\n| A | B |\n| --- | :---: |\n| x | y |\n\n---'
    )
  })

  it('represents intentional blank paragraphs and empty table cells as zero-length editable ranges', () => {
    const trailing = parsed('text\r\n\r\n')

    expect(trailing.blocks.map(block => block.node.type.name)).toEqual(['paragraph', 'paragraph'])
    expect(trailing.textRanges).toContainEqual({ from: 8, pos: 7, text: '', to: 8 })
    expect(
      serializeRichBlocks(
        trailing.blocks.map(block => block.node),
        '\r\n'
      )
    ).toBe('text\r\n\r\n')

    const between = parsed('one\n\n\n\ntwo')
    expect(between.blocks.map(block => block.node.type.name)).toEqual(['paragraph', 'paragraph', 'paragraph'])

    const table = parsed('| A | B |\n| --- | --- |\n| x |  |')
    const range = table.textRanges.find(candidate => candidate.text === '')
    expect(range).toEqual({
      from: '| A | B |\n| --- | --- |\n| x |'.length,
      pos: 21,
      text: '',
      to: '| A | B |\n| --- | --- |\n| x |'.length
    })
  })

  it('does not claim exact text mappings for escaped source text', () => {
    const source = 'Escaped \\*stars\\* and &amp; entity'
    const result = parsed(source)

    expect(result.textRanges.map(range => range.text)).not.toContain('*stars*')
    expect(result.textRanges.map(range => range.text)).not.toContain('& entity')
    roundTrips(source)
  })

  it('maps literal inline-code content inside its delimiters and serializes a safe delimiter', () => {
    const source = 'Use ``a ` tick`` here'
    const result = parsed(source)
    const range = result.textRanges.find(candidate => candidate.text === 'a ` tick')

    expect(range).toEqual({ from: 6, pos: 5, text: 'a ` tick', to: 14 })
    roundTrips(source)
  })

  it('refuses unsupported or unsafe Markdown before a rich mutation can be proposed', () => {
    for (const source of [
      '<div>HTML</div>',
      'inline <span>HTML</span>',
      '![image](https://example.test/image.png)',
      '[reference][id]\n\n[id]: https://example.test',
      '[^note]\n\n[^note]: detail',
      '---\ntitle: document\n---\n\ntext',
      '---   \nnot necessarily closed',
      '- [ ] task',
      '[unsafe](javascript:alert(1))',
      '[titled](https://example.test "title")',
      '    indented code'
    ]) {
      expect(parseRichMarkdown(source).kind).toBe('refused')
    }
  })

  it('gives an empty document one editable paragraph and exact zero-length source mapping', () => {
    const result = parsed('')

    expect(result.doc.childCount).toBe(1)
    expect(result.blocks[0]).toMatchObject({ from: 0, pos: 0, to: 0 })
    expect(result.textRanges).toEqual([{ from: 0, pos: 1, text: '', to: 0 }])
    expect(
      serializeRichBlocks(
        result.blocks.map(block => block.node),
        '\n'
      )
    ).toBe('')
  })
})


describe('rich serialization of clipboard whitespace and literal entities', () => {
  it.each([' leading', 'trailing ', 'tab\t', '  ', '&copy; and &#9;', 'Đã xong\t'])('preserves exact text %j through Markdown', text => {
    const paragraph = richMarkdownSchema.nodes.paragraph!.create(null, richMarkdownSchema.text(text))
    const source = serializeRichBlocks([paragraph], '\n')
    expect(parsed(source).doc.firstChild?.eq(paragraph)).toBe(true)
  })

  it('keeps ordinary ampersands literal and source-mappable while protecting entity-shaped text', () => {
    const paragraph = richMarkdownSchema.nodes.paragraph!
    const literal = serializeRichBlocks([paragraph.create(null, richMarkdownSchema.text('AT&T and Research & Development'))], '\n')
    expect(literal).toBe('AT&T and Research & Development')
    expect(parsed(literal).textRanges).toContainEqual({ from: 0, pos: 1, text: literal, to: literal.length })
    const entity = serializeRichBlocks([paragraph.create(null, richMarkdownSchema.text('&copy;'))], '\n')
    expect(entity).toBe('&amp;copy;')
    expect(parsed(entity).doc.textContent).toBe('&copy;')
  })

  it('keeps spaces inside formatting delimiters without changing adjacent plain runs', () => {
    const paragraph = richMarkdownSchema.nodes.paragraph!.create(null, [
      richMarkdownSchema.text('Before '),
      richMarkdownSchema.text(' bold ', [richMarkdownSchema.marks.strong!.create()]),
      richMarkdownSchema.text(' after')
    ])

    const source = serializeRichBlocks([paragraph], '\n')
    expect(parsed(source).doc.firstChild?.eq(paragraph)).toBe(true)
    expect(source).toBe('Before **&#32;bold&#32;** after')
  })
})
