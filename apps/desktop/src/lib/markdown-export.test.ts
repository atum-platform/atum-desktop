import { readFileSync } from 'node:fs'
import path from 'node:path'

import { strFromU8, unzipSync } from 'fflate/browser'
import { describe, expect, it } from 'vitest'

import { type ResolvedDocumentTheme, resolveDocumentTheme } from '../../shared/atum-office/document-theme'

import { DOCX_DOCUMENT_PART, DOCX_NUMBERING_PART, docxXmlToMarkdown } from './docx-markdown'
import { MarkdownExportError, markdownToDocumentHtml, markdownToDocx } from './markdown-export'

// vitest runs from apps/desktop; import.meta.url is not a reliable file URL under the runner.
const fixture = (name: string) => readFileSync(path.join(process.cwd(), 'src/lib/__fixtures__/office', name), 'utf8')
const textPart = (parts: Record<string, Uint8Array>, name: string) => strFromU8(parts[name]!)

function unzip(markdown: string, limits?: Parameters<typeof markdownToDocx>[1]['limits']) {
  return unzipSync(markdownToDocx(markdown, { title: 'Tài liệu & kế hoạch', limits }))
}

function expectWellFormed(xml: string) {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml')
  expect(parsed.querySelector('parsererror')).toBeNull()
}

