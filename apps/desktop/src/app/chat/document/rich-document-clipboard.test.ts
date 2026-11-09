import { EditorState, TextSelection } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'

import { parseRichDocumentClipboard } from './rich-document-clipboard'
import { parseRichMarkdown, RICH_MARKDOWN_LIMITS, richMarkdownSchema, serializeRichBlocks } from './rich-markdown-model'

function parsed(html: string) {
  const result = parseRichDocumentClipboard(html)

  if (result.kind !== 'parsed') {
    throw new Error(result.reason)
  }

  return result
}

function clipboardDoc(html: string) {
  return richMarkdownSchema.nodes.doc!.create(null, parsed(html).slice.content)
}

function hasMark(node: ReturnType<typeof clipboardDoc>, name: string): boolean {
  let found = false
  node.descendants(candidate => {
    found ||= candidate.marks.some(mark => mark.type.name === name)

    return !found
  })

  return found
}

function sourceEquivalent(html: string) {
  const doc = clipboardDoc(html)
  const blocks = Array.from({ length: doc.childCount }, (_, index) => doc.child(index))
  const markdown = serializeRichBlocks(blocks, '\n')
  const reparsed = parseRichMarkdown(markdown)

  expect(reparsed.kind).toBe('parsed')
  expect(reparsed.kind === 'parsed' && reparsed.doc.content.eq(doc.content)).toBe(true)
}

function pastedIntoText(html: string) {
  const doc = richMarkdownSchema.nodes.doc!.create(
    null,
    richMarkdownSchema.nodes.paragraph!.create(null, richMarkdownSchema.text('Before after'))
  )

  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 8) })
  const result = parsed(html)

  return state.apply(state.tr.replaceSelection(result.slice)).doc
}

function pastedOverDocument(html: string) {
  const doc = richMarkdownSchema.nodes.doc!.create(
    null,
    richMarkdownSchema.nodes.paragraph!.create(null, richMarkdownSchema.text('replace me'))
  )

  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, doc.content.size - 1) })

  return state.apply(state.tr.replaceSelection(parsed(html).slice)).doc
}

