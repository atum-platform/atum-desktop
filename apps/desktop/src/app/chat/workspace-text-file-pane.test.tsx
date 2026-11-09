import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom reports no platform; the shortcut glyphs in these assertions are macOS's.
vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' })
})

import type * as WorkspaceDocumentExport from '@/lib/workspace-document-export'
import type { WorkspaceTextFileRecovery } from '@/lib/workspace-text-file-lease'
import {
  $reviewsByScope,
  recordAgentEdit,
  resetAgentEditReviews,
  setReviewPending,
  settleTurn
} from '@/store/agent-edits'
import { $gateway } from '@/store/gateway'
import { registerSurfaceReader } from '@/store/surface-capture'
import {
  $workspaceTextFileTabs,
  registerWorkspaceTextFileTarget,
  requestCloseWorkspaceTextFileTab,
  workspaceTextFileTarget
} from '@/store/workspace-text-files'

import { resolveDocumentTheme } from '../../../shared/atum-office/document-theme'

import type { RichDocumentEditorProps } from './document/rich-document-editor'
import { resetDocumentEditModeMemory, WorkspaceTextFilePane } from './workspace-text-file-pane'

const exportWorkspaceDocument = vi.fn()
const revealWorkspaceDocumentExport = vi.fn()
const shareWorkspaceDocumentExport = vi.fn()
// Counts canvas-compartment reconfigures dispatched through the editor API.
const canvasDispatches = vi.hoisted(() => [] as number[])

// This suite isolates lease/recovery orchestration with a fake source editor.
// The rich projection is exercised with both real editors in its integration suite.
vi.mock('./document/rich-document-editor', () => ({
  RichDocumentEditor: ({ onEligibility, onPasteFeedback, onRefused }: RichDocumentEditorProps) => (
    <>
      <button onClick={() => onEligibility?.(true)} type="button">rich eligible</button>
      <button onClick={() => { onRefused?.('gate'); onPasteFeedback?.('refused', true) }} type="button">refuse paste</button>
      <button onClick={() => onPasteFeedback?.('simplified')} type="button">simplify paste</button>
    </>
  )
}))
vi.mock('@/store/surface-capture', () => ({ registerSurfaceReader: vi.fn(() => () => undefined) }))

vi.mock('@/lib/workspace-document-export', async importOriginal => ({
  // The theme resolver is real: it goes through the bridge and falls back on its own.
  resolveWorkspaceDocumentTheme: (await importOriginal<typeof WorkspaceDocumentExport>()).resolveWorkspaceDocumentTheme,
  setWorkspaceDocumentTheme: (await importOriginal<typeof WorkspaceDocumentExport>()).setWorkspaceDocumentTheme,
  exportWorkspaceDocument: (...args: unknown[]) => exportWorkspaceDocument(...args),
  revealWorkspaceDocumentExport: (...args: unknown[]) => revealWorkspaceDocumentExport(...args),
  shareWorkspaceDocumentExport: (...args: unknown[]) => shareWorkspaceDocumentExport(...args)
}))
vi.mock('@/components/chat/markdown-live', () => ({
  markdownLive: () => [],
  markdownLiveTheme: []
}))
vi.mock('@/components/chat/markdown-commands', () => ({
  insertTable: () => true,
  toggleCodeBlock: () => true,
  toggleInlineCode: () => true,
  toggleOrderedList: () => true,
  toggleQuote: () => true,
  toggleStrikethrough: () => true,
  activeFormats: () => ({
    code: false,
    codeBlock: false,
    emphasis: false,
    heading: 0,
    link: false,
    list: false,
    orderedList: false,
    quote: false,
    strikethrough: false,
    strong: false
  }),
  cycleHeading: vi.fn(() => true),
  setHeading: vi.fn(() => true),
  insertLink: vi.fn(() => true),
  markdownKeymap: [],
  toggleBulletList: vi.fn(() => true),
  toggleEmphasis: vi.fn(() => true),
  toggleStrong: vi.fn(() => true)
}))
vi.mock('@/components/chat/code-editor', () => ({
  CodeEditor: ({
    apiRef,
    disabled,
    initialValue,
    onChange,
    onCompositionChange,
    onSave
  }: {
    disabled?: boolean
    apiRef?: { current: unknown }
    initialValue: string
    onChange: (value: string) => void
    onCompositionChange?: (composing: boolean) => void
    onSave?: () => void
  }) => {
    const [history, setHistory] = useState([initialValue])

    if (apiRef) {
      // A live editor always has a state; the formats path must cope with a
      // fresh format object on every read without re-rendering forever.
      apiRef.current = {
        dispatchCommand: (command: (view: unknown) => boolean) => {
          const effects: unknown[] = []
          command({ dispatch: (tr: { effects?: unknown }) => effects.push(tr.effects) })
          canvasDispatches.push(effects.length)

          return true
        },
        focus: () => undefined,
        getDoc: () => history.at(-1)!,
        getVisibleText: () => 'stale source viewport',
        getSelection: () => ({ from: 0, to: 0 }),
        getState: () => ({ doc: history.at(-1)! })
      }
    }

    const value = history.at(-1)!

    const change = (next: string) => {
      setHistory(current => [...current, next])
      onChange(next)
    }

    return (
      <div>
        <textarea
          data-testid="editor-buffer"
          disabled={disabled}
          onChange={event => change(event.target.value)}
          value={value}
        />
        <button onClick={() => change('human draft')} type="button">
          type draft
        </button>
        <button
          onClick={() => {
            const previous = history.at(-2) ?? history[0]!
            setHistory(current => (current.length > 1 ? current.slice(0, -1) : current))
            onChange(previous)
          }}
          type="button"
        >
          editor undo
        </button>
        <button onClick={onSave} type="button">
          editor save
        </button>
        <button onClick={() => onCompositionChange?.(true)} type="button">
          composition start
        </button>
        <button onClick={() => onCompositionChange?.(false)} type="button">
          composition end
        </button>
      </div>
    )
  }
}))

vi.mock('@/components/chat/diff-lines', () => ({
  FileDiffPanel: ({ diff }: { diff: string }) => <pre data-testid="draft-diff">{diff}</pre>
}))