describe('markdownToDocx', () => {
  it('writes the required OOXML parts and content types', () => {
    const parts = unzip('# Xin chào')
    expect(Object.keys(parts).sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/core.xml',
        'word/_rels/document.xml.rels',
        'word/document.xml',
        'word/numbering.xml',
        'word/styles.xml'
      ].sort()
    )
    expect(textPart(parts, '[Content_Types].xml')).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    )
    expect(textPart(parts, 'docProps/core.xml')).toContain('<dc:title>Tài liệu &amp; kế hoạch</dc:title>')

    for (const bytes of Object.values(parts)) {
      expectWellFormed(strFromU8(bytes))
    }
  })

  it('maps headings, paragraphs, emphasis, code and lists to the supported subset', () => {
    const parts = unzip(
      '# Một\n\n###### Sáu\n\nĐoạn **đậm**, *nghiêng*, `mã`.\n\n- Gạch đầu dòng\n  - Lồng phẳng\n\n1. Thứ nhất'
    )

    const document = textPart(parts, DOCX_DOCUMENT_PART)
    const styles = textPart(parts, 'word/styles.xml')
    const numbering = textPart(parts, DOCX_NUMBERING_PART)
    expect(document).toContain('<w:pStyle w:val="Heading1"/>')
    expect(document).toContain('<w:pStyle w:val="Heading6"/>')
    expect(document).toContain('<w:b/>')
    expect(document).toContain('<w:i/>')
    expect(document).toContain('<w:rStyle w:val="Code"/>')
    // One bullet, its nested item flattened to level 0, and one numbered item.
    expect(document.match(/<w:ilvl w:val="0"\/>/g)).toHaveLength(3)
    expect(document).toContain('<w:numId w:val="1"/>')
    expect(document).toContain('<w:numId w:val="2"/>')
    expect(styles).toContain('w:styleId="Code"')

    for (let level = 1; level <= 6; level++) {
      expect(styles).toContain(`w:styleId="Heading${level}"`)
    }

    expect(numbering).toContain('<w:numFmt w:val="bullet"/>')
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>')
  })

  it('exports a real table with formatted cells, alignment, links and empty cells', () => {
    const parts = unzip('| Item | State |\n| :--- | ---: |\n| **Họp** | [Ready](https://example.test) |\n| Empty |  |')
    const document = textPart(parts, DOCX_DOCUMENT_PART)
    expectWellFormed(document)
    const xml = new DOMParser().parseFromString(document, 'application/xml')
    expect(xml.getElementsByTagName('w:tbl')).toHaveLength(1)
    expect(xml.getElementsByTagName('w:tr')).toHaveLength(3)
    expect(xml.getElementsByTagName('w:tc')).toHaveLength(6)
    expect(xml.getElementsByTagName('w:tblHeader')).toHaveLength(1)
    expect(document).toContain('<w:jc w:val="right"/>')
    const relationship = textPart(parts, 'word/_rels/document.xml.rels')
    expect(relationship).toContain('https://example.test')
    const reopened = docxXmlToMarkdown(document, textPart(parts, DOCX_NUMBERING_PART)).markdown
    expect(reopened).toContain('| **Họp** | Ready |')
    expect(reopened).toContain('| Empty |  |')
    expectExportTooLarge(() =>
      markdownToDocx('| A | B |\n| --- | --- |\n| x | y |', { title: 'T', limits: { maxBlocks: 3 } })
    )
  })

  it('creates stable external hyperlink relationships and resolves every id', () => {
    const parts = unzip(fixture('link-heavy-note.md'))
    const document = textPart(parts, DOCX_DOCUMENT_PART)
    const relationships = textPart(parts, 'word/_rels/document.xml.rels')
    expect(document.match(/r:id="rId3"/g)).toHaveLength(2)
    expect(document).toContain('r:id="rId4"')
    expect(relationships).toContain('Id="rId3"')
    expect(relationships).toContain('Target="https://atum.example/path?a=1&amp;b=2" TargetMode="External"')
    expect(relationships).toContain('Id="rId4"')
  })

  it('preserves Vietnamese code points and significant run spaces byte-exactly', () => {
    const document = textPart(unzip(fixture('vietnamese-memo.md')), DOCX_DOCUMENT_PART)
    expect(document).toContain('Tiếng Việt')
    expect(document).toContain('Tiếng Việt')
    expect(Buffer.from(document, 'utf8').includes(Buffer.from('Tiếng Việt', 'utf8'))).toBe(true)
    expect(document).toContain('<w:t xml:space="preserve">Kính gửi </w:t>')
  })

  it('round trips the semantic subset through the existing reader', () => {
    const source =
      '# Tiêu đề\n\nMột **đậm** và *nghiêng*.\n\n- Một\n- Hai\n\n1. Ba\n2. Bốn\n\n[Xem thêm](https://example.com)'

    const parts = unzip(source)
    const result = docxXmlToMarkdown(textPart(parts, DOCX_DOCUMENT_PART), textPart(parts, DOCX_NUMBERING_PART)).markdown
    // Reader scope deliberately retains link text but not relationship URLs or inline-code markers.
    expect(result).toBe('# Tiêu đề\n\nMột **đậm** và *nghiêng*.\n\n- Một\n- Hai\n1. Ba\n2. Bốn\n\nXem thêm')
  })

  it('is byte deterministic', () => {
    const markdown = fixture('list-heavy-note.md')
    expect(markdownToDocx(markdown, { title: 'Ghi chú' })).toEqual(markdownToDocx(markdown, { title: 'Ghi chú' }))
  })

  it('enforces Markdown, block, XML-element and package ceilings', () => {
    expectExportTooLarge(() => markdownToDocx('abcd', { title: 'x', limits: { maxMarkdownChars: 3 } }))
    expectExportTooLarge(() => markdownToDocx('p\n\n'.repeat(20_001), { title: 'x' }))
    expectExportTooLarge(() => markdownToDocx('one', { title: 'x', limits: { maxXmlElements: 5 } }))
    expectExportTooLarge(() =>
      markdownToDocx('not compressible enough', { title: 'x', limits: { maxPackageBytes: 20 } })
    )
  })

  it('degrades unsupported blocks and images to visible text in valid paragraphs', () => {
    const markdown =
      '| A | B |\n| - | - |\n| C | D |\n\n> Trích dẫn\n\n```ts\nconst n = 1\n```\n\n<b>thô</b>\n\n![Sơ đồ](https://example.com/x.png)'

    const parts = unzip(markdown)
    const document = textPart(parts, DOCX_DOCUMENT_PART)
    expectWellFormed(document)

    for (const text of ['<w:tbl>', '<w:t>A</w:t>', '<w:t>D</w:t>', 'Trích dẫn', 'const n = 1', '&lt;b&gt;thô&lt;/b&gt;', 'Sơ đồ']) {
      expect(document).toContain(text)
    }

    expect(document).not.toContain('https://example.com/x.png')
    expect(document).toContain('<w:pStyle w:val="CodeBlock"/>')
  })
})

