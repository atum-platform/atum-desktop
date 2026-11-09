import { execFile } from 'node:child_process'

import { WORD_AUTOMATION_SCRIPT, type WordWindowSnapshot } from './word-companion-mac'

export interface WordLiveSnapshot {
  text: string
  saved: boolean
  selection?: { text: string; start: number; end: number }
}

export interface WordLiveReplacement {
  expectedText: string
  find: string
  replacement: string
}

// Input travels over stdin, never argv, so live document text does not appear
// in process listings. This extends the same exact-window identity checks used
// by the companion layout adapter.
export const WORD_LIVE_SCRIPT = WORD_AUTOMATION_SCRIPT + String.raw`

let liveStage = 'resolve'

function liveDocument(word, pair) {
  const doc = findDocument(word, normalizePath(pair.path))
  const windowRef = findWindow(word, normalizePath(pair.path), pair.windowNumber)
  const native = nativeWordWindows().find(value => value.id === pair.windowId)
  if (!doc || !windowRef || !native || !sameBounds(wordBounds(windowRef, pair.topInset), native.bounds)) {
    throw new Error('WORD_DOCUMENT_UNAVAILABLE')
  }
  return doc
}

function liveText(doc) {
  const text = doc.textObject.content()
  // Bound the native output and the main-owned comparison snapshot. Never
  // silently edit against a truncated snapshot.
  if (typeof text !== 'string' || text.length > 200000) { throw new Error('WORD_DOCUMENT_TOO_LARGE') }
  return text
}

function liveRead(word, doc, pair) {
  const text = liveText(doc)
  let selection
  try {
    if (documentPath(word.selection.document) === normalizePath(pair.path) &&
      Number(word.activeWindow.windowNumber()) === pair.windowNumber && word.selection.storyType() === 'main text story') {
      const start = Number(word.selection.selectionStart())
      const end = Number(word.selection.selectionEnd())
      // Word can return a character for a collapsed selection.
      if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length) {
        const selected = word.selection.content()
        if (selected === text.slice(start, end)) { selection = { text: selected, start, end } }
      }
    }
  } catch (_) { /* A different pane/story has no applicable selection. */ }
  if (liveText(doc) !== text) { throw new Error('WORD_CONTENT_CHANGED') }
  liveDocument(word, pair)
  return { ok: true, text, saved: Boolean(doc.saved()), selection }
}

function inlineText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f\ufffc\u2028\u2029]/.test(value) &&
    !/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/.test(value)
}

function characterFormat(range) {
  return JSON.stringify({ font: range.fontObject.properties(), highlight: range.highlightColorIndex(),
    language: range.languageID(), noProofing: range.noProofing(), style: range.style() })
}

function assertEditableDocument(word, pair) {
  // Native acceptance proved that createRange on an indexed document can
  // redirect a setter to its same-name twin (and leave stale ranges after the
  // twin closes). Use the verified active-document specifier below and refuse
  // ambiguous names rather than depending on Word's undocumented resolution.
  const name = normalizePath(pair.path).split('/').pop().toLocaleLowerCase()
  let matches = 0
  for (let index = 0; index < word.documents.length; index += 1) {
    if (documentPath(word.documents[index]).split('/').pop().toLocaleLowerCase() === name) { matches += 1 }
  }
  if (matches !== 1) { throw new Error('WORD_DUPLICATE_NAME') }
  if (documentPath(word.activeDocument) !== normalizePath(pair.path) ||
    Number(word.activeWindow.windowNumber()) !== pair.windowNumber) { throw new Error('WORD_ACTIVATE_DOCUMENT') }
}

function assertNoAnchoredContent(doc, start, end) {
  const overlaps = range => range.storyType() === 'main text story' &&
    Number(range.startOfContent()) <= end && Number(range.endOfContent()) >= start
  // A target inside a field/comment/bookmark need not CONTAIN the object.
  // Inspect anchored intervals as well as target-range collection counts.
  const sources = [
    [doc.textObject.fields, item => [item.fieldCode, item.resultRange]],
    [doc.wordComments, item => [item.scope]],
    [doc.bookmarks, item => [item.textObject]]
  ]
  for (const [items, ranges] of sources) {
    if (items.length > 2000) { throw new Error('WORD_EDIT_UNSUPPORTED') }
    for (let index = 0; index < items.length; index += 1) {
      if (ranges(items[index]).some(overlaps)) { throw new Error('WORD_EDIT_UNSUPPORTED') }
    }
  }
}

function liveReplace(word, doc, pair, request) {
  if (!inlineText(request.find, 256) || !inlineText(request.replacement, 1024) || request.find === request.replacement ||
    typeof request.expectedText !== 'string') { throw new Error('WORD_INVALID_EDIT') }
  const text = liveText(doc)
  if (text !== request.expectedText) { throw new Error('WORD_CONTENT_CHANGED') }
  const start = text.indexOf(request.find)
  if (start < 0 || text.indexOf(request.find, start + 1) !== -1) { throw new Error('WORD_TARGET_NOT_UNIQUE') }
  if (doc.protectionType() !== 'no document protection' || doc.trackRevisions() || doc.readOnly()) {
    throw new Error('WORD_EDIT_UNSUPPORTED')
  }
  assertEditableDocument(word, pair)
  liveStage = 'range'
  const range = word.createRange(word.activeDocument, { start, end: start + request.find.length })
  // Field codes and other hidden structures can make Word's native positions
  // differ from the displayed text offsets. Refuse that mapping rather than
  // suggesting an endlessly stale snapshot or guessing the target range.
  if (range.content() !== request.find || range.storyType() !== 'main text story') { throw new Error('WORD_EDIT_UNSUPPORTED') }
  liveStage = 'anchors'
  assertNoAnchoredContent(doc, start, start + request.find.length)
  // Do not flatten structure, references, review annotations, or table cells.
  for (const collection of ['fields', 'formFields', 'tables', 'revisions', 'bookmarks', 'hyperlinkObjects',
    'footnotes', 'endnotes', 'wordComments', 'inlineShapes', 'mathObjects']) {
    liveStage = collection
    if (range[collection].length !== 0) { throw new Error('WORD_EDIT_UNSUPPORTED') }
  }
  liveStage = 'bookmark'
  if (range.bookmarkId() !== 0) { throw new Error('WORD_EDIT_UNSUPPORTED') }
  let format
  let offset = start
  // Range-level boolean properties turn mixed formatting into false in Word.
  // Check each code point instead; never change font/paragraph properties.
  for (const character of request.find) {
    liveStage = 'format'
    const part = word.createRange(word.activeDocument, { start: offset, end: offset + character.length })
    const next = characterFormat(part)
    if (format !== undefined && next !== format) { throw new Error('WORD_MIXED_FORMATTING') }
    format = next
    offset += character.length
  }
  liveDocument(word, pair)
  assertEditableDocument(word, pair)
  if (liveText(doc) !== text || range.content() !== request.find) { throw new Error('WORD_CONTENT_CHANGED') }
  // Exactly one mutation. Never save, close, select, activate, replace the
  // document body, retry, or automatically undo an uncertain result.
  try {
    range.content = request.replacement
    const expected = text.slice(0, start) + request.replacement + text.slice(start + request.find.length)
    liveDocument(word, pair)
    if (liveText(doc) !== expected) { return { ok: false, code: 'WORD_EDIT_UNCERTAIN' } }
    return { ok: true, text: expected, saved: Boolean(doc.saved()) }
  } catch (_) { return { ok: false, code: 'WORD_EDIT_UNCERTAIN' } }
}

function run() {
  try {
    const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
    const request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))
    if (!wordIsRunning()) { return output(unavailable()) }
    const word = wordApplication()
    const doc = liveDocument(word, request.pair)
    return output(request.operation === 'read' ? liveRead(word, doc, request.pair) :
      request.operation === 'replace' ? liveReplace(word, doc, request.pair, request.edit) :
      { ok: false, code: 'WORD_INVALID_EDIT' })
  } catch (error) {
    const message = String(error.message || '')
    return output({ ok: false, code: /^WORD_[A-Z_]+$/.test(message) ? message : automationError(error),
      stage: liveStage, nativeErrorNumber: Number(error.errorNumber) })
  }
}
`