vi.mock('./right-rail/preview-markdown', () => ({
  MarkdownPreview: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>
}))

function tab(fileRef = 'opaque-one', workspaceRelativePath = 'docs/note.md') {
  return registerWorkspaceTextFileTarget(
    workspaceTextFileTarget({ displayName: 'note.md', fileRef, workspaceRelativePath })
  )!
}

function review(overrides: Partial<Parameters<typeof recordAgentEdit>[1]> = {}) {
  recordAgentEdit('atum-chat:chat-a', {
    sessionId: 'session-a',
    turnId: 'turn-a',
    restorePath: 'docs/note.md',
    checkpoint: { hash: 'checkpoint-a', working_dir: '/workspace' },
    diff: '--- before\n+++ after\n@@ -1 +1 @@\n-old\n+agent edit',
    diffTruncated: false,
    restoreAvailable: true,
    ...overrides
  })
}

// The document text lives in the editor buffer while editing and in the
// rendered surface otherwise; assertions should not care which.
const docText = () =>
  (screen.queryByTestId('editor-buffer') as HTMLTextAreaElement | null)?.value ??
  screen.queryByTestId('markdown')?.textContent ??
  null

const findDoc = (text: string) => waitFor(() => expect(docText()).toBe(text))

// Workspace documents open straight into the editor; a lease opened from
// elsewhere still shows Edit first. Enter editing either way.
const enterEdit = () => {
  const edit = screen.queryByText('Edit')

  if (edit) {
    fireEvent.click(edit)
  }
}

const commandCategory = (name: 'write' | 'page' | 'view') =>
  globalThis.document.querySelector<HTMLButtonElement>(`[data-document-command-category="${name}"]`)!

const showWriteCommands = () => fireEvent.click(commandCategory('write'))
const showPageControls = () => fireEvent.click(commandCategory('page'))
const showViewControls = () => fireEvent.click(commandCategory('view'))

const writeModeControl = () =>
  screen.getAllByRole('button', { name: 'Write' }).find(button => !button.dataset.documentCommandCategory)!

function bridge({
  recovery
}: {
  recovery?: WorkspaceTextFileRecovery
} = {}) {
  let watcher: ((revision: string) => void) | null = null

  const api = {
    openTextFile: vi.fn(async () => ({ displayName: 'note.md', fileRef: 'opaque-two' })),
    preserveTextFileSibling: vi.fn(async () => ({ displayName: 'note (preserved).md' })),
    readTextFile: vi.fn(async () => ({ revision: 'r1', text: '# original', truncated: false })),
    releaseTextFile: vi.fn(async () => undefined),
    watchTextFile: vi.fn((_fileRef: string, onRevision: (revision: string) => void) => {
      watcher = onRevision

      return () => {
        watcher = null
      }
    }),
    writeTextFile: vi.fn(async () => ({ revision: 'r2' })),
    documentTheme: vi.fn(async () => ({
      ...resolveDocumentTheme({ themeId: 'book' }, 2),
      headingSizesPt: [19, 16, 14, 12.5, 11.5, 11]
    })),
    documentThemeSet: vi.fn(async (input: { selection: { themeId: 'book' } | null }) => ({
      persisted: true,
      theme: input.selection ? resolveDocumentTheme(input.selection, 5) : resolveDocumentTheme(null)
    })),
    ...(recovery
      ? {
          recovery: {
            version: 1 as const,
            discard: (_fileRef: string, revision: string) => recovery.discard(revision),
            read: (_fileRef: string) => recovery.read(),
            write: (_fileRef: string, input: Parameters<WorkspaceTextFileRecovery['write']>[0]) => recovery.write(input)
          }
        }
      : {})
  }

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { filesystemCapability: api }
  })

  return { api, notifyRevision: (revision = 'r2') => watcher?.(revision), recovery }
}

function recoveryRecord(draftRevision = 'draft-1', text = 'recovered draft') {
  return {
    baseRevision: 'r1',
    documentId: 'opaque-one',
    draftRevision,
    editorRevision: '1',
    text,
    updatedAt: '2026-09-06T00:00:00.000Z',
    workspaceRelativePath: 'docs/note.md'
  }
}