describe('rich document clipboard model', () => {
  it('converts semantic HTML and supported inline Word styles into the canonical schema', () => {
    const html =
      '<h2>Chào <strong>đậm</strong></h2><p><span style="font-weight:700">Bold</span>, <span style="font-style:italic">italic</span>, <span style="text-decoration:line-through">old</span>, <a href="https://example.test/đường">safe</a>.</p><ul><li>one</li><li>two</li></ul>'

    const doc = clipboardDoc(html)

    expect(doc.child(0).type.name).toBe('heading')
    expect(doc.child(1).textContent).toBe('Bold, italic, old, safe.')
    expect(doc.child(2).type.name).toBe('bullet_list')
    expect(hasMark(doc, 'strong')).toBe(true)
    expect(hasMark(doc, 'emphasis')).toBe(true)
    expect(hasMark(doc, 'strike')).toBe(true)
    expect(hasMark(doc, 'link')).toBe(true)
    expect(parsed(html).simplified).toBe(false)
    sourceEquivalent(html)
  })

  it('normalizes Word font, colour and spacing styles while retaining the text and supported marks', () => {
    const html =
      '<p class="MsoNormal" style="margin-bottom:12pt"><span style="font-family:Calibri;font-size:11pt;color:#203864;font-weight:bold">Xin chào 👋</span> thế giới</p>'

    const doc = clipboardDoc(html)

    expect(doc.textContent).toBe('Xin chào 👋 thế giới')
    expect(hasMark(doc, 'strong')).toBe(true)
    expect(parsed(html).simplified).toBe(true)
    sourceEquivalent(html)
  })

  it('normalizes a td-first-row Word table to the schema header/GFM contract and keeps alignment', () => {
    const html =
      '<table><tbody><tr><td style="text-align:center">Tên</td><td align="right">Điểm</td></tr><tr><td>An</td><td>9</td></tr></tbody></table>'

    const doc = clipboardDoc(html)
    const table = doc.firstChild!

    expect(table.type.name).toBe('table')
    expect(table.child(0).child(0).type.name).toBe('table_header')
    expect(table.child(0).child(0).attrs.align).toBe('center')
    expect(table.child(0).child(1).attrs.align).toBe('right')
    expect(parsed(html).simplified).toBe(true)
    sourceEquivalent(html)
  })

  it('intentionally normalizes real Word mso-list paragraphs without retaining marker text', () => {
    const html =
      '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1.<span>&nbsp;&nbsp;</span></span>First <span style="font-weight:bold">item</span></p><p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">2.<span>&nbsp;&nbsp;</span></span>Second item</p>'

    const doc = clipboardDoc(html)

    expect(doc.firstChild?.type.name).toBe('ordered_list')
    expect(doc.textContent).toBe('First itemSecond item')
    expect(doc.textContent).not.toContain('1.')
    expect(hasMark(doc, 'strong')).toBe(true)
    sourceEquivalent(html)
  })

  it('accepts Word head metadata and o:p placeholders while collapsing Word source whitespace', () => {
    const html =
      '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]--><!--[if gte mso 10]><style>table.MsoNormalTable{mso-style-name:"Normal Table"}</style><![endif]--><h1><span lang="VI">Báo cáo hoạt động<o:p></o:p></span></h1><p class="MsoNormal"><span lang="VI">Ready\r\n  for review<o:p></o:p></span></p><table><thead><tr><td><p class="MsoNormal" style="text-align:center"><b style="mso-bidi-font-weight:normal">Milestone</b><span lang="VI"><o:p></o:p></span></p></td><td><p class="MsoNormal">Owner</p></td></tr></thead><tbody><tr><td><p class="MsoNormal">Draft</p></td><td><p class="MsoNormal">An</p></td></tr></tbody></table><p class="MsoNormal"><span lang="VI"><o:p>&nbsp;</o:p></span></p>'

    const doc = clipboardDoc(html)

    expect(doc.textContent).toBe('Báo cáo hoạt độngReady for reviewMilestoneOwnerDraftAn')
    expect(doc.lastChild?.type.name).toBe('paragraph')
    expect(doc.lastChild?.textContent).toBe('')
    expect(hasMark(doc, 'strong')).toBe(true)
    expect(parsed(html).simplified).toBe(true)
    sourceEquivalent(html)
  })

  it('uses an open clipboard slice so inline and paragraph payloads splice into a paragraph selection', () => {
    for (const html of [
      '<b>bold</b> ',
      '<p><b>bold</b> </p>',
      '<div data-pm-slice="1 1 []"><p><b>bold</b> </p></div>'
    ]) {
      const doc = pastedIntoText(html)

      expect(doc.childCount).toBe(1)
      expect(doc.textContent).toBe('Before bold after')
      expect(hasMark(doc, 'strong')).toBe(true)
    }

    const multi = pastedIntoText('<p>bold</p><p>next</p>')
    expect(multi.childCount).toBe(2)
    expect(multi.textContent).toBe('Before boldnextafter')
  })

  it('keeps heading and table semantics when replacing a whole document', () => {
    const doc = pastedOverDocument(
      '<h2>Milestones</h2><table><tr><th>Task</th><th>Owner</th></tr><tr><td>Paste</td><td>An</td></tr></table>'
    )

    expect(doc.childCount).toBe(2)
    expect(doc.child(0).type.name).toBe('heading')
    expect(doc.child(1).type.name).toBe('table')
    expect(doc.textContent).toBe('MilestonesTaskOwnerPasteAn')
  })

  it('uses an inert, detached template and never adds clipboard HTML to the live document', () => {
    const before = document.body.innerHTML
    const result = parseRichDocumentClipboard('<p id="clipboard-sentinel">safe</p><img src="https://example.test/pixel.png">')

    // The image refusal happens before a live DOM mutation or resource-bearing
    // element can be inserted into this renderer document.
    expect(result.kind).toBe('refused')
    expect(document.body.innerHTML).toBe(before)
    expect(document.querySelector('#clipboard-sentinel')).toBeNull()
  })

  it('refuses unsafe, hidden and structurally unrepresentable clipboard payloads before dropping content', () => {
    for (const html of [
      '<p><a href="javascript:alert(1)">unsafe</a></p>',
      '<p hidden>secret</p>',
      '<p style="display:none">secret</p>',
      '<iframe src="https://example.test"></iframe>',
      '<table><tr><td colspan="2">merged</td></tr></table>',
      '<p><!--[if gte mso 9]>conditional<![endif]-->visible</p>',
      '<p class="MsoListParagraph">missing marker</p>'
    ]) {
      expect(parseRichDocumentClipboard(html).kind).toBe('refused')
    }
  })

  it('bounds raw HTML before parsing while accepting the exact shared limit', () => {
    const prefix = '<p>x</p><!--'
    const suffix = '-->'
    const exact = `${prefix}${'a'.repeat(RICH_MARKDOWN_LIMITS.maxDocLength - prefix.length - suffix.length)}${suffix}`

    expect(exact).toHaveLength(RICH_MARKDOWN_LIMITS.maxDocLength)
    expect(parseRichDocumentClipboard(exact).kind).toBe('parsed')
    expect(parseRichDocumentClipboard(`${exact}x`).kind).toBe('refused')
  })
})