export function createWordLiveMacAdapter() {
  const execute = (operation: 'read' | 'replace', pair: WordWindowSnapshot, edit?: WordLiveReplacement): Promise<WordLiveSnapshot> =>
    new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WORD_LIVE_SCRIPT],
        { timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) {
            reject(new Error(operation === 'replace' ? 'WORD_EDIT_UNCERTAIN' : 'WORD_AUTOMATION_FAILED'))

            return
          }

          try {
            const result = JSON.parse(stdout)

            if (result.ok !== true) { throw new Error(/^WORD_[A-Z_]+$/.test(result.code) ? result.code : 'WORD_AUTOMATION_FAILED') }

            if (typeof result.text !== 'string' || result.text.length > 200000 || typeof result.saved !== 'boolean') {
              throw new Error(operation === 'replace' ? 'WORD_EDIT_UNCERTAIN' : 'WORD_AUTOMATION_FAILED')
            }

            resolve({ text: result.text, saved: result.saved, selection: result.selection })
          } catch (failure) {
            const code = failure instanceof Error && /^WORD_[A-Z_]+$/u.test(failure.message) ? failure.message :
              operation === 'replace' ? 'WORD_EDIT_UNCERTAIN' : 'WORD_AUTOMATION_FAILED'

            reject(new Error(code))
          }
        })

      child.stdin?.on('error', () => { /* Process exit is handled by the callback. */ })
      child.stdin?.end(JSON.stringify({ operation, pair, edit }))
    })

  return {
    read: (pair: WordWindowSnapshot) => execute('read', pair),
    replace: (pair: WordWindowSnapshot, edit: WordLiveReplacement) => execute('replace', pair, edit)
  }
}