describe('WorkspaceTextFilePane', () => {
  it('renders actionable paste feedback above generic edit refusal and clears it after editing', async () => {
    bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'rich eligible', hidden: true }))
    fireEvent.click(screen.getByRole('button', { name: 'refuse paste' }))
    expect(screen.getByRole('button', { name: 'Paste text only' })).toBeTruthy()
    expect(screen.getByText('This content could not be pasted. Try a smaller selection.')).toBeTruthy()
    expect(screen.queryByText('This edit cannot be saved in the current document format.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'simplify paste' }))
    expect(screen.queryByRole('button', { name: 'Paste text only' })).toBeNull()
    expect(screen.getByText(/Pasted with supported formatting/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'type draft', hidden: true }))
    expect(screen.queryByText(/Pasted with supported formatting/)).toBeNull()
  })

  it('does not use a hidden source viewport as rich or rendered document context', async () => {
    bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    fireEvent.click(await screen.findByRole('button', { name: 'rich eligible', hidden: true }))
    const read = vi.mocked(registerSurfaceReader).mock.calls.at(-1)![2]
    expect(read()).toMatchObject({ text: '# original', excerpt: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'type draft', hidden: true }))
    expect(read()).toMatchObject({ text: 'human draft', dirty: true, excerpt: undefined })
    showViewControls()
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    expect(read()).toMatchObject({ text: 'human draft', excerpt: undefined })
  })

  it('never writes a partially loaded file back over the complete document', async () => {
    const { api } = bridge()
    api.readTextFile.mockResolvedValue({ revision: 'r1', text: 'partial', truncated: true })
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('partial')
    expect((screen.getByTestId('editor-buffer') as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('editor save'))
    expect(api.writeTextFile).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    vi.useRealTimers()
    window.localStorage.clear()
    $workspaceTextFileTabs.set([])
    resetAgentEditReviews()
    $gateway.set(null)
    resetDocumentEditModeMemory()
  })

  afterEach(() => vi.useRealTimers())

  it('shows the matching review, renders its agent diff, and restores the previous mode on done', async () => {
    bridge()
    review()

    render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)

    expect(await screen.findByText('Atum made changes')).toBeTruthy()
    fireEvent.click(screen.getByText('View changes'))
    expect(screen.getByTestId('draft-diff').textContent).toContain('+agent edit')
    fireEvent.click(screen.getByText('Done'))
    expect(docText()).toBe('# original')
    expect(screen.queryByText('Atum made changes')).toBeNull()
  })

  it('does not show a review from another document or chat scope', async () => {
    bridge()
    review()

    const view = render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-b" tab={tab()} />)
    await findDoc('# original')
    expect(screen.queryByText('Atum made changes')).toBeNull()
    view.unmount()

    render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab('opaque-other', 'docs/other.md')} />)
    await findDoc('# original')
    expect(screen.queryByText('Atum made changes')).toBeNull()
  })

  it('guards undo while unsettled, pending, dirty, or changed after the reviewed revision', async () => {
    const { api, notifyRevision } = bridge()
    review()
    const targetTab = tab()
    const view = render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={targetTab} />)

    expect(await screen.findByText('Atum made changes')).toBeTruthy()
    expect((screen.getByText('Undo').closest('button') as HTMLButtonElement).disabled).toBe(true)
    settleTurn('session-a', 'turn-a')
    await waitFor(() => expect((screen.getByText('Undo').closest('button') as HTMLButtonElement).disabled).toBe(false))

    const current = Object.values($reviewsByScope.get()['atum-chat:chat-a']!)[0]!
    setReviewPending(current, 'undo')
    await waitFor(() => expect((screen.getByText('Undo').closest('button') as HTMLButtonElement).disabled).toBe(true))
    setReviewPending(current, null)

    enterEdit()
    fireEvent.click(screen.getByText('type draft'))
    expect(await screen.findByText('Save current draft')).toBeTruthy()
    expect(screen.queryByText('Undo')).toBeNull()
    fireEvent.click(screen.getByText('Later'))
    // "Để sau" keeps the draft and the review: the strip collapses to the bar,
    // Undo stays disabled while the buffer is dirty.
    expect(screen.queryByText('Save current draft')).toBeNull()
    expect((screen.getByText('Undo').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Undo').closest('button')?.getAttribute('aria-description')).toBe(
      'Save or discard your current draft before undoing.'
    )

    view.unmount()
    resetAgentEditReviews()
    review()
    settleTurn('session-a', 'turn-a')
    render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={targetTab} />)
    expect(await screen.findByText('Atum made changes')).toBeTruthy()
    api.readTextFile.mockResolvedValueOnce({ revision: 'agent-r2', text: '# agent', truncated: false })
    act(() => notifyRevision('agent-r2'))
    await findDoc('# agent')
    api.readTextFile.mockResolvedValueOnce({ revision: 'later-r3', text: '# later', truncated: false })
    act(() => notifyRevision('later-r3'))
    await findDoc('# later')
    expect((screen.getByText('Undo').closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Undo').closest('button')?.getAttribute('aria-description')).toBe(
      'The document changed again; Atum will not undo automatically to avoid losing content.'
    )
  })

  it('saves or discards a dirty draft through the review conflict strip', async () => {
    const { api, notifyRevision } = bridge()
    review()
    settleTurn('session-a', 'turn-a')
    const request = vi.fn(async () => ({ success: true }))
    $gateway.set({ request } as never)
    render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)

    await screen.findByText('Atum made changes')
    enterEdit()
    fireEvent.click(screen.getByText('type draft'))
    fireEvent.click(screen.getByText('Save current draft'))
    await waitFor(() => expect(api.writeTextFile).toHaveBeenCalled())
    expect(await screen.findByText('Undo')).toBeTruthy()

    // Atum edits again after the save; a fresh human draft on top of it is dirty.
    api.readTextFile.mockResolvedValueOnce({ revision: 'agent-r2', text: '# agent', truncated: false })
    act(() => notifyRevision('agent-r2'))
    // The review surface shows the agent diff, not the document itself.
    await waitFor(() => expect(globalThis.document.body.textContent).toContain('# agent'))

    enterEdit()
    fireEvent.click(screen.getByText('type draft'))
    fireEvent.click(screen.getByText('Discard draft and undo'))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('rollback.restore', {
        session_id: 'session-a',
        hash: 'checkpoint-a',
        file_path: 'docs/note.md'
      })
    )
    expect(screen.queryByText('Atum made changes')).toBeNull()
  })

  it('keeps a failed restore recoverable and prevents duplicate restore requests', async () => {
    bridge()
    review()
    settleTurn('session-a', 'turn-a')
    let resolveRestore!: (value: { success: boolean; error?: string }) => void

    const request = vi.fn(
      () =>
        new Promise<{ success: boolean; error?: string }>(resolve => {
          resolveRestore = resolve
        })
    )

    $gateway.set({ request } as never)
    render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)

    const undo = await screen.findByText('Undo')
    fireEvent.click(undo)
    fireEvent.click(undo)
    expect(request).toHaveBeenCalledTimes(1)
    resolveRestore({ success: false, error: 'checkpoint missing' })
    expect(await screen.findByText(/Could not undo: checkpoint missing/)).toBeTruthy()
    expect(screen.getByText('Try again')).toBeTruthy()
    expect(screen.getByText('Atum made changes')).toBeTruthy()
    expect((screen.getByText('Undo').closest('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('hides undo when no checkpoint restore is available', async () => {
    bridge()
    review({ checkpoint: null, restoreAvailable: false })
    render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)

    expect(await screen.findByText('Atum made changes')).toBeTruthy()
    expect(screen.queryByText('Undo')).toBeNull()
  })

  it('writes through the observed revision and keeps one canonical buffer', async () => {
    const { api } = bridge()
    const targetTab = tab()

    render(<WorkspaceTextFilePane tab={targetTab} />)

    await findDoc('# original')
    enterEdit()
    fireEvent.click(screen.getByText('type draft'))
    fireEvent.click(screen.getByText('editor save'))

    await waitFor(() =>
      expect(api.writeTextFile).toHaveBeenCalledWith('opaque-one', {
        expectedRevision: 'r1',
        text: 'human draft'
      })
    )
    expect($workspaceTextFileTabs.get()).toHaveLength(1)
  })

  it('keeps newer typing dirty while an acknowledged autosave is still in flight', async () => {
    let finishWrite!: (value: { revision: string }) => void

    const recovery = {
      discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async () => ({ outcome: 'saved' as const, record: recoveryRecord() }))
    }

    const { api } = bridge({ recovery })
    api.writeTextFile.mockImplementationOnce(() => new Promise(resolve => (finishWrite = resolve)))
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(recovery.read).toHaveBeenCalledTimes(1))

    vi.useFakeTimers()
    fireEvent.change(screen.getByTestId('editor-buffer'), { target: { value: 'first draft' } })
    await act(async () => vi.advanceTimersByTimeAsync(750))
    expect(api.writeTextFile).toHaveBeenCalledWith('opaque-one', { expectedRevision: 'r1', text: 'first draft' })

    fireEvent.change(screen.getByTestId('editor-buffer'), { target: { value: 'newer draft' } })
    expect(api.writeTextFile).toHaveBeenCalledTimes(1)

    await act(async () => finishWrite({ revision: 'r2' }))
    expect(screen.getAllByRole('status').some(status => status.textContent?.includes('Unsaved changes'))).toBe(true)
    expect(api.writeTextFile).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(750))
    expect(api.writeTextFile).toHaveBeenLastCalledWith('opaque-one', { expectedRevision: 'r2', text: 'newer draft' })
  })

  it('waits 750ms after composition ends before autosaving', async () => {
    const recovery = {
      discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async () => ({ outcome: 'saved' as const, record: recoveryRecord() }))
    }

    const { api } = bridge({ recovery })
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(recovery.read).toHaveBeenCalledTimes(1))

    vi.useFakeTimers()
    fireEvent.change(screen.getByTestId('editor-buffer'), { target: { value: 'đang soạn' } })
    fireEvent.click(screen.getByText('composition start'))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(api.writeTextFile).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('composition end'))
    await act(async () => vi.advanceTimersByTimeAsync(749))
    expect(api.writeTextFile).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(api.writeTextFile).toHaveBeenCalledWith('opaque-one', { expectedRevision: 'r1', text: 'đang soạn' })
  })

  it('shows a recovery choice and does not autosave before the person chooses it', async () => {
    const recovery = {
      discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
      read: vi.fn(async () => ({ outcome: 'present' as const, record: recoveryRecord('draft-available') })),
      write: vi.fn(async () => ({ outcome: 'saved' as const, record: recoveryRecord() }))
    }

    const { api } = bridge({ recovery })
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    expect(await screen.findByText('A recovered draft is available.')).toBeTruthy()

    vi.useFakeTimers()
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(recovery.write).not.toHaveBeenCalled()
    expect(api.writeTextFile).not.toHaveBeenCalled()
  })

  it('halts file writes when the recovery journal reports a stale draft', async () => {
    const recovery = {
      discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async () => ({ outcome: 'stale' as const, record: recoveryRecord('other-window') }))
    }

    const { api } = bridge({ recovery })
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(recovery.read).toHaveBeenCalledTimes(1))

    vi.useFakeTimers()
    fireEvent.change(screen.getByTestId('editor-buffer'), { target: { value: 'must not write' } })
    await act(async () => vi.advanceTimersByTimeAsync(750))
    expect(recovery.write).toHaveBeenCalledTimes(1)
    expect(api.writeTextFile).not.toHaveBeenCalled()
    vi.useRealTimers()
    expect(
      await screen.findByText('The recovery copy changed in another window. Reopen this document before saving.')
    ).toBeTruthy()
  })

  it('falls back to explicit saving after journal quota failure without losing the captured draft', async () => {
    const recovery = {
      discard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async () => {
        throw new Error('DOCUMENT_RECOVERY_QUOTA_EXCEEDED')
      })
    }

    const { api } = bridge({ recovery })
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(recovery.read).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    fireEvent.change(screen.getByTestId('editor-buffer'), { target: { value: 'save despite quota' } })
    await act(async () => vi.advanceTimersByTimeAsync(750))
    expect(api.writeTextFile).toHaveBeenCalledWith('opaque-one', { expectedRevision: 'r1', text: 'save despite quota' })
    expect(screen.getByText('Local recovery unavailable; save explicitly.')).toBeTruthy()
    fireEvent.change(screen.getByTestId('editor-buffer'), { target: { value: 'next manual draft' } })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(api.writeTextFile).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Save')).toBeTruthy()
    fireEvent.click(screen.getByText('editor save'))
    await act(async () => undefined)
    expect(api.writeTextFile).toHaveBeenLastCalledWith('opaque-one', {
      expectedRevision: 'r2',
      text: 'next manual draft'
    })
  })

  it('classifies Electron-wrapped recovery conflicts and reloads recovery on Retry', async () => {
    const recovery = {
      discard: vi.fn(),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'atum:filesystem:lease-recovery-write': Error: DOCUMENT_RECOVERY_CONFLICT"
        )
      })
    }

    const { api } = bridge({ recovery })
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(recovery.read).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    fireEvent.change(screen.getByTestId('editor-buffer'), { target: { value: 'conflicted draft' } })
    await act(async () => vi.advanceTimersByTimeAsync(750))
    expect(api.writeTextFile).not.toHaveBeenCalled()
    expect(
      screen.getByText('The recovery copy changed in another window. Reopen this document before saving.')
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => undefined)
    expect(recovery.read).toHaveBeenCalledTimes(2)
    expect(recovery.write).toHaveBeenCalledTimes(1)
  })

  it('keeps a corrupt-journal draft dirty until the person explicitly saves', async () => {
    const recovery = {
      discard: vi.fn(),
      read: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
      write: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'atum:filesystem:lease-recovery-write': Error: DOCUMENT_RECOVERY_CORRUPT"
        )
      })
    }

    const { api } = bridge({ recovery })
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(recovery.read).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    fireEvent.change(screen.getByTestId('editor-buffer'), { target: { value: 'preserve this live buffer' } })
    await act(async () => vi.advanceTimersByTimeAsync(750))
    expect(api.writeTextFile).not.toHaveBeenCalled()
    expect(screen.getByText('Local recovery unavailable; save explicitly.')).toBeTruthy()
    fireEvent.click(screen.getByText('editor save'))
    await act(async () => undefined)
    expect(api.writeTextFile).toHaveBeenCalledWith('opaque-one', {
      expectedRevision: 'r1',
      text: 'preserve this live buffer'
    })
    expect(recovery.write).toHaveBeenCalledTimes(1)
  })

  it('retains explicit Save when the recovery capability is unavailable', async () => {
    const { api } = bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    fireEvent.click(screen.getByText('type draft'))

    expect(screen.getByText('Save')).toBeTruthy()
    fireEvent.click(screen.getByText('editor save'))
    await waitFor(() =>
      expect(api.writeTextFile).toHaveBeenCalledWith('opaque-one', { expectedRevision: 'r1', text: 'human draft' })
    )
  })

  it('keeps the draft, selection, scroll position, and undo history across mode round trips', async () => {
    bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)

    await findDoc('# original')
    enterEdit()
    const editor = screen.getByTestId('editor-buffer') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '# draft text' } })
    editor.setSelectionRange(2, 7)
    editor.scrollTop = 24

    showViewControls()
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    fireEvent.click(screen.getByText('Changes'))
    fireEvent.click(writeModeControl())

    const restored = screen.getByTestId('editor-buffer') as HTMLTextAreaElement
    expect(restored).toBe(editor)
    expect(restored.value).toBe('# draft text')
    expect({ from: restored.selectionStart, to: restored.selectionEnd }).toEqual({ from: 2, to: 7 })
    expect(restored.scrollTop).toBe(24)
    fireEvent.click(screen.getByText('editor undo'))
    expect(restored.value).toBe('# original')
  })

  it('keeps a dirty draft during watcher reload and preserves both versions', async () => {
    const { api, notifyRevision } = bridge()
    const targetTab = tab()

    render(<WorkspaceTextFilePane tab={targetTab} />)
    await findDoc('# original')
    enterEdit()
    fireEvent.click(screen.getByText('type draft'))

    api.readTextFile.mockResolvedValueOnce({ revision: 'external-r2', text: '# agent edit', truncated: false })
    act(() => notifyRevision('external-r2'))

    expect(await screen.findByText('File changed on disk')).toBeTruthy()
    showViewControls()
    fireEvent.click(screen.getByText('Changes'))
    expect(screen.getByTestId('draft-diff').textContent).toContain('-# agent edit')
    expect(screen.getByTestId('draft-diff').textContent).toContain('+human draft')

    fireEvent.click(screen.getByText('Preserve draft as sibling'))

    await waitFor(() =>
      expect(api.preserveTextFileSibling).toHaveBeenCalledWith('opaque-one', {
        expectedRevision: 'r1',
        text: 'human draft'
      })
    )
    expect(api.writeTextFile).not.toHaveBeenCalled()
    expect(await screen.findByText('Draft preserved as note (preserved).md.')).toBeTruthy()
  })

  it('retains an active composition when a watcher reports an external revision before source changes', async () => {
    const { api, notifyRevision } = bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    const editor = screen.getByTestId('editor-buffer')
    fireEvent.click(screen.getByText('composition start'))
    api.readTextFile.mockResolvedValueOnce({ revision: 'external-r2', text: '# agent edit', truncated: false })
    act(() => notifyRevision('external-r2'))

    expect(await screen.findByText('File changed on disk')).toBeTruthy()
    expect(screen.getByTestId('editor-buffer')).toBe(editor)
    expect((editor as HTMLTextAreaElement).value).toBe('# original')
    expect(api.writeTextFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('composition end'))
  })

  it('reloads a clean pane when the lease watcher observes an external revision', async () => {
    const { api, notifyRevision } = bridge()
    const targetTab = tab()

    render(<WorkspaceTextFilePane tab={targetTab} />)
    await findDoc('# original')
    api.readTextFile.mockResolvedValueOnce({ revision: 'external-r2', text: '# agent edit', truncated: false })
    act(() => notifyRevision('external-r2'))

    await findDoc('# agent edit')
    expect(screen.queryByText('File changed on disk')).toBeNull()
  })

  it('does not let an older watcher read overwrite a newer revision', async () => {
    const { api, notifyRevision } = bridge()
    const targetTab = tab()
    let resolveOlder!: (value: { revision: string; text: string; truncated: false }) => void
    let resolveNewer!: (value: { revision: string; text: string; truncated: false }) => void

    const older = new Promise<{ revision: string; text: string; truncated: false }>(resolve => {
      resolveOlder = resolve
    })

    const newer = new Promise<{ revision: string; text: string; truncated: false }>(resolve => {
      resolveNewer = resolve
    })

    render(<WorkspaceTextFilePane tab={targetTab} />)
    await findDoc('# original')
    api.readTextFile.mockReturnValueOnce(older).mockReturnValueOnce(newer)
    act(() => notifyRevision('older-r2'))
    act(() => notifyRevision('newer-r3'))
    resolveNewer({ revision: 'newer-r3', text: '# newest', truncated: false })
    await findDoc('# newest')
    resolveOlder({ revision: 'older-r2', text: '# stale', truncated: false })

    await waitFor(() => expect(docText()).not.toBe('# stale'))
    expect(docText()).toBe('# newest')
  })

  it('preserves a dirty sibling before releasing and removing a closing tab', async () => {
    const order: string[] = []
    const { api } = bridge()
    api.preserveTextFileSibling.mockImplementation(async () => {
      order.push('preserve')

      return { displayName: 'note (preserved).md' }
    })
    api.releaseTextFile.mockImplementation(async () => {
      order.push('release')
    })
    const targetTab = tab()

    render(<WorkspaceTextFilePane tab={targetTab} />)
    await findDoc('# original')
    enterEdit()
    fireEvent.click(screen.getByText('type draft'))

    await act(async () => {
      expect(await requestCloseWorkspaceTextFileTab('opaque-one')).toBe(false)
    })
    expect(screen.getByText('Preserve changes before closing?')).toBeTruthy()
    fireEvent.click(screen.getByText('Preserve draft as sibling'))

    await waitFor(() => expect($workspaceTextFileTabs.get()).toEqual([]))
    expect(order).toEqual(['preserve', 'release'])
    expect(window.localStorage.getItem('hermes.desktop.workspaceTextFileTabs.v1')).toBe('[]')
  })

  it('restores the same opaque descriptor after a renderer restart', async () => {
    const { api } = bridge()
    const restored = tab()
    const first = render(<WorkspaceTextFilePane tab={restored} />)

    await findDoc('# original')
    first.unmount()
    render(<WorkspaceTextFilePane tab={$workspaceTextFileTabs.get()[0]!} />)

    await findDoc('# original')
    expect(api.readTextFile).toHaveBeenCalledTimes(2)
    expect(api.openTextFile).not.toHaveBeenCalled()
  })

  it('surfaces a stale restored descriptor and replaces it only after explicit reopen', async () => {
    const { api } = bridge()
    api.readTextFile.mockRejectedValueOnce(new Error('CAPABILITY_STALE'))
    const restored = tab()

    render(<WorkspaceTextFilePane tab={restored} />)

    expect(await screen.findByText('Reopen this file')).toBeTruthy()
    expect($workspaceTextFileTabs.get()[0]?.target.workspaceTextFile.fileRef).toBe('opaque-one')
    fireEvent.click(screen.getByText('Choose file again'))

    await waitFor(() => expect($workspaceTextFileTabs.get()[0]?.target.workspaceTextFile.fileRef).toBe('opaque-two'))
    expect(api.releaseTextFile).toHaveBeenCalledWith('opaque-one')
  })

  it('fails a remote-style stale write closed without discarding the draft', async () => {
    const { api } = bridge()
    api.writeTextFile.mockRejectedValueOnce(new Error('CAPABILITY_STALE'))
    const targetTab = tab('opaque-remote')

    render(<WorkspaceTextFilePane tab={targetTab} />)
    await findDoc('# original')
    enterEdit()
    fireEvent.click(screen.getByText('type draft'))
    fireEvent.click(screen.getByText('editor save'))

    expect(await screen.findByText("Couldn't save: CAPABILITY_STALE")).toBeTruthy()
    expect(screen.getByText('type draft')).toBeTruthy()
    expect(api.releaseTextFile).not.toHaveBeenCalled()
  })

  it('does not re-render forever when the live toolbar reads a fresh format object each time', async () => {
    bridge()
    const errors: unknown[] = []

    const onError = (event: ErrorEvent) => {
      errors.push(event.error)
      event.preventDefault()
    }

    window.addEventListener('error', onError)

    try {
      render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)
      await findDoc('# original')
      enterEdit()
      expect(await screen.findByRole('toolbar', { name: 'Document controls' })).toBeTruthy()
      fireEvent.click(screen.getByText('type draft'))
      expect(screen.getByRole('toolbar', { name: 'Document controls' })).toBeTruthy()
    } finally {
      window.removeEventListener('error', onError)
    }

    expect(errors.filter(error => String(error).includes('Maximum update depth'))).toEqual([])
  })

  it('opens a Markdown document in Soạn thảo with the toolbar, remembers Nguồn per tab, and keeps .txt in source', async () => {
    bridge()
    render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)
    await findDoc('# original')
    enterEdit()

    expect(screen.getByRole('toolbar', { name: 'Document controls' })).toBeTruthy()
    showWriteCommands()
    expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy()
    showViewControls()
    expect(writeModeControl()).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    expect(screen.getByTestId('markdown')).toBeTruthy()
    fireEvent.click(writeModeControl())
    expect(screen.getByTestId('editor-buffer')).toBeTruthy()
    cleanup()

    bridge()
    render(
      <WorkspaceTextFilePane
        scopeKey="atum-chat:chat-a"
        tab={
          registerWorkspaceTextFileTarget(
            workspaceTextFileTarget({
              displayName: 'notes.txt',
              fileRef: 'opaque-txt',
              workspaceRelativePath: 'notes.txt'
            })
          )!
        }
      />
    )
    await findDoc('# original')
    enterEdit()
    expect(screen.queryByText('Write')).toBeNull()
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  describe('Xuất', () => {
    const openExportMenu = async () => {
      const trigger = await screen.findByRole('button', { name: 'Export' })
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Word file (.docx)' }))
    }

    beforeEach(() => {
      exportWorkspaceDocument.mockReset()
      revealWorkspaceDocumentExport.mockReset()
      shareWorkspaceDocumentExport.mockReset()
    })

    it('exports a clean document, shows the outcome strip, and reveals through the export reference', async () => {
      bridge()
      exportWorkspaceDocument.mockResolvedValue({
        byteSize: 1234,
        displayName: 'note.docx',
        exportRef: 'ref-1',
        format: 'docx',
        workspaceRelativePath: 'docs/note.docx'
      })
      revealWorkspaceDocumentExport.mockResolvedValue({ revealed: true })
      render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)
      await findDoc('# original')

      await openExportMenu()
      expect(await screen.findByText('Exported · note.docx')).toBeTruthy()
      expect(exportWorkspaceDocument).toHaveBeenCalledWith('opaque-one', 'docx', undefined)
      fireEvent.click(screen.getByText('Show file'))
      await waitFor(() => expect(revealWorkspaceDocumentExport).toHaveBeenCalledWith('ref-1'))
      fireEvent.click(screen.getByText('Done'))
      expect(screen.queryByText('Exported · note.docx')).toBeNull()
    })

    it('exports a PDF from the menu and shares through the export reference', async () => {
      bridge()
      exportWorkspaceDocument.mockResolvedValue({
        byteSize: 9,
        displayName: 'note.pdf',
        exportRef: 'ref-pdf',
        format: 'pdf',
        workspaceRelativePath: 'docs/note.pdf'
      })
      shareWorkspaceDocumentExport.mockResolvedValue({ shared: true })
      render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)
      await findDoc('# original')

      const trigger = await screen.findByRole('button', { name: 'Export' })
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'PDF' }))
      expect(await screen.findByText('Exported · note.pdf')).toBeTruthy()
      expect(exportWorkspaceDocument).toHaveBeenCalledWith('opaque-one', 'pdf', undefined)
      fireEvent.click(screen.getByText('Share…'))
      await waitFor(() => expect(shareWorkspaceDocumentExport).toHaveBeenCalledWith('ref-pdf'))
    })

    it('offers save-then-export for a dirty draft and exports only after the save succeeds', async () => {
      const { api } = bridge()
      exportWorkspaceDocument.mockResolvedValue({
        byteSize: 1,
        displayName: 'note.docx',
        exportRef: 'ref-2',
        format: 'docx',
        workspaceRelativePath: 'docs/note.docx'
      })
      render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)
      await findDoc('# original')
      enterEdit()
      fireEvent.click(screen.getByText('type draft'))

      await openExportMenu()
      expect(await screen.findByText('You have unsaved writing. Which version?')).toBeTruthy()
      expect(exportWorkspaceDocument).not.toHaveBeenCalled()
      fireEvent.click(screen.getByText('Save, then export'))
      await waitFor(() => expect(api.writeTextFile).toHaveBeenCalled())
      expect(await screen.findByText('Exported · note.docx')).toBeTruthy()
      // The editor stays open across the chained save.
      expect(screen.getByText('editor save')).toBeTruthy()
    })

    it('exports the saved version with the revision that was shown when the choice appeared', async () => {
      bridge()
      exportWorkspaceDocument.mockResolvedValue({
        byteSize: 1,
        displayName: 'note.docx',
        exportRef: 'ref-4',
        format: 'docx',
        workspaceRelativePath: 'docs/note.docx'
      })
      render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)
      await findDoc('# original')
      enterEdit()
      fireEvent.click(screen.getByText('type draft'))

      await openExportMenu()
      fireEvent.click(await screen.findByText('Export the saved version'))
      await waitFor(() => expect(exportWorkspaceDocument).toHaveBeenCalledWith('opaque-one', 'docx', 'r1'))
      expect(await screen.findByText('Exported · note.docx')).toBeTruthy()
    })

    it('retries a failed saved-version export with the same pinned revision', async () => {
      bridge()
      exportWorkspaceDocument.mockRejectedValueOnce(new Error('EXPORT_PUBLISH_FAILED')).mockResolvedValueOnce({
        byteSize: 1,
        displayName: 'note.docx',
        exportRef: 'ref-6',
        format: 'docx',
        workspaceRelativePath: 'docs/note.docx'
      })
      render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)
      await findDoc('# original')
      enterEdit()
      fireEvent.click(screen.getByText('type draft'))

      await openExportMenu()
      fireEvent.click(await screen.findByText('Export the saved version'))
      await screen.findByText('Could not export: the file could not be written')
      fireEvent.click(screen.getByText('Try again'))
      await waitFor(() => expect(exportWorkspaceDocument).toHaveBeenLastCalledWith('opaque-one', 'docx', 'r1'))
      expect(await screen.findByText('Exported · note.docx')).toBeTruthy()
    })

    it('disables save and the toolbar while an export is in flight', async () => {
      bridge()
      let finish!: (value: unknown) => void
      exportWorkspaceDocument.mockImplementation(() => new Promise(resolve => (finish = resolve)))
      render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)
      await findDoc('# original')

      await openExportMenu()
      expect(await screen.findByText('Exporting…')).toBeTruthy()
      enterEdit()
      expect((screen.getByText('Save').closest('button') as HTMLButtonElement).disabled).toBe(true)
      showWriteCommands()
      expect((screen.getByRole('button', { name: 'Bold' }) as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByText('editor save')).toBeTruthy()
      finish({ byteSize: 1, displayName: 'note.docx', exportRef: 'ref-5', format: 'docx', workspaceRelativePath: 'x' })
      expect(await screen.findByText('Exported · note.docx')).toBeTruthy()
    })

    it('keeps a failed export recoverable with a localized reason and retry', async () => {
      bridge()
      exportWorkspaceDocument.mockRejectedValueOnce(new Error('EXPORT_SOURCE_CHANGED')).mockResolvedValueOnce({
        byteSize: 1,
        displayName: 'note.docx',
        exportRef: 'ref-3',
        format: 'docx',
        workspaceRelativePath: 'docs/note.docx'
      })
      render(<WorkspaceTextFilePane scopeKey="atum-chat:chat-a" tab={tab()} />)
      await findDoc('# original')

      await openExportMenu()
      expect(await screen.findByText('Could not export: the document just changed, try again')).toBeTruthy()
      fireEvent.click(screen.getByText('Try again'))
      expect(await screen.findByText('Exported · note.docx')).toBeTruthy()
      expect(exportWorkspaceDocument).toHaveBeenCalledTimes(2)
    })
  })
})

