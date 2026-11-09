import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  bytesFromDataUrl,
  DOCX_DOCUMENT_PART,
  DOCX_NUMBERING_PART,
  DocxConvertError,
  docxToMarkdown,
  docxXmlToMarkdown
} from './docx-markdown'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

function doc(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`
}

function paragraph(runs: string, properties = '') {
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${runs}</w:p>`
}

function run(text: string, properties = '') {
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
}

describe('docxXmlToMarkdown', () => {
  it('maps Heading styles to Markdown headings', () => {
    const markdown = docxXmlToMarkdown(
      doc(
        paragraph(run('Hợp đồng dịch vụ'), '<w:pStyle w:val="Heading1"/>') +
          paragraph(run('Điều 1'), '<w:pStyle w:val="Heading2"/>') +
          paragraph(run('Phụ lục'), '<w:pStyle w:val="Title"/>')
      )
    ).markdown

    expect(markdown).toBe('# Hợp đồng dịch vụ\n\n## Điều 1\n\n# Phụ lục')
  })

  it('keeps bold and italic emphasis hugging the words, not the spaces', () => {
    const markdown = docxXmlToMarkdown(
      doc(paragraph(run('Bên A: ') + run('Công ty Anka ', '<w:b/>') + run('Ventures', '<w:i/>')))
    ).markdown

    expect(markdown).toBe('Bên A: **Công ty Anka** *Ventures*')
  })

  it('merges adjacent runs with identical formatting (the skill fragments them)', () => {
    const markdown = docxXmlToMarkdown(doc(paragraph(run('500.') + run('000.') + run('000 VND')))).markdown

    expect(markdown).toBe('500.000.000 VND')
  })

  it('honours the bold toggle being switched off', () => {
    const markdown = docxXmlToMarkdown(doc(paragraph(run('plain', '<w:b w:val="0"/>')))).markdown

    expect(markdown).toBe('plain')
  })

  it('renders tables as GFM tables and escapes pipes in cells', () => {
    const cell = (text: string) => `<w:tc>${paragraph(run(text))}</w:tc>`

    const markdown = docxXmlToMarkdown(
      doc(
        `<w:tbl><w:tr>${cell('Hạng mục')}${cell('Số tiền')}</w:tr><w:tr>${cell('Tư vấn|A')}${cell('300.000.000')}</w:tr></w:tbl>`
      )
    ).markdown

    expect(markdown).toBe('| Hạng mục | Số tiền |\n| --- | --- |\n| Tư vấn\\|A | 300.000.000 |')
  })

  it('pads ragged table rows so the GFM table stays well formed', () => {
    const cell = (text: string) => `<w:tc>${paragraph(run(text))}</w:tc>`

    const markdown = docxXmlToMarkdown(
      doc(`<w:tbl><w:tr>${cell('a')}${cell('b')}</w:tr><w:tr>${cell('c')}</w:tr></w:tbl>`)
    ).markdown

    expect(markdown.split('\n').at(-1)).toBe('| c |  |')
  })

  it('renders bulleted and numbered lists from numbering.xml', () => {
    const numbering = `<?xml version="1.0"?><w:numbering ${W}>
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
    </w:numbering>`

    const item = (text: string, numId: string) =>
      paragraph(run(text), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`)

    const markdown = docxXmlToMarkdown(
      doc(item('Bullet A', '1') + item('Bullet B', '1') + item('Đợt 1', '2') + item('Đợt 2', '2')),
      numbering
    ).markdown

    expect(markdown).toBe('- Bullet A\n- Bullet B\n1. Đợt 1\n2. Đợt 2')
  })

  it('falls back to bullets when numbering.xml is absent', () => {
    const markdown = docxXmlToMarkdown(
      doc(paragraph(run('Điểm một'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'))
    ).markdown

    expect(markdown).toBe('- Điểm một')
  })

  it('indents nested list levels', () => {
    const markdown = docxXmlToMarkdown(
      doc(paragraph(run('Nested'), '<w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr>'))
    ).markdown

    expect(markdown).toBe('    - Nested')
  })

  it('drops tracked deletions and keeps tracked insertions', () => {
    const markdown = docxXmlToMarkdown(
      doc(paragraph(`<w:del>${run('old')}</w:del><w:ins>${run('new')}</w:ins>`))
    ).markdown

    expect(markdown).toBe('new')
  })

  it('follows hyperlink runs so linked text is not lost', () => {
    const markdown = docxXmlToMarkdown(doc(paragraph(`<w:hyperlink>${run('Xem thêm')}</w:hyperlink>`))).markdown

    expect(markdown).toBe('Xem thêm')
  })

  it('turns w:br into a hard line break inside one block', () => {
    const markdown = docxXmlToMarkdown(doc(paragraph(`<w:r><w:t>Dòng 1</w:t><w:br/><w:t>Dòng 2</w:t></w:r>`))).markdown

    expect(markdown).toBe('Dòng 1  \nDòng 2')
  })

  it('escapes Markdown metacharacters and block-starting punctuation in body text', () => {
    const markdown = docxXmlToMarkdown(doc(paragraph(run('# not a heading *x*')))).markdown

    expect(markdown).toBe('\\# not a heading \\*x\\*')
  })

  it('drops spacing-only paragraphs and reports the block count', () => {
    const rendered = docxXmlToMarkdown(doc(paragraph(run('A')) + paragraph('') + paragraph(run('B'))))

    expect(rendered.markdown).toBe('A\n\nB')
    expect(rendered.blockCount).toBe(2)
  })

  it('stops at the block cap and reports the document as truncated', () => {
    const rendered = docxXmlToMarkdown(doc(paragraph(run('Điều')).repeat(50)), undefined, { maxBlocks: 5 })

    expect(rendered.blockCount).toBe(5)
    expect(rendered.truncated).toBe(true)
    expect(rendered.markdown).toBe('Điều\n\nĐiều\n\nĐiều\n\nĐiều\n\nĐiều')
  })

  it('stops at the character cap', () => {
    const rendered = docxXmlToMarkdown(doc(paragraph(run('x'.repeat(100))).repeat(50)), undefined, { maxChars: 250 })

    expect(rendered.truncated).toBe(true)
    expect(rendered.markdown.length).toBeLessThan(400)
  })

  it('stops at the XML element budget, before the whole tree is built', () => {
    const rendered = docxXmlToMarkdown(doc(paragraph(run('Điều')).repeat(50)), undefined, { maxElements: 20 })

    expect(rendered.truncated).toBe(true)
    expect(rendered.blockCount).toBeGreaterThan(0)
    expect(rendered.blockCount).toBeLessThan(50)
  })

  it('reports a document that fits as not truncated', () => {
    expect(docxXmlToMarkdown(doc(paragraph(run('Ngắn')))).truncated).toBe(false)
  })

  it('throws a typed error when there is no body', () => {
    expect(() => docxXmlToMarkdown(`<w:document ${W}></w:document>`)).toThrow(DocxConvertError)
    expect(() => docxXmlToMarkdown(`<w:document ${W}></w:document>`)).toThrow(/no <w:body>/)
  })

  it('throws a typed error for malformed XML', () => {
    try {
      docxXmlToMarkdown('<w:document><w:body>')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as DocxConvertError).code).toBe('unreadable-xml')
    }
  })
})

describe('docxToMarkdown', () => {
  function docxBytes(parts: Record<string, string>) {
    return zipSync(Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)])))
  }

  it('unzips an OOXML package and converts its document part', () => {
    const bytes = docxBytes({
      '[Content_Types].xml': '<Types/>',
      [DOCX_DOCUMENT_PART]: doc(paragraph(run('Xin chào'), '<w:pStyle w:val="Heading1"/>'))
    })

    expect(docxToMarkdown(bytes).markdown).toBe('# Xin chào')
  })

  it('uses numbering.xml when the package carries one', () => {
    const bytes = docxBytes({
      [DOCX_DOCUMENT_PART]: doc(paragraph(run('Một'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')),
      [DOCX_NUMBERING_PART]: `<w:numbering ${W}><w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`
    })

    expect(docxToMarkdown(bytes).markdown).toBe('1. Một')
  })

  it('reports a package with no document part', () => {
    try {
      docxToMarkdown(docxBytes({ 'word/styles.xml': '<x/>' }))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as DocxConvertError).code).toBe('no-document-part')
    }
  })

  it('reports bytes that are not a zip at all', () => {
    try {
      docxToMarkdown(strToU8('this is a plain text file'))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as DocxConvertError).code).toBe('not-a-docx')
    }
  })
})

describe('bytesFromDataUrl', () => {
  it('decodes the base64 data URL readFileDataUrl returns', () => {
    const bytes = bytesFromDataUrl('data:application/octet-stream;base64,SGVsbG8=')

    expect(new TextDecoder().decode(bytes)).toBe('Hello')
  })

  it('decodes a non-base64 data URL', () => {
    expect(new TextDecoder().decode(bytesFromDataUrl('data:text/plain,Hi%20there'))).toBe('Hi there')
  })

  it('rejects a value that is not a data URL', () => {
    expect(() => bytesFromDataUrl('/tmp/file.docx')).toThrow(DocxConvertError)
  })
})
