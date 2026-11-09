import assert from 'node:assert/strict'

import { test } from 'vitest'

import { documentKeyIsWithin, normalizeDocumentKey, reparentDocumentKey } from './document-identity'

test('accepts every spelling the existing producers emit for one document', () => {
  // Three call sites disagree today: one emits POSIX separators, one emits
  // platform separators, and only some apply NFC. All must key the same row.
  assert.equal(normalizeDocumentKey('notes/plan.md', 'linux'), 'notes/plan.md')
  assert.equal(normalizeDocumentKey('notes\\plan.md', 'linux'), 'notes/plan.md')
  assert.equal(normalizeDocumentKey('./notes//plan.md', 'linux'), 'notes/plan.md')
  assert.equal(normalizeDocumentKey('notes/plan.md/', 'linux'), 'notes/plan.md')
})

test('unifies composed and decomposed Vietnamese into one key', () => {
  const composed = 'Tài liệu/Kế hoạch.md'.normalize('NFC')
  const decomposed = 'Tài liệu/Kế hoạch.md'.normalize('NFD')

  assert.notEqual(composed, decomposed)
  assert.equal(normalizeDocumentKey(decomposed, 'linux'), normalizeDocumentKey(composed, 'linux'))
})

test('keeps spaces, which ordinary document names are full of', () => {
  assert.equal(normalizeDocumentKey('Tài liệu 1.md', 'linux'), 'Tài liệu 1.md')
  assert.equal(normalizeDocumentKey('My Documents/Q3 report.md', 'linux'), 'My Documents/Q3 report.md')
})

test('case-folds only where the filesystem is case-insensitive', () => {
  assert.equal(normalizeDocumentKey('Notes/Plan.md', 'darwin'), 'notes/plan.md')
  assert.equal(normalizeDocumentKey('Notes/Plan.md', 'win32'), 'notes/plan.md')
  assert.equal(normalizeDocumentKey('Notes/Plan.md', 'linux'), 'Notes/Plan.md')
})

test('refuses anything that cannot safely name a document inside the workspace', () => {
  for (const value of [
    '',
    '   '.trim(),
    '/etc/passwd',
    '\\\\server\\share\\file.md',
    'C:/home/example/file.md',
    'c:\\Users\\x\\file.md',
    '../outside.md',
    'notes/../../outside.md',
    '..',
    './',
    'bad\u0000name.md'
  ]) {
    assert.equal(normalizeDocumentKey(value, 'linux'), null, `expected null for ${JSON.stringify(value)}`)
  }
})

test('refuses non-string input rather than coercing it', () => {
  for (const value of [null, undefined, 42, {}, ['notes/plan.md']]) {
    assert.equal(normalizeDocumentKey(value, 'linux'), null)
  }
})

test('recognises and re-roots a subtree', () => {
  assert.equal(documentKeyIsWithin('notes', 'notes'), true)
  assert.equal(documentKeyIsWithin('notes', 'notes/plan.md'), true)
  assert.equal(documentKeyIsWithin('notes', 'notes-archive/plan.md'), false)
  assert.equal(documentKeyIsWithin('notes', 'other/plan.md'), false)

  assert.equal(reparentDocumentKey('notes', 'notes', 'archive'), 'archive')
  assert.equal(reparentDocumentKey('notes/plan.md', 'notes', 'archive'), 'archive/plan.md')
  assert.equal(reparentDocumentKey('notes/a/b.md', 'notes', 'archive/2026'), 'archive/2026/a/b.md')
})
