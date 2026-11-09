/**
 * xml-lite.ts
 *
 * A tiny, dependency-free, DOM-free XML reader — just enough of a tree for the
 * OOXML → Markdown conversion in `docx-markdown.ts`.
 *
 * Why not `DOMParser`: that conversion now runs in the ELECTRON MAIN PROCESS
 * (see electron/docx-extract.ts), because shuttling a 100 MB `.docx` to the
 * renderer as a base64 data URL is what broke the preview in the first place.
 * The main process is plain Node — there is no `DOMParser` there, and pulling
 * in a full XML DOM implementation for a read-only preview is not worth the
 * dependency. Everything the converter actually touches is: an element's local
 * name, its attributes, its element children in document order, and the text of
 * a leaf (`w:t`). That is what this file provides.
 *
 * Deliberately NOT implemented (OOXML `word/document.xml` never needs it, and
 * every omission is one less thing to get wrong on a hostile input):
 *  - namespace resolution — callers match on `localName` and on the raw
 *    prefixed attribute name, exactly as the DOM-based version did;
 *  - DTD/entity declarations — only the five predefined entities and numeric
 *    character references are expanded, so an XXE/billion-laughs payload in a
 *    document simply cannot expand;
 *  - mixed-content text nodes as first-class nodes — text is attached to the
 *    element that directly contains it (`text`), and `xmlText()` walks the
 *    subtree when a caller needs the concatenation. Attaching the concatenation
 *    to every ancestor eagerly would duplicate the whole document once per
 *    nesting level, which for a large document is exactly the memory blow-up
 *    this rewrite exists to avoid.
 */

export interface XmlAttribute {
  /** Name with any namespace prefix stripped (`val` for `w:val`). */
  localName: string
  /** Name exactly as written (`w:val`). */
  name: string
  value: string
}

export interface XmlElement {
  attributes: XmlAttribute[]
  children: XmlElement[]
  /** Tag name with any namespace prefix stripped (`p` for `w:p`). */
  localName: string
  /** Tag name exactly as written (`w:p`). */
  name: string
  /**
   * Text directly inside this element (not its element children), with every
   * such run concatenated. In genuinely mixed content (`<a>x<b>y</b>z</a>`)
   * that loses the interleaving with the children — OOXML text lives in `w:t`
   * leaves, so the converter never depends on it.
   */
  text: string
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XmlParseError'
  }
}

const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"'
}

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g

export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) {
    return value
  }

  return value.replace(ENTITY_RE, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)

      return Number.isFinite(code) && code > 0 ? safeCodePoint(code, whole) : whole
    }

    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)

      return Number.isFinite(code) && code > 0 ? safeCodePoint(code, whole) : whole
    }

    // An unknown named entity is left verbatim rather than dropped: a document
    // is easier to read with a stray `&nbsp;` in it than with a hole.
    return PREDEFINED_ENTITIES[body] ?? whole
  })
}

function safeCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

function localNameOf(name: string): string {
  const colon = name.indexOf(':')

  return colon >= 0 ? name.slice(colon + 1) : name
}

const NAME_RE = /[^\s/>]+/y
const ATTRIBUTE_RE = /\s*([^\s=/>]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s/>]+))?/y

function element(name: string): XmlElement {
  return { attributes: [], children: [], localName: localNameOf(name), name, text: '' }
}

export interface XmlParseOptions {
  /**
   * Stop parsing after this many elements and return the well-formed prefix.
   *
   * The tree is the single largest allocation on the docx preview path — a
   * 73 MB `document.xml` becomes hundreds of MB of objects — and the preview
   * only ever renders the head of a long document. Parsing is in document
   * order, so stopping early yields exactly the head, and the caller reports
   * the document as truncated instead of pretending it is complete.
   */
  maxElements?: number
}

export interface XmlDocument {
  root: XmlElement
  /** True when `maxElements` cut the parse short. */
  truncated: boolean
}

/**
 * Parse an XML document into its root element.
 *
 * Throws `XmlParseError` on anything structurally broken (unclosed tag,
 * mismatched close tag, no root element) so callers can report an unreadable
 * document instead of rendering a silently truncated one.
 */
export function parseXml(xml: string, options: XmlParseOptions = {}): XmlElement {
  return parseXmlDocument(xml, options).root
}

