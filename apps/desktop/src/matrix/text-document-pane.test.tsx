import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, TRANSLATIONS } from '@/i18n'
import type { WorkspaceTextFileLease } from '@/lib/workspace-text-file-lease'

import { registerMatrixDocumentDetach, runMatrixDocumentAction } from './text-document-actions'
import { MatrixTextDocumentPane } from './text-document-pane'

vi.mock('@/themes/context', () => ({ useTheme: () => ({ resolvedMode: 'light' }) }))

const rect = { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 900, x: 0, y: 0, toJSON: () => ({}) }

Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })

interface ControlledWrite {
  expectedRevision: string
  resolve: (result: { revision: string }) => void
  reject: (error: Error) => void
  text: string
}

function deferredWrite(input: { expectedRevision: string; text: string }, writes: ControlledWrite[]) {
  return new Promise<{ revision: string }>((resolve, reject) => {
    writes.push({ ...input, resolve, reject })
  })
}

function leaseFor(text: string, options: { recoveryText?: string; delayed?: boolean } = {}) {
  let revision = 'r1'
  const writes: ControlledWrite[] = []

  const recovery = options.recoveryText === undefined
    ? undefined
    : {
        discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
        read: vi.fn(async () => options.recoveryText === undefined
          ? { outcome: 'absent' as const, record: null }
          : { outcome: 'present' as const, record: { draftRevision: 'draft-1', text: options.recoveryText, baseRevision: 'r1', editorRevision: '1', documentId: 'notes', updatedAt: 'now', workspaceRelativePath: 'notes.md' } }),
        write: vi.fn(async ({ text: draftText }) => ({ outcome: 'saved' as const, record: { draftRevision: 'draft-2', text: draftText, baseRevision: revision, editorRevision: '2', documentId: 'notes', updatedAt: 'now', workspaceRelativePath: 'notes.md' } }))
      }

  const lease: WorkspaceTextFileLease = {
    displayName: 'notes.md',
    fileRef: 'opaque',
    read: vi.fn(async () => ({ revision, text, truncated: false })),
    watch: vi.fn(() => () => undefined),
    write: vi.fn(input => {
      if (options.delayed) { return deferredWrite(input, writes) }
      revision = `r${Number(revision.slice(1)) + 1}`
      text = input.text

      return Promise.resolve({ revision })
    }),
    preserveSibling: vi.fn(async () => ({ displayName: 'copy.md' })),
    release: vi.fn(async () => undefined),
    ...(recovery ? { recovery } : {})
  }

  return { lease, writes, recovery }
}

function mount(
  lease: WorkspaceTextFileLease,
  options: { enabled?: boolean; name?: string; onDetachReady?: (prepare: (() => Promise<void>) | null) => void } = {}
) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixTextDocumentPane enabled={options.enabled} lease={lease} name={options.name ?? 'notes.md'} onDetachReady={options.onDetachReady} />
    </I18nProvider>
  )
}

function pane(lease: WorkspaceTextFileLease, options: { enabled?: boolean; name?: string; onDetachReady?: (prepare: (() => Promise<void>) | null) => void } = {}) {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixTextDocumentPane enabled={options.enabled} lease={lease} name={options.name ?? 'notes.md'} onDetachReady={options.onDetachReady} />
    </I18nProvider>
  )
}

function proseMirror(container: HTMLElement): HTMLElement {
  const editor = container.querySelector<HTMLElement>('.ProseMirror')

  if (!editor) { throw new Error('ProseMirror did not mount') }

  return editor
}

function switchToSource() {
  fireEvent.click(screen.getByRole('button', { name: 'View' }))
  fireEvent.click(screen.getByLabelText('Source (advanced)'))

  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Source (advanced)' })
}

