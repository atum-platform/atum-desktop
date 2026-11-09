import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/chat/composer/focus', () => ({ requestComposerFocus: vi.fn() }))

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { I18nProvider } from '@/i18n'
import { workspaceTextFileLeaseFromDescriptor } from '@/lib/workspace-text-file-lease'
import { $workspaceTextFileTabs } from '@/store/workspace-text-files'

import { AssistantTextResultSection, useAssistantTextResult } from './assistant-text-result'

type FilesystemCapability = NonNullable<NonNullable<Window['hermesDesktop']>['filesystemCapability']>
type EventCallback = Parameters<FilesystemCapability['onAssistantTextResult']>[0]

let publish: EventCallback = () => undefined

function bridge(text = 'exact bytes written by Hermes') {
  return {
    onAssistantTextResult: vi.fn((callback: EventCallback) => {
      publish = callback

      return () => undefined
    }),
    readTextFile: vi.fn(async () => ({ revision: 'r1', text, truncated: false })),
    writeTextFile: vi.fn(),
    preserveTextFileSibling: vi.fn(),
    watchTextFile: vi.fn(() => () => undefined),
    releaseTextFile: vi.fn(async () => undefined)
  }
}

interface HarnessProps {
  busy?: boolean
  onRetry?: () => Promise<void>
  sessionId?: string
}

function Harness({ busy = false, onRetry = async () => undefined, sessionId = 'session-1' }: HarnessProps) {
  const state = useAssistantTextResult(sessionId)

  return state.event ? (
    <AssistantTextResultSection busy={busy} event={state.event} onDismiss={state.dismiss} onRetry={onRetry} />
  ) : null
}

