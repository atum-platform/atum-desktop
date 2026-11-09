import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { $actionPanelOwner } from '@/store/action-panel-owner'
import { $contextPickerOpen, resetConversationContextLinksForTests } from '@/store/conversation-context-links'
import { $workbenchTabs, assistantChatWorkbenchScopeKey, resetWorkbenchTabs, setWorkbenchScope } from '@/store/workbench-tabs'

const actions = vi.hoisted(() => ({
  beginOtherAppsLink: vi.fn(() => true),
  cancelOtherAppsLink: vi.fn(),
  closeContextPicker: vi.fn(),
  linkPanelDocument: vi.fn(async () => true),
  linkSavedDocument: vi.fn(async () => true),
  linkWordDocument: vi.fn(async () => true),
  openContextPicker: vi.fn(),
  reconnectContextLink: vi.fn(async () => true),
  showLinkedDocument: vi.fn(async () => true),
  useAutomaticContext: vi.fn(() => true)
}))

vi.mock('@/store/context-link-actions', () => actions)

import { ContextLinkComposerAction, ContextLinkPicker } from './context-link-picker'

const owner = {
  accountId: 'account',
  agent_id: '00000000-0000-4000-8000-11e594f48195',
  backend_id: '00000000-0000-4000-8000-e79acd97ac88',
  connectionId: 'connection',
  profile: 'default',
  submission_dedup: true,
  version: 1 as const
}

async function renderPicker() {
  await act(async () => {
    render(
      <I18nProvider configClient={{ getConfig: async () => ({}), saveConfig: async () => ({ ok: true }) }}>
        <ContextLinkPicker />
      </I18nProvider>
    )
  })
}

describe('ContextLinkPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetConversationContextLinksForTests()
    resetWorkbenchTabs()
    $actionPanelOwner.set(owner)
    setWorkbenchScope(assistantChatWorkbenchScopeKey('conversation', owner))
    vi.stubGlobal('ResizeObserver', class {
      disconnect() {}
      observe() {}
      unobserve() {}
    })
    vi.stubGlobal('hermesDesktop', {
      actionPanelOwner: true,
      nativeApps: { listOpenDocumentWindows: vi.fn(async () => ({ windows: [] })) },
      wordCompanion: { listDocuments: vi.fn(async () => ({ documents: [] })) }
    })
  })

  afterEach(() => {
    cleanup()
    resetConversationContextLinksForTests()
    resetWorkbenchTabs()
    $actionPanelOwner.set(null)
    vi.unstubAllGlobals()
  })

  it('enables the composer action when owner readiness arrives after mount', async () => {
    $actionPanelOwner.set(null)
    render(<I18nProvider configClient={null} initialLocale="en"><ContextLinkComposerAction /></I18nProvider>)
    expect(screen.getByRole('button', { name: 'Work with…' }).hasAttribute('disabled')).toBe(true)
    act(() => { $actionPanelOwner.set(owner) })
    expect(screen.getByRole('button', { name: 'Work with…' }).hasAttribute('disabled')).toBe(false)
  })

  it('lists a readable panel document immediately and links it with the default presentation', async () => {
    const scopeKey = assistantChatWorkbenchScopeKey('conversation', owner)

    const tab = {
      id: 'preview:proposal',
      restore: 'session' as const,
      scopeKey,
      surface: {
        kind: 'preview' as const,
        target: {
          contextFile: { token: 'read-token' },
          kind: 'file' as const,
          label: 'proposal.md',
          source: '/work/proposal.md',
          url: 'file:///work/proposal.md'
        }
      },
      title: 'proposal.md',
      viewKey: 'preview-view'
    }

    $workbenchTabs.set([tab])
    $contextPickerOpen.set(true)

    await renderPicker()

    await waitFor(() => expect(screen.getByText('proposal.md')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /proposal\.md/i }))

    await waitFor(() => expect(actions.linkPanelDocument).toHaveBeenCalledWith(tab, { show: true }))
  })

  it('uses the no-prompt Word inventory and keeps Link only separate from the default', async () => {
    vi.stubGlobal('hermesDesktop', {
      actionPanelOwner: true,
      nativeApps: { listOpenDocumentWindows: vi.fn(async () => ({ windows: [] })) },
      wordCompanion: { listDocuments: vi.fn(async () => ({ documents: [{ id: 'word-window', name: 'report.docx', path: '/work/report.docx' }] })) }
    })
    $contextPickerOpen.set(true)

    await renderPicker()

    await waitFor(() => expect(screen.getByText('report.docx')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /report\.docx/i }))
    await waitFor(() => expect(actions.linkWordDocument).toHaveBeenCalledWith({ candidateId: 'word-window' }, { show: true }))

    actions.linkWordDocument.mockClear()
    fireEvent.click(globalThis.document.querySelector('[data-context-link-only="word:word-window"]')!)
    await waitFor(() => expect(actions.linkWordDocument).toHaveBeenCalledWith({ candidateId: 'word-window' }, { show: false }))
  })

  it('does not link a late Office chooser result into a different conversation', async () => {
    let resolve!: (path: string) => void
    vi.stubGlobal('hermesDesktop', {
      actionPanelOwner: true,
      nativeApps: {
        listOpenDocumentWindows: vi.fn(async () => ({ windows: [{ id: 'excel-a', app: { id: 'excel', bundleId: 'com.microsoft.Excel', name: 'Excel' }, title: 'Forecast.xlsx', hasSavedFile: true }] })),
        resolveOpenDocumentWindow: vi.fn(() => new Promise<string>(done => { resolve = done }))
      },
      wordCompanion: { listDocuments: vi.fn(async () => ({ documents: [] })) }
    })
    $contextPickerOpen.set(true)
    await renderPicker()
    fireEvent.click(await screen.findByRole('button', { name: /Forecast.xlsx/ }))
    act(() => {setWorkbenchScope(assistantChatWorkbenchScopeKey('different-conversation', owner))})
    await act(async () => {resolve('/work/Forecast.xlsx')})
    expect(actions.linkSavedDocument).not.toHaveBeenCalled()
  })

  it('hands Other apps to the Skills launcher as a one-shot link intent', async () => {
    $contextPickerOpen.set(true)
    await renderPicker()

    fireEvent.click(globalThis.document.querySelector('[data-context-link-other-apps]')!)

    expect(actions.beginOtherAppsLink).toHaveBeenCalledWith(true)
  })
})
