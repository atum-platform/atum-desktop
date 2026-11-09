import { describe, expect, it } from 'vitest'

import { decodeXmlEntities, parseXml, parseXmlDocument, XmlParseError, xmlText } from './xml-lite'

describe('parseXml', () => {
  it('builds elements, attributes, and local names', () => {
    const root = parseXml('<w:document xmlns:w="urn:w"><w:body><w:p w:rsid="00A1"/></w:body></w:document>')

    expect(root.name).toBe('w:document')
    expect(root.localName).toBe('document')

    const paragraph = root.children[0]?.children[0]

    expect(paragraph?.localName).toBe('p')
    expect(paragraph?.attributes).toEqual([{ localName: 'rsid', name: 'w:rsid', value: '00A1' }])
  })

  it('keeps element order and preserves significant whitespace in text', () => {
    const root = parseXml('<r><t xml:space="preserve">  hai  </t><t>ba</t></r>')

    expect(root.children.map(child => child.text)).toEqual(['  hai  ', 'ba'])
  })

  it('expands the predefined and numeric entities, in text and in attributes', () => {
    const root = parseXml('<t title="A &amp; B">1 &lt; 2 &amp;&amp; &#233; &#x1F600;</t>')

    expect(root.text).toBe('1 < 2 && é 😀')
    expect(root.attributes[0]?.value).toBe('A & B')
  })

  it('leaves an undeclared entity verbatim rather than dropping the text', () => {
    expect(parseXml('<t>a&nbsp;b</t>').text).toBe('a&nbsp;b')
  })

  it('does not expand entities declared in a DOCTYPE (billion laughs stays inert)', () => {
    const bomb = '<!DOCTYPE t [<!ENTITY lol "haha"><!ENTITY lol2 "&lol;&lol;&lol;">]><t>&lol2;</t>'

    expect(parseXml(bomb).text).toBe('&lol2;')
  })

  it('reads CDATA literally and skips comments and processing instructions', () => {
    const root = parseXml('<?xml version="1.0"?><t><!-- note --><![CDATA[a & <b>]]></t>')

    expect(root.text).toBe('a & <b>')
  })

  it('handles single-quoted and self-closing forms', () => {
    const root = parseXml("<p><br/><i val='on' /></p>")

    expect(root.children.map(child => child.localName)).toEqual(['br', 'i'])
    expect(root.children[1]?.attributes[0]?.value).toBe('on')
  })

  it('throws on an unclosed element', () => {
    expect(() => parseXml('<w:document><w:body>')).toThrow(XmlParseError)
  })

  it('throws on a mismatched closing tag', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow(/mismatched/)
  })

  it('throws when there is no root element', () => {
    expect(() => parseXml('   ')).toThrow(/no root element/)
  })

  it('throws on a second root element', () => {
    expect(() => parseXml('<a/><b/>')).toThrow(/more than one root/)
  })
})

describe('parseXmlDocument element budget', () => {
  it('returns the well-formed head of the document and reports truncation', () => {
    const xml = `<body>${'<p><t>x</t></p>'.repeat(100)}</body>`
    const { root, truncated } = parseXmlDocument(xml, { maxElements: 10 })

    expect(truncated).toBe(true)
    expect(root.localName).toBe('body')
    // The budget is spent on <body> plus two elements per paragraph, and the
    // parse stops on the first iteration that finds it exhausted — so a whole
    // number of paragraphs survives, never half of one.
    expect(root.children.length).toBe(5)
    expect(root.children.every(child => child.localName === 'p')).toBe(true)
  })

  it('reports no truncation when the document fits the budget', () => {
    expect(parseXmlDocument('<body><p/></body>', { maxElements: 10 }).truncated).toBe(false)
  })
})

describe('xmlText', () => {
  it('concatenates the text of a subtree', () => {
    expect(xmlText(parseXml('<t><a>Xin </a><b>chào</b></t>'))).toBe('Xin chào')
  })
})

describe('decodeXmlEntities', () => {
  it('returns the input untouched when there is nothing to decode', () => {
    expect(decodeXmlEntities('Hợp đồng')).toBe('Hợp đồng')
  })
})