it('resolves the document theme for the canvas once per lease and survives a bridge without it', async () => {
  const { api } = bridge()
  render(<WorkspaceTextFilePane tab={tab()} />)
  await findDoc('# original')

  await waitFor(() => expect(api.documentTheme).toHaveBeenCalledWith({ fileRef: 'opaque-one' }))
  expect(api.documentTheme).toHaveBeenCalledTimes(1)
})

it('renders with the default theme when the bridge cannot resolve one', async () => {
  const { api } = bridge()
  api.documentTheme.mockRejectedValueOnce(new Error('CAPABILITY_REVOKED'))
  render(<WorkspaceTextFilePane tab={tab()} />)

  await findDoc('# original')
  await waitFor(() => expect(api.documentTheme).toHaveBeenCalled())
  // Still editing, still rendering: the canvas never blocks on the theme.
  expect(screen.queryByTestId('editor-buffer')).toBeTruthy()
})

describe('document search keyboard ownership', () => {
  it('opens local Find with Cmd+F, refocuses it, and preserves explicit Source mode', async () => {
    bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Export' }), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Source (advanced)' }))
    showViewControls()
    expect(writeModeControl().getAttribute('aria-pressed')).toBe('false')

    const editor = screen.getByTestId('editor-buffer')
    expect(fireEvent.keyDown(editor, { key: 'f', code: 'KeyF', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(editor, { key: 'f', code: 'KeyF', metaKey: true, shiftKey: true })).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    expect(fireEvent.keyDown(editor, { key: 'ф', code: 'KeyF', metaKey: true })).toBe(false)
    const find = screen.getByRole('textbox', { name: 'Find' })
    expect(globalThis.document.activeElement).toBe(find)
    fireEvent.change(find, { target: { value: 'original' } })
    editor.focus()
    fireEvent.keyDown(editor, { key: 'f', code: 'KeyF', metaKey: true })
    expect(globalThis.document.activeElement).toBe(find)
    expect((find as HTMLInputElement).value).toBe('original')
    expect(writeModeControl().getAttribute('aria-pressed')).toBe('false')

    fireEvent.keyDown(find, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    expect(docText()).toBe('# original')
  })

  it('does not open navigation during text composition', async () => {
    bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    fireEvent.click(screen.getByText('composition start'))
    fireEvent.keyDown(screen.getByTestId('editor-buffer'), { key: 'f', code: 'KeyF', metaKey: true })
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    fireEvent.click(screen.getByText('composition end'))
    fireEvent.keyDown(screen.getByTestId('editor-buffer'), { key: 'f', code: 'KeyF', metaKey: true })
    expect(screen.getByRole('textbox', { name: 'Find' })).toBeTruthy()
  })

  it('closes editing navigation in Read and reopens it on the visible writing projection', async () => {
    bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    fireEvent.keyDown(screen.getByTestId('editor-buffer'), { key: 'f', code: 'KeyF', metaKey: true })
    expect(screen.getByRole('textbox', { name: 'Find' })).toBeTruthy()
    showViewControls()
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Read' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Find and replace' }))
    expect(writeModeControl().getAttribute('aria-pressed')).toBe('true')
    expect(globalThis.document.activeElement).toBe(screen.getByRole('textbox', { name: 'Find' }))
    expect(docText()).toBe('# original')
  })

  it('reopens an editor before navigating after a manual save', async () => {
    bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    fireEvent.change(screen.getByTestId('editor-buffer'), { target: { value: '# Saved heading' } })
    fireEvent.keyDown(screen.getByTestId('editor-buffer'), { key: 'f', code: 'KeyF', metaKey: true })
    expect(screen.getByRole('textbox', { name: 'Find' })).toBeTruthy()
    fireEvent.click(screen.getByText('editor save'))
    await waitFor(() => expect(screen.queryByTestId('editor-buffer')).toBeNull())
    expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull()
    showViewControls()
    fireEvent.click(screen.getByRole('button', { name: 'Outline' }))
    expect(screen.getByTestId('editor-buffer')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Saved heading' })).toBeTruthy()
    expect(docText()).toBe('# Saved heading')
  })
})