beforeEach(() => {
  vi.stubGlobal('ClipboardEvent', class extends Event {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('confirm', vi.fn(() => true))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MatrixTextDocumentPane', () => {
  it('has a plain Atum document-save failure in every desktop locale', () => {
    const sentences = Object.values(TRANSLATIONS).map(catalog => catalog.document.saveFailed)

    expect(sentences).toHaveLength(5)
    expect(sentences.every(sentence => sentence.trim().length > 0)).toBe(true)
    expect(sentences.join('\n')).not.toMatch(/Hermes|Matrix|candidate|_[A-Z_]{2,}/u)
  })

  it('routes mounted ProseMirror input through the canonical controller and revision-CAS autosave', async () => {
    const { lease } = leaseFor('Alpha')
    const view = mount(lease)
    const editor = await waitFor(() => proseMirror(view.container))

    editor.focus()
    editor.querySelector('p')!.textContent = 'Alphax'
    fireEvent.input(editor, { data: 'x', inputType: 'insertText' })

    await waitFor(() => expect(lease.write).toHaveBeenCalledWith({ expectedRevision: 'r1', text: 'Alphax' }))
    expect(screen.getAllByText('Saved').length).toBeGreaterThan(0)
  })

  it('does not acknowledge a newer canonical edit from an older write and chains the returned revision', async () => {
    const { lease, writes } = leaseFor('Alpha', { delayed: true })
    const view = mount(lease)
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Alphax', selectionStart: 6, selectionEnd: 6 } })
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ expectedRevision: 'r1', text: 'Alphax' })

    fireEvent.change(editor, { target: { value: 'Alphaxy', selectionStart: 7, selectionEnd: 7 } })
    await act(async () => { writes[0].resolve({ revision: 'r2' }) })

    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]).toMatchObject({ expectedRevision: 'r2', text: 'Alphaxy' })
    await act(async () => { writes[1].resolve({ revision: 'r3' }) })
    await waitFor(() => expect(screen.getAllByText('Saved').length).toBeGreaterThan(0))
  })

  it('retains the unsaved buffer after a refused CAS write instead of inventing a new base', async () => {
    const { lease, writes } = leaseFor('Alpha', { delayed: true })
    const view = mount(lease)
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Changed', selectionStart: 7, selectionEnd: 7 } })
    await waitFor(() => expect(writes).toHaveLength(1))
    await act(async () => { writes[0].reject(new Error('WORKSPACE_CONFLICT')) })

    await waitFor(() => expect(screen.getAllByText('The recovery copy changed in another window. Reopen this document before saving.').length).toBeGreaterThan(0))
    expect(editor.value).toBe('Changed')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(writes).toHaveLength(1)
  })

  it('requires confirmation before discarding a conflicted local buffer and reloading the current disk copy', async () => {
    const { lease, writes } = leaseFor('Alpha', { delayed: true })
    const view = mount(lease)
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Changed', selectionStart: 7, selectionEnd: 7 } })
    await waitFor(() => expect(writes).toHaveLength(1))
    await act(async () => { writes[0].reject(new Error('WORKSPACE_CONFLICT')) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discard local changes and reload' })).toBeTruthy())
    vi.mocked(lease.read).mockResolvedValue({ revision: 'r2', text: 'Changed elsewhere', truncated: false })

    fireEvent.click(screen.getByRole('button', { name: 'Discard local changes and reload' }))

    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith('Discard your unsaved local changes?'))
    await waitFor(() => expect(editor.value).toBe('Changed elsewhere'))
    expect(screen.queryByRole('button', { name: 'Discard local changes and reload' })).toBeNull()
  })

  it('lets an explicitly discarded conflict detach even when the selected inode cannot be reread', async () => {
    const { lease, writes } = leaseFor('Alpha', { delayed: true })
    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    const view = mount(lease, { onDetachReady: detachReady })
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Changed', selectionStart: 7, selectionEnd: 7 } })
    await waitFor(() => expect(writes).toHaveLength(1))
    await act(async () => { writes[0].reject(new Error('WORKSPACE_CONFLICT')) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discard local changes and close' })).toBeTruthy())
    vi.mocked(lease.read).mockRejectedValue(new Error('WORKSPACE_CONFLICT'))

    fireEvent.click(screen.getByRole('button', { name: 'Discard local changes and close' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Discard local changes and close' })).toBeNull())
    const prepare = detachReady.mock.calls.at(-1)?.[0]
    await expect(prepare!()).resolves.toBeUndefined()
    expect(lease.read).toHaveBeenCalledTimes(1)
  })

  it('does not retry a persistent non-conflict autosave error until another edit or explicit save', async () => {
    const { lease } = leaseFor('Alpha')
    vi.mocked(lease.write).mockRejectedValue(new Error('DISK_FULL'))
    const view = mount(lease)
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Changed', selectionStart: 7, selectionEnd: 7 } })
    await waitFor(() => expect(lease.write).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 180))
    expect(lease.write).toHaveBeenCalledTimes(1)
  })

  it('offers confirmed discard-and-close after a persistent non-conflict save failure', async () => {
    const { lease } = leaseFor('Alpha')
    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    vi.mocked(lease.write).mockRejectedValue(new Error('WORKSPACE_IO_FAILED'))
    const view = mount(lease, { onDetachReady: detachReady })
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Keep until resolved', selectionStart: 19, selectionEnd: 19 } })
    await waitFor(() => expect(lease.write).toHaveBeenCalledTimes(1))
    expect(editor.value).toBe('Keep until resolved')
    fireEvent.click(screen.getByRole('button', { name: 'Discard local changes and close' }))

    const prepare = detachReady.mock.calls.at(-1)?.[0]
    await expect(prepare!()).resolves.toBeUndefined()
    view.unmount()
  })

  it('keeps the buffer and exposes discard when recovery fallback cannot write the file', async () => {
    const { lease } = leaseFor('Alpha')
    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    lease.recovery = {
      discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async () => { throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE') })
    }
    vi.mocked(lease.write).mockRejectedValue(new Error('WORKSPACE_IO_FAILED'))
    const view = mount(lease, { onDetachReady: detachReady })
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Fallback draft', selectionStart: 14, selectionEnd: 14 } })
    await waitFor(() => expect(lease.write).toHaveBeenCalledTimes(1))
    expect(editor.value).toBe('Fallback draft')
    expect(screen.getByRole('button', { name: 'Discard local changes and close' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard local changes and close' }))

    const prepare = detachReady.mock.calls.at(-1)?.[0]
    await expect(prepare!()).resolves.toBeUndefined()
    view.unmount()
  })

  it('keeps a committed CAS revision when recovery cleanup fails', async () => {
    const { lease } = leaseFor('Alpha')
    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    lease.recovery = {
      discard: vi.fn(async () => { throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE') }),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async input => ({ outcome: 'saved' as const, record: { draftRevision: 'd1', text: input.text, baseRevision: input.baseRevision, editorRevision: input.editorRevision, documentId: 'notes', updatedAt: 'now', workspaceRelativePath: 'notes.md' } }))
    }
    const view = mount(lease, { onDetachReady: detachReady })
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Committed file', selectionStart: 14, selectionEnd: 14 } })
    await waitFor(() => expect(lease.write).toHaveBeenCalledWith({ expectedRevision: 'r1', text: 'Committed file' }))
    await waitFor(() => expect(screen.getByText('Local recovery unavailable; save explicitly.')).toBeTruthy())
    expect(screen.queryByText('The recovery copy changed in another window. Reopen this document before saving.')).toBeNull()

    const prepare = detachReady.mock.calls.at(-1)?.[0]
    await expect(prepare!()).resolves.toBeUndefined()
    view.unmount()
  })

  it('resumes a still-active pane when an action rejects after its detach preflight', async () => {
    const { lease } = leaseFor('Alpha')
    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    const view = mount(lease, { onDetachReady: detachReady })
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()
    fireEvent.change(editor, { target: { value: 'Saved before action', selectionStart: 19, selectionEnd: 19 } })
    const prepare = detachReady.mock.calls.at(-1)?.[0]!
    const release = registerMatrixDocumentDetach(prepare)

    try {
      await expect(runMatrixDocumentAction(async () => { throw new Error('ACTION_REJECTED') })).rejects.toThrow('ACTION_REJECTED')
      await waitFor(() => expect(editor.disabled).toBe(false))
      expect(screen.getByText('Couldn’t save. Your changes are still here.')).toBeTruthy()
      expect(view.container.textContent).not.toMatch(/Hermes|Matrix|candidate/u)
    } finally {
      release()
    }

    view.unmount()
  })

  it('retains an offline buffer, blocks document I/O, and allows an explicit discard before detach', async () => {
    const { lease } = leaseFor('Alpha')
    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    const view = mount(lease, { onDetachReady: detachReady })
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Offline draft', selectionStart: 13, selectionEnd: 13 } })
    view.rerender(pane(lease, { enabled: false, onDetachReady: detachReady }))

    expect(editor.value).toBe('Offline draft')
    expect(editor.disabled).toBe(true)
    expect(screen.getByText('Your edits are kept until this room reconnects.')).toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(lease.write).not.toHaveBeenCalled()

    const prepare = detachReady.mock.calls.at(-1)?.[0]
    await expect(prepare!()).rejects.toThrow('MATRIX_TEXT_DOCUMENT_OFFLINE')
    fireEvent.click(screen.getByRole('button', { name: 'Discard local changes and close' }))
    const discardedPrepare = detachReady.mock.calls.at(-1)?.[0]
    await expect(discardedPrepare!()).resolves.toBeUndefined()
  })

  it('keeps a recovered journal draft separate until the user explicitly recovers it', async () => {
    const { lease, recovery } = leaseFor('On disk', { recoveryText: 'Recovered draft' })
    const view = mount(lease)
    await waitFor(() => expect(screen.getByText('A recovered draft is available.')).toBeTruthy())
    expect(proseMirror(view.container).textContent).toContain('On disk')

    fireEvent.click(screen.getByRole('button', { name: 'Recover draft' }))
    await waitFor(() => expect(proseMirror(view.container).textContent).toContain('Recovered draft'))
    await waitFor(() => expect(lease.write).toHaveBeenCalledWith({ expectedRevision: 'r1', text: 'Recovered draft' }))
    expect(recovery?.discard).toHaveBeenCalled()
  })

  it('starts a private recovery checkpoint before the autosave debounce and makes quick detach await it', async () => {
    const { lease } = leaseFor('Alpha')

    let resolveCheckpoint: (result: {
      outcome: 'saved'
      record: { draftRevision: string; text: string; baseRevision: string; editorRevision: string; documentId: string; updatedAt: string; workspaceRelativePath: string }
    }) => void

    const checkpoint = new Promise<{
      outcome: 'saved'
      record: { draftRevision: string; text: string; baseRevision: string; editorRevision: string; documentId: string; updatedAt: string; workspaceRelativePath: string }
    }>(resolve => { resolveCheckpoint = resolve })

    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    // This test needs recovery support without an already-present recovered draft.
    lease.recovery = {
      discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async input => {
        expect(input.text).toBe('Quick edit')

        return checkpoint
      })
    }
    const view = mount(lease, { onDetachReady: detachReady })
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Quick edit', selectionStart: 10, selectionEnd: 10 } })
    await waitFor(() => expect(lease.recovery?.write).toHaveBeenCalled())
    expect(lease.write).not.toHaveBeenCalled()

    const prepare = detachReady.mock.calls.at(-1)?.[0]
    expect(prepare).toBeTypeOf('function')
    const waiting = prepare!()
    let settled = false
    void waiting.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    view.unmount()
    expect(detachReady).toHaveBeenLastCalledWith(null)
    resolveCheckpoint!({ outcome: 'saved', record: { draftRevision: 'draft-1', text: 'Quick edit', baseRevision: 'r1', editorRevision: '1', documentId: 'notes', updatedAt: 'now', workspaceRelativePath: 'notes.md' } })
    await expect(waiting).rejects.toThrow('CAPABILITY_REVOKED')
    expect(lease.write).not.toHaveBeenCalled()
  })

  it('makes a TXT detach barrier persist the latest source through revision CAS', async () => {
    const { lease } = leaseFor('Alpha')
    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    const view = mount(lease, { name: 'notes.txt', onDetachReady: detachReady })
    const editor = await waitFor(() => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Source (advanced)' }))

    fireEvent.change(editor, { target: { value: 'TXT update', selectionStart: 10, selectionEnd: 10 } })
    const prepare = detachReady.mock.calls.at(-1)?.[0]
    await prepare!()
    expect(lease.write).toHaveBeenCalledWith({ expectedRevision: 'r1', text: 'TXT update' })
    view.unmount()
  })

  it('falls back to a revision-CAS save when a recovery checkpoint is unavailable during detach', async () => {
    const { lease } = leaseFor('Alpha')
    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    lease.recovery = {
      discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async () => { throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE') })
    }
    const view = mount(lease, { onDetachReady: detachReady })
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Saved without journal', selectionStart: 20, selectionEnd: 20 } })
    await waitFor(() => expect(lease.recovery?.write).toHaveBeenCalled())
    const prepare = detachReady.mock.calls.at(-1)?.[0]
    await prepare!()

    expect(lease.write).toHaveBeenCalledWith({ expectedRevision: 'r1', text: 'Saved without journal' })
    view.unmount()
  })

  it('allows a failed first load to detach when there is no local edit to protect', async () => {
    const { lease } = leaseFor('Alpha')
    const detachReady = vi.fn<(prepare: (() => Promise<void>) | null) => void>()
    vi.mocked(lease.read).mockRejectedValue(new Error('WORKSPACE_FILE_GONE'))
    const view = mount(lease, { onDetachReady: detachReady })

    await waitFor(() => expect(screen.getByText('Couldn’t save. Your changes are still here.')).toBeTruthy())
    const prepare = detachReady.mock.calls.at(-1)?.[0]
    await expect(prepare!()).resolves.toBeUndefined()
    view.unmount()
  })

  it('does not apply an old room checkpoint acknowledgement to a replacement lease', async () => {
    const { lease: first } = leaseFor('First')

    let resolveCheckpoint: (result: {
      outcome: 'saved'
      record: { draftRevision: string; text: string; baseRevision: string; editorRevision: string; documentId: string; updatedAt: string; workspaceRelativePath: string }
    }) => void

    const checkpoint = new Promise<{
      outcome: 'saved'
      record: { draftRevision: string; text: string; baseRevision: string; editorRevision: string; documentId: string; updatedAt: string; workspaceRelativePath: string }
    }>(resolve => { resolveCheckpoint = resolve })

    first.recovery = {
      discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async () => checkpoint)
    }
    const { lease: second } = leaseFor('Second')
    const view = mount(first)
    await waitFor(() => proseMirror(view.container))
    const editor = switchToSource()

    fireEvent.change(editor, { target: { value: 'Old room draft', selectionStart: 14, selectionEnd: 14 } })
    await waitFor(() => expect(first.recovery?.write).toHaveBeenCalled())
    view.rerender(pane(second))
    await waitFor(() => expect(proseMirror(view.container).textContent).toContain('Second'))

    resolveCheckpoint!({ outcome: 'saved', record: { draftRevision: 'old-draft', text: 'Old room draft', baseRevision: 'r1', editorRevision: '1', documentId: 'notes', updatedAt: 'now', workspaceRelativePath: 'notes.md' } })
    await Promise.resolve()
    expect(proseMirror(view.container).textContent).toContain('Second')
    expect(screen.queryByText('The recovery copy changed in another window. Reopen this document before saving.')).toBeNull()
  })
})