describe('clipboard formatting and numbering fidelity', () => {
  it('honours inline normal resets inside inherited bold and italic text', () => {
    const doc = clipboardDoc('<p><b><i>Both <span style="font-weight:normal!important;font-style:normal">plain</span></i></b></p>')
    const plain = doc.firstChild!.lastChild!
    expect(plain.text).toBe('plain')
    expect(plain.marks).toEqual([])
  })

  it.each([
    '<ol reversed><li>Two</li><li>One</li></ol>',
    '<ol type="a"><li>Alpha</li></ol>',
    '<ol start="3"><li>Three</li><li value="8">Eight</li></ol>',
    '<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">a.</span>Alpha</p>',
    '<p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">1.</span>One</p><p style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">8.</span>Eight</p>'
  ])('refuses numbering it cannot preserve: %s', html => {
    expect(parseRichDocumentClipboard(html).kind).toBe('refused')
  })
})


it.each([
  '<p>Keep <span style="mso-list:Ignore">Do not lose this</span></p>',
  '<ul>Do not lose this<li>Item</li></ul>',
  '<table><caption>Do not lose this</caption><tr><td>Cell</td></tr></table>'
])('does not silently discard unsupported visible text: %s', html => {
  expect(parseRichDocumentClipboard(html).kind).toBe('refused')
})

describe('Word clipboard structures', () => {
  it('preserves mixed numbered and bullet Word sublists with separate list ids', () => {
    const item = (id: number, level: number, marker: string, text: string) =>
      `<p style="mso-list:l${id} level${level} lfo1"><span style="mso-list:Ignore">${marker}</span>${text}</p>`

    const html = item(0, 1, '1.', 'Parent') + item(1, 2, '•', 'Child') +
      item(1, 2, '•', 'Other child') + item(0, 1, '2.', 'Next')

    const doc = clipboardDoc(html)
    expect(doc.childCount).toBe(1)
    expect(doc.firstChild!.type.name).toBe('ordered_list')
    expect(doc.firstChild!.firstChild!.child(1).type.name).toBe('bullet_list')
    expect(doc.firstChild!.firstChild!.child(1).childCount).toBe(2)
    expect(doc.firstChild!.childCount).toBe(2)
    sourceEquivalent(html)
  })

  it('treats Word bookmark anchors as transparent text', () => {
    const html = '<h2><a name="_Toc123">Heading</a></h2>'
    expect(clipboardDoc(html).textContent).toBe('Heading')
    expect(hasMark(clipboardDoc(html), 'link')).toBe(false)
    sourceEquivalent(html)
  })

})
