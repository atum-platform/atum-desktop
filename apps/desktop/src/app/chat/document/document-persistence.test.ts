import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceTextFileLease } from '@/lib/workspace-text-file-lease'

import type { AtumDocumentRecoveryDraft } from '../../../../shared/atum-office/document-recovery'

import { persistDocumentSnapshot } from './document-persistence'

const input = {
  baseRevision: 'file-r1',
  editorRevision: '7',
  expectedDraftRevision: 'draft-r6',
  text: '# Updated\n\nOnly this draft changes.\n'
}

const record = (draftRevision = 'draft-r7'): AtumDocumentRecoveryDraft => ({
  baseRevision: input.baseRevision,
  documentId: 'document-opaque',
  draftRevision,
  editorRevision: input.editorRevision,
  text: input.text,
  updatedAt: '2026-09-06T09:00:00.000Z',
  workspaceRelativePath: 'notes/update.md'
})

function lease(overrides: Partial<WorkspaceTextFileLease> = {}): WorkspaceTextFileLease {
  return {
    displayName: 'update.md',
    fileRef: 'file-opaque',
    preserveSibling: vi.fn(),
    read: vi.fn(),
    release: vi.fn(),
    watch: vi.fn(() => () => undefined),
    write: vi.fn(async () => ({ revision: 'file-r2' })),
    ...overrides
  }
}

describe('persistDocumentSnapshot', () => {
  it('journals the immutable snapshot before writing the file and publishes its draft revision', async () => {
    const order: string[] = []

    const journal = vi.fn(async () => {
      order.push('journal')

      return { outcome: 'saved' as const, record: record() }
    })

    const write = vi.fn(async () => {
      order.push('file')

      return { revision: 'file-r2' }
    })

    const onJournaled = vi.fn()
    const file = lease({ recovery: { discard: vi.fn(), read: vi.fn(), write: journal }, write })

    await expect(persistDocumentSnapshot(file, input, onJournaled)).resolves.toEqual({
      draftRevision: 'draft-r7',
      revision: 'file-r2'
    })

    expect(journal).toHaveBeenCalledWith(input)
    expect(write).toHaveBeenCalledWith({ expectedRevision: 'file-r1', text: input.text })
    expect(onJournaled).toHaveBeenCalledWith('draft-r7')
    expect(order).toEqual(['journal', 'file'])
  })

  it('fails closed on a stale recovery journal and leaves the file untouched', async () => {
    const write = vi.fn(async () => ({ revision: 'file-r2' }))

    const file = lease({
      recovery: {
        discard: vi.fn(),
        read: vi.fn(),
        write: vi.fn(async () => ({ outcome: 'stale' as const, record: record('draft-from-another-window') }))
      },
      write
    })

    await expect(persistDocumentSnapshot(file, input, vi.fn())).rejects.toThrow('DOCUMENT_RECOVERY_CONFLICT')
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps explicit file saving compatible with desktops that lack recovery', async () => {
    const write = vi.fn(async () => ({ revision: 'file-r2' }))
    const onJournaled = vi.fn()

    await expect(persistDocumentSnapshot(lease({ write }), input, onJournaled)).resolves.toEqual({
      draftRevision: null,
      revision: 'file-r2'
    })

    expect(write).toHaveBeenCalledWith({ expectedRevision: 'file-r1', text: input.text })
    expect(onJournaled).not.toHaveBeenCalled()
  })
})

describe('recovery storage degradation', () => {
  it.each(['RECORD_TOO_LARGE', 'QUOTA_EXCEEDED', 'STORAGE_UNAVAILABLE', 'STORAGE_FULL'])(
    'still saves the captured buffer on %s',
    async code => {
      const unavailable = vi.fn()

      const file = lease({
        recovery: {
          read: vi.fn(),
          discard: vi.fn(),
          write: vi.fn(async () => {
            throw new Error(`DOCUMENT_RECOVERY_${code}`)
          })
        }
      })

      expect(await persistDocumentSnapshot(file, input, vi.fn(), unavailable)).toEqual({
        revision: 'file-r2',
        draftRevision: input.expectedDraftRevision
      })
      expect(file.write).toHaveBeenCalledWith({ text: input.text, expectedRevision: input.baseRevision })
      expect(unavailable).toHaveBeenCalledOnce()
    }
  )
  it.each(['CONFLICT', 'ACCESS_REVOKED', 'CORRUPT'])('does not bypass %s', async code => {
    const unavailable = vi.fn()

    const file = lease({
      recovery: {
        read: vi.fn(),
        discard: vi.fn(),
        write: vi.fn(async () => {
          throw new Error(`DOCUMENT_RECOVERY_${code}`)
        })
      }
    })

    await expect(persistDocumentSnapshot(file, input, vi.fn(), unavailable)).rejects.toThrow(code)
    expect(file.write).not.toHaveBeenCalled()
    expect(unavailable).not.toHaveBeenCalled()
  })
})