describe('theme picker', () => {
  const openPicker = async () => {
    showPageControls()
    const trigger = await screen.findByRole('button', { name: 'Look' })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  }

  it('applies a chosen look through the owner-bound write and restyles from the returned snapshot', async () => {
    const { api } = bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(api.documentTheme).toHaveBeenCalled())

    await openPicker()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Modern' }))

    await waitFor(() =>
      expect(api.documentThemeSet).toHaveBeenCalledWith({ fileRef: 'opaque-one', selection: { themeId: 'modern' } })
    )
    // No refetch: the setter's snapshot is the new committed theme.
    expect(api.documentTheme).toHaveBeenCalledTimes(1)
  })

  it('carries page size and text size as bounded overrides, and reset clears the choice', async () => {
    const { api } = bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(api.documentTheme).toHaveBeenCalled())

    await openPicker()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Letter' }))
    await waitFor(() => expect(api.documentThemeSet).toHaveBeenCalledTimes(1))
    const [first] = api.documentThemeSet.mock.calls[0]! as [{ selection: unknown }]
    expect(first.selection).toEqual({ overrides: { pageSize: 'letter' }, themeId: 'book' })

    await openPicker()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset to default' }))
    await waitFor(() => expect(api.documentThemeSet).toHaveBeenCalledWith({ fileRef: 'opaque-one', selection: null }))
  })

  it('tells the person when a look applied but could not be saved', async () => {
    const { api } = bridge()
    api.documentThemeSet.mockResolvedValueOnce({
      persisted: false,
      theme: resolveDocumentTheme({ themeId: 'note' }, 3)
    })
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(api.documentTheme).toHaveBeenCalled())

    await openPicker()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Note' }))

    await waitFor(() =>
      expect(screen.getAllByRole('status').some(status => status.textContent?.includes('could not be saved'))).toBe(
        true
      )
    )
  })
})