describe('markdownToDocumentHtml', () => {
  it('creates self-contained styled HTML and sanitizes raw HTML and images', () => {
    const html = markdownToDocumentHtml(
      '# Tiêu đề\n\n**Đậm** và `mã`.\n\n- Một\n\n> Trích dẫn\n\n| A | B |\n| - | - |\n| C | D |\n\n<script>alert(1)</script>\n\n![Ảnh](https://remote.example/a.png)\n\n[Link](https://example.com)',
      { title: 'Bản & in', locale: 'vi-VN' }
    )

    expect(html.startsWith('<!doctype html><html lang="vi-VN">')).toBe(true)
    expect(html).toContain('<title>Bản &amp; in</title>')

    for (const tag of [
      '<h1>',
      '<strong>',
      '<code>',
      '<ul>',
      '<blockquote>',
      '<table>',
      '<a href="https://example.com">'
    ]) {
      expect(html).toContain(tag)
    }

    expect(html).not.toContain('<script')
    // The serializer escapes '<' (no tag can open) and leaves '>' as HTML allows.
    expect(html).toContain('&lt;script>alert(1)&lt;/script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('https://remote.example')
    expect(html).toContain('Ảnh')
    // The default theme's body face, not the old hardcoded UI stack.
    expect(html).toContain('font-family: "Times New Roman"')
    expect(html).toContain('a[href]::after { content: " (" attr(href) ")"; }')
  })
})

function expectExportTooLarge(action: () => unknown) {
  try {
    action()
    expect.unreachable('expected export to exceed a limit')
  } catch (error) {
    expect(error).toBeInstanceOf(MarkdownExportError)
    expect((error as MarkdownExportError).code).toBe('EXPORT_TOO_LARGE')
  }
}

describe('themed export', () => {
  const partsFor = (theme?: ResolvedDocumentTheme) => unzipSync(markdownToDocx('# One\n\ntext', { theme, title: 'T' }))
  const styles = (theme?: ResolvedDocumentTheme) => textPart(partsFor(theme), 'word/styles.xml')
  const documentPart = (theme?: ResolvedDocumentTheme) => textPart(partsFor(theme), 'word/document.xml')

  it('puts docDefaults first in w:styles and orders its children correctly', () => {
    const xml = styles()

    // CT_Styles is an ordered sequence: docDefaults, latentStyles, style.
    expect(xml).toContain(
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults>'
    )
    expect(xml.indexOf('<w:docDefaults>')).toBeLessThan(xml.indexOf('<w:style '))
    // CT_DocDefaults is rPrDefault THEN pPrDefault, the reverse of the
    // pPr-then-rPr order found inside a style.
    expect(xml.indexOf('<w:rPrDefault>')).toBeLessThan(xml.indexOf('<w:pPrDefault>'))
    // Within w:rPr: rFonts, sz, szCs, lang.
    const rpr = xml.slice(xml.indexOf('<w:rPrDefault>'), xml.indexOf('</w:rPrDefault>'))
    expect(rpr.indexOf('<w:rFonts')).toBeLessThan(rpr.indexOf('<w:sz '))
    expect(rpr.indexOf('<w:szCs')).toBeLessThan(rpr.indexOf('<w:lang'))
  })

  it('writes the default theme as the scale the writer already shipped', () => {
    const xml = styles()

    // 11 pt body, and the original 18/16/14/12/10/8 pt heading scale.
    expect(xml).toContain('<w:sz w:val="22"/><w:szCs w:val="22"/>')
    expect(xml).toContain('<w:sz w:val="36"/><w:szCs w:val="36"/>')
    expect(xml).toContain('<w:sz w:val="16"/><w:szCs w:val="16"/>')
    expect(xml).toContain('w:ascii="Times New Roman"')
  })

  it('orders w:spacing before w:outlineLvl inside a heading pPr', () => {
    const xml = styles()
    const heading = xml.slice(xml.indexOf('w:styleId="Heading1"'), xml.indexOf('w:styleId="Heading2"'))

    expect(heading.indexOf('<w:spacing')).toBeLessThan(heading.indexOf('<w:outlineLvl'))
  })

  it('derives the page box from the theme and reproduces A4 exactly by default', () => {
    expect(documentPart()).toContain(
      '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"'
    )

    const letter = documentPart(resolveDocumentTheme({ overrides: { pageSize: 'letter' }, themeId: 'note' }, 3))
    // Letter is 12240 x 15840 twips; the note theme's 19 mm is 1077 twips.
    expect(letter).toContain('<w:pgSz w:w="12240" w:h="15840"/>')
    expect(letter).toContain('w:top="1077"')
  })

  it('applies a non-default theme to fonts, sizes and colour', () => {
    const xml = styles(resolveDocumentTheme({ themeId: 'modern' }, 2))

    expect(xml).toContain('w:ascii="Arial"')
    expect(xml).toContain('<w:color w:val="0F6FC6"/>')
    expect(xml).not.toContain('Times New Roman')
  })

  it('carries no page box in the print CSS, so printToPDF is the only authority', () => {
    const html = markdownToDocumentHtml('# One', { theme: resolveDocumentTheme(null), title: 'T' })

    expect(html).not.toContain('@page')
    // 170mm was a third geometry authority hiding as typography.
    expect(html).not.toContain('max-width: 170mm')
    // And the user agent's 8px body margin would be a fourth: it must be zeroed,
    // or the PDF column sits 2.12 mm per side inside the printToPDF margins.
    expect(html).toContain('body.document { margin: 0;')
    expect(html).toContain('font-size: 11pt')
  })

  it('gives every heading level the theme size in the print CSS', () => {
    const theme = resolveDocumentTheme({ themeId: 'note' }, 1)
    const html = markdownToDocumentHtml('# One', { theme, title: 'T' })

    theme.headingSizesPt.forEach((size, index) => {
      expect(html).toContain(`h${index + 1} { font-size: ${size}pt; }`)
    })
    expect(html).toContain(`font-size: ${theme.bodySizePt}pt`)
    expect(html).toContain(
      `code, pre { font-family: ui-monospace, Menlo, monospace; font-size: ${theme.bodySizePt - 1}pt; }`
    )
  })

  it('themes the code styles and gives list paragraphs their style', () => {
    const xml = styles(resolveDocumentTheme({ overrides: { bodySizePt: 18 }, themeId: 'modern' }, 1))

    // 17 pt code = 34 half-points, on both sz and szCs.
    expect(xml).toContain('<w:styleId="Code"'.replace('<w:styleId', 'w:styleId'))
    expect(xml).toContain('<w:sz w:val="34"/><w:szCs w:val="34"/>')
    expect(xml).not.toContain('<w:sz w:val="20"/>')
    expect(xml).toContain(
      '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:contextualSpacing/></w:pPr></w:style>'
    )

    const document = textPart(unzipSync(markdownToDocx('- a\n- b\n\n1. c', { title: 'T' })), 'word/document.xml')
    // pStyle precedes numPr inside w:pPr (CT_PPrBase is ordered).
    expect(document).toContain('<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr>')
  })

  it('round-trips a themed list document through the DOCX reader', () => {
    const parts = unzipSync(
      markdownToDocx('# Tiêu đề\n\n- một\n- hai\n\n1. ba', {
        theme: resolveDocumentTheme({ overrides: { bodySizePt: 14, pageSize: 'letter' }, themeId: 'book' }, 2),
        title: 'T'
      })
    )

    const { markdown } = docxXmlToMarkdown(textPart(parts, DOCX_DOCUMENT_PART), textPart(parts, DOCX_NUMBERING_PART))

    expect(markdown).toContain('# Tiêu đề')
    expect(markdown).toContain('- một')
    expect(markdown).toContain('1. ba')
  })
})
