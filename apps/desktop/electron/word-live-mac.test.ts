import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { WORD_LIVE_SCRIPT } from './word-live-mac'

function model() {
  let body = 'Tiếng Việt 🌿 costs 5,300 credits.\r'
  let writes = 0
  let mixed = false
  let changed = false
  let uncertain = false
  const counts: Record<string, { length: number }> = {}

  for (const key of ['fields', 'formFields', 'tables', 'revisions', 'bookmarks', 'hyperlinkObjects',
    'footnotes', 'endnotes', 'wordComments', 'inlineShapes', 'mathObjects']) {counts[key] = { length: 0 }}

  const doc = { posixFullName: () => '/test/Live.docx', textObject: { content: () => body, fields: [] as unknown[] },
    wordComments: [] as unknown[], bookmarks: [] as unknown[], saved: () => false,
    protectionType: () => 'no document protection', trackRevisions: () => false, readOnly: () => false }

  const word = { documents: [doc], activeDocument: doc, activeWindow: { windowNumber: () => 1 },
    createRange: (_doc: unknown, { start, end }: { start: number; end: number }) => ({
    ...counts, storyType: () => 'main text story', bookmarkId: () => 0,
    content: () => body.slice(start, end),
    fontObject: { properties: () => ({ bold: mixed ? start % 2 === 0 : true }) },
    highlightColorIndex: () => 'auto', languageID: () => 'english us', noProofing: () => false, style: () => 'normal'
  }) }

  // Model a Word object specifier: reading calls the property getter function;
  // assigning the same property sends exactly one native text mutation.
  const create = word.createRange

  word.createRange = (document, bounds) => {
    const range = create(document, bounds)
    Object.defineProperty(range, 'content', { get: () => () => body.slice(bounds.start, bounds.end), set: value => {
      writes += 1
      body = body.slice(0, bounds.start) + value + body.slice(bounds.end)

      if (uncertain) {throw new Error('Apple Event reply lost')}
    } })

    return range
  }

  const context = runInNewContext(WORD_LIVE_SCRIPT + `
    liveDocument = function () { if (changed()) { doc.textObject.content = function () { return 'new typing' } }; return doc }
    ;({ replace: liveReplace, read: liveRead })`, { ObjC: { import: () => undefined }, word, doc, changed: () => changed })

  const replace = (find = '5,300', replacement = '6,400', expectedText = body) => context.replace(word, doc,
    { path: '/test/Live.docx', windowNumber: 1 }, { find, replacement, expectedText })

  return { replace, body: () => body, writes: () => writes, counts,
    mixed: () => {mixed = true}, change: () => {changed = true}, uncertain: () => {uncertain = true}, doc, word }
}

describe('live Word native text transaction', () => {
  it('replaces one exact UTF-16 range after an emoji, leaving surrounding text intact', () => {
    const m = model()
    expect(m.replace()).toMatchObject({ ok: true, saved: false })
    expect(m.body()).toBe('Tiếng Việt 🌿 costs 6,400 credits.\r')
    expect(m.writes()).toBe(1)
  })
  it('refuses stale, ambiguous, mixed-format and structured targets without a setter', () => {
    const m = model()
    expect(() => m.replace('5,300', '6,400', 'older text')).toThrow('WORD_CONTENT_CHANGED')
    expect(() => m.replace('i', 'o')).toThrow('WORD_TARGET_NOT_UNIQUE')
    expect(() => m.replace('5,300', 'new\rparagraph')).toThrow('WORD_INVALID_EDIT')
    m.counts.fields.length = 1
    expect(() => m.replace()).toThrow('WORD_EDIT_UNSUPPORTED')
    m.counts.fields.length = 0
    m.mixed()
    expect(() => m.replace()).toThrow('WORD_MIXED_FORMATTING')
    expect(m.writes()).toBe(0)
  })
  it('refuses an enclosing field even when the small target contains no whole field', () => {
    const m = model()
    const range = { startOfContent: () => 0, endOfContent: () => 100, storyType: () => 'main text story' }
    m.doc.textObject.fields.push({ fieldCode: range, resultRange: range })
    expect(() => m.replace()).toThrow('WORD_EDIT_UNSUPPORTED')
    expect(m.writes()).toBe(0)
  })
  it('checks for human typing again immediately before the setter', () => {
    const m = model()
    m.change()
    expect(() => m.replace()).toThrow('WORD_CONTENT_CHANGED')
    expect(m.writes()).toBe(0)
  })
  it('refuses duplicate basenames and another active Word document before creating a writable range', () => {
    const m = model()
    m.word.documents.push({ ...m.doc, posixFullName: () => '/other/Live.docx' })
    expect(() => m.replace()).toThrow('WORD_DUPLICATE_NAME')
    m.word.documents.pop()
    m.word.activeDocument = { ...m.doc, posixFullName: () => '/other/Else.docx' }
    expect(() => m.replace()).toThrow('WORD_ACTIVATE_DOCUMENT')
    expect(m.writes()).toBe(0)
  })
  it('returns uncertainty after a lost mutation reply without another write or rollback', () => {
    const m = model()
    m.uncertain()
    expect(m.replace()).toEqual({ ok: false, code: 'WORD_EDIT_UNCERTAIN' })
    expect(m.writes()).toBe(1)
    expect(m.body()).toContain('6,400')
  })
})