function renderHarness(props: HarnessProps = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <Harness {...props} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  $workspaceTextFileTabs.set([])
  publish = () => undefined
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('AssistantTextResultSection', () => {
  it('makes a main-owned successful write the visible Saved outcome with bounded next actions', async () => {
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability: bridge('R1_ARTIFACT_CREATED\nR1_ARTIFACT_EDITED\n') } }))
    renderHarness({ busy: true })

    publish({
      sessionId: 'session-1',
      toolCallId: 'main-approved-write',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'opaque-main-result', displayName: 'r1-acceptance-note.txt' }
      }
    })

    expect(await screen.findByText('Saved r1-acceptance-note.txt')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
    expect(screen.queryByText(/refused|denied/u)).toBeNull()
  })

  it('opens the exact main-owned descriptor on the canonical S4 file surface', async () => {
    const filesystemCapability = bridge()
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability } }))
    renderHarness()

    publish({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'opaque-file-ref', displayName: 'answer.md' }
      }
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))

    const tab = $workspaceTextFileTabs.get()[0]
    expect(tab.target.workspaceTextFile).toEqual({ fileRef: 'opaque-file-ref', displayName: 'answer.md' })
    await expect(workspaceTextFileLeaseFromDescriptor(tab.target.workspaceTextFile).read()).resolves.toEqual({
      revision: 'r1',
      text: 'exact bytes written by Hermes',
      truncated: false
    })
    expect(filesystemCapability.releaseTextFile).not.toHaveBeenCalled()
    expect(screen.queryByText('Saved answer.md')).toBeNull()
  })

  it('offers Continue without starting a second turn', async () => {
    const filesystemCapability = bridge()
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability } }))
    const onRetry = vi.fn(async () => undefined)
    renderHarness({ onRetry })

    publish({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'opaque-file-ref', displayName: 'answer.txt' }
      }
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(onRetry).not.toHaveBeenCalled()
    expect(filesystemCapability.releaseTextFile).toHaveBeenCalledOnce()
    expect(filesystemCapability.releaseTextFile).toHaveBeenCalledWith('opaque-file-ref')
    expect(requestComposerFocus).toHaveBeenCalledWith('active')
  })

  it('keeps two concurrent results ordered and releases only an abandoned success', async () => {
    const filesystemCapability = bridge()
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability } }))
    renderHarness()

    publish({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'first-ref', displayName: 'first.md' }
      }
    })
    publish({
      sessionId: 'session-1',
      toolCallId: 'call-2',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'failure',
        code: 'conflict',
        retryable: true,
        rendererMessage: 'closed provider copy'
      }
    })

    expect(await screen.findByText('Saved first.md')).toBeTruthy()
    expect(screen.queryByText('The file changed before the write completed.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('The file changed before the write completed.')).toBeTruthy()
    expect(filesystemCapability.releaseTextFile).toHaveBeenCalledOnce()
    expect(filesystemCapability.releaseTextFile).toHaveBeenCalledWith('first-ref')
  })

  it('dismisses a terminal head result before revealing the next queued success', async () => {
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability: bridge() } }))
    renderHarness()

    publish({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'failure',
        code: 'scope_escape',
        retryable: false,
        rendererMessage: 'closed provider copy'
      }
    })
    publish({
      sessionId: 'session-1',
      toolCallId: 'call-2',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'second-ref', displayName: 'second.txt' }
      }
    })

    expect(await screen.findByText('That file is outside the allowed workspace.')).toBeTruthy()
    expect(screen.queryByText('Saved second.txt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(await screen.findByText('Saved second.txt')).toBeTruthy()
  })

  it('releases queued success leases and never paints the previous session after a session change', async () => {
    const filesystemCapability = bridge()
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability } }))
    const view = renderHarness()

    publish({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'stale-ref', displayName: 'stale.md' }
      }
    })
    publish({
      sessionId: 'session-1',
      toolCallId: 'call-2',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'queued-ref', displayName: 'queued.md' }
      }
    })
    expect(await screen.findByText('Saved stale.md')).toBeTruthy()

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <Harness sessionId="session-2" />
      </I18nProvider>
    )

    expect(screen.queryByText('Saved stale.md')).toBeNull()
    expect(screen.queryByText('Saved queued.md')).toBeNull()
    await waitFor(() => {
      expect(filesystemCapability.releaseTextFile).toHaveBeenCalledWith('stale-ref')
      expect(filesystemCapability.releaseTextFile).toHaveBeenCalledWith('queued-ref')
    })

    publish({
      sessionId: 'session-2',
      toolCallId: 'call-3',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'failure',
        code: 'io_failed',
        retryable: true,
        rendererMessage: 'closed provider copy'
      }
    })
    expect(await screen.findByText('The file could not be prepared. Try again.')).toBeTruthy()
  })

  it('renders closed failure copy, bounded detail, and a single retry', async () => {
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability: bridge() } }))
    let finishRetry: (() => void) | undefined
    const onRetry = vi.fn(() => new Promise<void>(resolve => (finishRetry = resolve)))
    renderHarness({ onRetry })

    publish({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'failure',
        code: 'permission_expired',
        retryable: true,
        rendererMessage: '<script>provider copy must not render</script>',
        incidentRef: '0123456789abcdefabcd'
      }
    })

    expect(await screen.findByText('The file permission expired. Try again.')).toBeTruthy()
    expect(screen.queryByText(/provider copy/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Reason: permission_expired')).toBeTruthy()
    expect(screen.getByText('Reference: 0123456789abcdefabcd')).toBeTruthy()

    const retry = screen.getByRole('button', { name: 'Retry' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledOnce()
    finishRetry?.()
    await waitFor(() => expect(screen.queryByText('The file permission expired. Try again.')).toBeNull())
  })

  it('does not dismiss a new session head when an older pending retry resolves', async () => {
    const filesystemCapability = bridge()
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability } }))
    let finishRetry: (() => void) | undefined
    const onRetry = vi.fn(() => new Promise<void>(resolve => (finishRetry = resolve)))
    const view = renderHarness({ onRetry, sessionId: 'session-1' })

    publish({
      sessionId: 'session-1',
      toolCallId: 'old-call',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'failure',
        code: 'io_failed',
        retryable: true,
        rendererMessage: 'closed provider copy'
      }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <Harness onRetry={onRetry} sessionId="session-2" />
      </I18nProvider>
    )
    publish({
      sessionId: 'session-2',
      toolCallId: 'new-call',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'success',
        descriptor: { fileRef: 'new-ref', displayName: 'new.md' }
      }
    })
    expect(await screen.findByText('Saved new.md')).toBeTruthy()

    finishRetry?.()

    await waitFor(() => expect(requestComposerFocus).toHaveBeenCalledWith('active'))
    expect(screen.getByText('Saved new.md')).toBeTruthy()
    expect(filesystemCapability.releaseTextFile).not.toHaveBeenCalledWith('new-ref')
  })

  it('does not offer retry for terminal failures and ignores other sessions', async () => {
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability: bridge() } }))
    renderHarness()

    publish({
      sessionId: 'other-session',
      toolCallId: 'call-1',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'failure',
        code: 'too_large',
        retryable: false,
        rendererMessage: 'ignored'
      }
    })
    expect(screen.queryByText('This text file is too large to open here.')).toBeNull()

    publish({
      sessionId: 'session-1',
      toolCallId: 'call-2',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'failure',
        code: 'too_large',
        retryable: false,
        rendererMessage: 'terminal'
      }
    })
    expect(await screen.findByText('This text file is too large to open here.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it.each([
    ['permission_required', true, 'Allow this file write, then try again.'],
    ['permission_denied', true, 'The file write was not allowed.'],
    ['permission_expired', true, 'The file permission expired. Try again.'],
    ['account_stale', true, 'The account changed before the file was ready. Try again.'],
    ['scope_escape', false, 'That file is outside the allowed workspace.'],
    ['conflict', true, 'The file changed before the write completed.'],
    ['too_large', false, 'This text file is too large to open here.'],
    ['io_failed', true, 'The file could not be prepared. Try again.']
  ] as const)('shows truthful closed copy and recovery for %s', async (code, retryable, message) => {
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { filesystemCapability: bridge() } }))
    renderHarness()

    publish({
      sessionId: 'session-1',
      toolCallId: 'call-1',
      result: {
        version: 1,
        kind: 'workspace_text_file',
        outcome: 'failure',
        code,
        retryable,
        rendererMessage: 'not rendered'
      }
    })

    expect(await screen.findByText(message)).toBeTruthy()
    expect(Boolean(screen.queryByRole('button', { name: 'Retry' }))).toBe(retryable)
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy()
  })
})
