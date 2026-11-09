import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

import { openWorkspaceTextFileLease } from './workspace-text-file-lease'

afterEach(() => {
  vi.unstubAllGlobals()
})

test('renderer contract closes over only an opaque descriptor and typed bridge methods', async () => {
  const bridge = {
    openTextFile: vi.fn(async () => ({ fileRef: 'opaque-ref', displayName: 'note.txt' })),
    readTextFile: vi.fn(async (_fileRef: string) => ({
      revision: 'sha256:r',
      text: 'x',
      truncated: false
    })),
    watchTextFile: vi.fn(() => () => undefined),
    writeTextFile: vi.fn(async () => ({ revision: 'sha256:w' })),
    preserveTextFileSibling: vi.fn(async () => ({ displayName: 'note (preserved).txt' })),
    releaseTextFile: vi.fn(async () => undefined),
    recovery: {
      discard: vi.fn(async (_fileRef: string, _draftRevision: string) => ({
        outcome: 'discarded' as const,
        record: null
      })),
      read: vi.fn(async (_fileRef: string) => ({ outcome: 'absent' as const, record: null })),
      version: 1 as const,
      write: vi.fn(async (_fileRef: string, _input: unknown) => ({
        outcome: 'saved' as const,
        record: {
          baseRevision: 'sha256:r',
          documentId: 'note.md',
          draftRevision: 'draft-1',
          editorRevision: 'editor-1',
          text: 'draft',
          updatedAt: '2026-09-06T00:00:00.000Z',
          workspaceRelativePath: 'note.md'
        }
      }))
    },
    selectReadRoot: vi.fn(),
    readText: vi.fn()
  }

  vi.stubGlobal('window', { hermesDesktop: { filesystemCapability: bridge } })
  const lease = await openWorkspaceTextFileLease()

  assert.equal(lease?.fileRef, 'opaque-ref')
  await lease!.read()
  await lease!.write({ expectedRevision: 'sha256:r', text: 'next' })
  await lease!.preserveSibling({ expectedRevision: 'sha256:r', text: 'dirty' })
  assert.deepEqual(await lease!.recovery?.read(), { outcome: 'absent', record: null })
  await lease!.recovery?.write({
    baseRevision: 'sha256:r',
    editorRevision: 'editor-1',
    expectedDraftRevision: null,
    text: 'draft'
  })
  await lease!.recovery?.discard('draft-1')
  await lease!.release()
  assert.equal(bridge.readTextFile.mock.calls[0][0], 'opaque-ref')
  assert.equal(bridge.recovery.read.mock.calls[0][0], 'opaque-ref')
  assert.equal(bridge.recovery.write.mock.calls[0][0], 'opaque-ref')
  assert.equal(bridge.recovery.discard.mock.calls[0][0], 'opaque-ref')
  assert.equal(JSON.stringify(lease).includes('/remote/'), false)
})

test('feature-detects recovery rather than assuming an older preload supports it', async () => {
  const bridge = {
    openTextFile: vi.fn(async () => ({ fileRef: 'opaque-ref', displayName: 'note.txt' })),
    preserveTextFileSibling: vi.fn(),
    readTextFile: vi.fn(),
    releaseTextFile: vi.fn(),
    watchTextFile: vi.fn(),
    writeTextFile: vi.fn()
  }

  vi.stubGlobal('window', { hermesDesktop: { filesystemCapability: bridge } })
  const lease = await openWorkspaceTextFileLease()
  assert.equal(lease?.recovery, undefined)
})