describe('theme picker preview', () => {
  it('previews a hovered look through the canvas compartment alone, and drops it when the menu closes', async () => {
    const { api } = bridge()
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(api.documentTheme).toHaveBeenCalled())
    const before = canvasDispatches.length

    showPageControls()
    const trigger = await screen.findByRole('button', { name: 'Look' })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerMove(await screen.findByRole('menuitemradio', { name: 'Note' }))
    await waitFor(() => expect(canvasDispatches.length).toBeGreaterThan(before))
    const previewed = canvasDispatches.length

    fireEvent.keyDown(globalThis.document.activeElement ?? globalThis.document.body, { key: 'Escape' })
    // Closing without choosing restores the committed look: one more reconfigure, no write.
    await waitFor(() => expect(canvasDispatches.length).toBeGreaterThan(previewed))
    expect(api.documentThemeSet).not.toHaveBeenCalled()
  })

  it('keeps a stored custom text size when only the page size changes', async () => {
    const { api } = bridge()
    api.documentTheme.mockResolvedValueOnce({
      ...resolveDocumentTheme({ overrides: { bodySizePt: 12 }, themeId: 'modern' }, 4),
      headingSizesPt: [19.5, 17, 14.5, 13, 12, 11]
    })
    render(<WorkspaceTextFilePane tab={tab()} />)
    await findDoc('# original')
    await waitFor(() => expect(api.documentTheme).toHaveBeenCalled())

    showPageControls()
    const trigger = await screen.findByRole('button', { name: 'Look' })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Letter' }))

    await waitFor(() =>
      expect(api.documentThemeSet).toHaveBeenCalledWith({
        fileRef: 'opaque-one',
        selection: { overrides: { bodySizePt: 12, pageSize: 'letter' }, themeId: 'modern' }
      })
    )
  })
})
