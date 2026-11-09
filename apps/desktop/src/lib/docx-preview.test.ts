import { describe, expect, it } from 'vitest'

import type { PreviewTarget } from '@/store/preview'

import { DOCX_MIME_TYPE, fileExtension, isDocxPath, isDocxPreviewTarget, previewFileRoute } from './docx-preview'

function fileTarget(overrides: Partial<PreviewTarget> = {}): PreviewTarget {
  return {
    kind: 'file',
    label: 'hop-dong.docx',
    path: '/home/example/Documents/hop-dong.docx',
    source: '/home/example/Documents/hop-dong.docx',
    url: 'file:///home/example/Documents/hop-dong.docx',
    ...overrides
  }
}

describe('fileExtension', () => {
  it.each([
    ['/a/b/c.docx', '.docx'],
    ['/a/b/C.DOCX', '.docx'],
    ['C:\\Users\\fixture-user-10\\hop dong.docx', '.docx'],
    ['file:///a/b.docx?v=2', '.docx'],
    ['/a/b/Makefile', ''],
    ['/a/.hidden', '']
  ])('%s → %s', (input, expected) => {
    expect(fileExtension(input)).toBe(expected)
  })
})

describe('isDocxPath', () => {
  it('accepts every OOXML word package extension', () => {
    for (const name of ['a.docx', 'a.docm', 'a.dotx', 'a.dotm', 'A.DocX']) {
      expect(isDocxPath(name)).toBe(true)
    }
  })

  it('rejects legacy .doc — it is not an OOXML package', () => {
    expect(isDocxPath('/tmp/legacy.doc')).toBe(false)
  })

  it('rejects the other Office formats this route does not render', () => {
    expect(isDocxPath('/tmp/deck.pptx')).toBe(false)
    expect(isDocxPath('/tmp/book.xlsx')).toBe(false)
  })
})

describe('previewFileRoute', () => {
  it('routes a .docx path to the docx renderer', () => {
    expect(previewFileRoute({ path: '/tmp/hop-dong.docx' })).toBe('docx')
  })

  it('routes by mime type when the path has no useful extension', () => {
    expect(previewFileRoute({ mimeType: DOCX_MIME_TYPE, path: '/tmp/download' })).toBe('docx')
  })

  it('falls back to the file url when there is no path', () => {
    expect(previewFileRoute({ url: 'file:///tmp/hop-dong.docx' })).toBe('docx')
  })

  it('returns null for everything the existing text/image/binary paths handle', () => {
    expect(previewFileRoute({ path: '/tmp/notes.md' })).toBeNull()
    expect(previewFileRoute({ path: '/tmp/photo.png' })).toBeNull()
    expect(previewFileRoute({ path: '/tmp/legacy.doc' })).toBeNull()
    expect(previewFileRoute({})).toBeNull()
  })

  it('never routes to soffice — LibreOffice is not bundled with the app', () => {
    // Guards the ruling in docx-markdown.ts: there is exactly one route, and it
    // is in-process. A second route would work in dev and fail on the demo box.
    expect(previewFileRoute({ path: '/tmp/hop-dong.docx' })).toBe('docx')
  })
})

describe('isDocxPreviewTarget', () => {
  it('accepts a target the normalizer already classified', () => {
    expect(isDocxPreviewTarget(fileTarget({ previewKind: 'docx' }))).toBe(true)
  })

  it('accepts a target an older main process classified as binary', () => {
    // The running Electron process may predate the docx previewKind; the
    // extension still routes it instead of dropping to the refusal screen.
    expect(isDocxPreviewTarget(fileTarget({ binary: true, previewKind: 'binary' }))).toBe(true)
  })

  it('rejects url targets, other files, and nothing at all', () => {
    expect(isDocxPreviewTarget(null)).toBe(false)
    expect(isDocxPreviewTarget({ kind: 'url', label: 'x', source: 'x', url: 'https://x.test' })).toBe(false)
    expect(isDocxPreviewTarget(fileTarget({ path: '/tmp/a.md', url: 'file:///tmp/a.md' }))).toBe(false)
  })
})