/** `parseXml`, plus whether the element budget cut the parse short. */
export function parseXmlDocument(xml: string, options: XmlParseOptions = {}): XmlDocument {
  const source = String(xml ?? '')

  const maxElements =
    Number.isFinite(options.maxElements) && Number(options.maxElements) > 0 ? Number(options.maxElements) : Infinity

  const stack: XmlElement[] = []
  let root: null | XmlElement = null
  let elements = 0
  let index = 0

  while (index < source.length) {
    if (elements >= maxElements) {
      if (!root) {
        throw new XmlParseError('document has no root element')
      }

      return { root, truncated: true }
    }

    const open = source.indexOf('<', index)

    if (open < 0) {
      break
    }

    if (open > index) {
      appendText(stack.at(-1), source.slice(index, open))
    }

    // Declarations, comments, CDATA, processing instructions.
    if (source.startsWith('<!--', open)) {
      index = skipTo(source, open + 4, '-->', 'unterminated comment')

      continue
    }

    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9)

      if (end < 0) {
        throw new XmlParseError('unterminated CDATA section')
      }

      // CDATA is literal: entities inside it are not references.
      const current = stack.at(-1)

      if (current) {
        current.text += source.slice(open + 9, end)
      }

      index = end + 3

      continue
    }

    if (source.startsWith('<?', open)) {
      index = skipTo(source, open + 2, '?>', 'unterminated processing instruction')

      continue
    }

    if (source.startsWith('<!', open)) {
      // `<!DOCTYPE …>` — possibly with an internal subset. We do not expand any
      // of it; skipping past the matching `>` (accounting for `[...]`) is
      // enough, and means declared entities never expand.
      index = skipDoctype(source, open)

      continue
    }

    if (source.startsWith('</', open)) {
      NAME_RE.lastIndex = open + 2
      const match = NAME_RE.exec(source)

      if (!match) {
        throw new XmlParseError('malformed closing tag')
      }

      const current = stack.pop()

      if (!current || current.name !== match[0]) {
        throw new XmlParseError(`mismatched closing tag </${match[0]}>`)
      }

      const close = source.indexOf('>', NAME_RE.lastIndex)

      if (close < 0) {
        throw new XmlParseError('unterminated closing tag')
      }

      index = close + 1

      continue
    }

    NAME_RE.lastIndex = open + 1
    const nameMatch = NAME_RE.exec(source)

    if (!nameMatch) {
      throw new XmlParseError('malformed tag')
    }

    const node = element(nameMatch[0])
    elements += 1
    let cursor = NAME_RE.lastIndex

    // Attributes.
    for (;;) {
      while (cursor < source.length && /\s/.test(source[cursor] as string)) {
        cursor += 1
      }

      if (cursor >= source.length) {
        throw new XmlParseError(`unterminated tag <${node.name}>`)
      }

      const char = source[cursor]

      if (char === '>' || (char === '/' && source[cursor + 1] === '>')) {
        break
      }

      ATTRIBUTE_RE.lastIndex = cursor
      const attribute = ATTRIBUTE_RE.exec(source)

      if (!attribute || ATTRIBUTE_RE.lastIndex === cursor) {
        throw new XmlParseError(`malformed attribute in <${node.name}>`)
      }

      const raw = attribute[2] ?? ''
      const value = raw.length > 1 && (raw.startsWith('"') || raw.startsWith("'")) ? raw.slice(1, -1) : raw

      node.attributes.push({
        localName: localNameOf(attribute[1] as string),
        name: attribute[1] as string,
        value: decodeXmlEntities(value)
      })

      cursor = ATTRIBUTE_RE.lastIndex
    }

    const selfClosing = source[cursor] === '/'
    const parent = stack.at(-1)

    if (parent) {
      parent.children.push(node)
    } else if (root) {
      throw new XmlParseError('document has more than one root element')
    } else {
      root = node
    }

    if (!selfClosing) {
      stack.push(node)
    }

    index = cursor + (selfClosing ? 2 : 1)
  }

  if (stack.length > 0) {
    throw new XmlParseError(`unclosed element <${stack.at(-1)?.name}>`)
  }

  if (!root) {
    throw new XmlParseError('document has no root element')
  }

  return { root, truncated: false }
}

function appendText(node: undefined | XmlElement, raw: string) {
  if (!node) {
    // Whitespace/text outside the root element is not content.
    return
  }

  node.text += decodeXmlEntities(raw)
}

function skipTo(source: string, from: number, terminator: string, error: string): number {
  const end = source.indexOf(terminator, from)

  if (end < 0) {
    throw new XmlParseError(error)
  }

  return end + terminator.length
}

function skipDoctype(source: string, open: number): number {
  let depth = 0

  for (let cursor = open + 2; cursor < source.length; cursor += 1) {
    const char = source[cursor]

    if (char === '[') {
      depth += 1
    } else if (char === ']') {
      depth -= 1
    } else if (char === '>' && depth <= 0) {
      return cursor + 1
    }
  }

  throw new XmlParseError('unterminated declaration')
}

/** Concatenated text of an element and its descendants, in document order. */
export function xmlText(node: XmlElement): string {
  if (node.children.length === 0) {
    return node.text
  }

  let out = node.text

  for (const child of node.children) {
    out += xmlText(child)
  }

  return out
}
