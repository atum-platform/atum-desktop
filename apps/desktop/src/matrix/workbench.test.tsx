import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixDocumentPreview, MatrixSnapshot } from '../../shared/matrix'

import { matrixAppCopy } from './app-copy'
import {
  type MatrixDrivePreviewRequest,
  MatrixWorkbench,
  matrixWorkbenchCrowdsRoster,
  matrixWorkbenchScope
} from './workbench'
import { matrixWorkbenchCopy } from './workbench-copy'

/** Atum's own apps and the Store wait behind the new tab's "More" tile. */
function openMoreApps(label = 'More apps') {
  fireEvent.click(screen.getByRole('button', { name: label }))

  return screen.getByRole('dialog', { name: label })
}

const state: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@alice:test', deviceId: 'A' },
  roomId: '!one:test',
  rooms: [],
  messages: [],
  error: null,
  linkedDocument: { name: 'notes.txt', revision: 'one', state: 'linked' }
}

const close = vi.fn(async () => {})
const command = vi.fn(async () => {})
const documentPicker = vi.fn(async () => {})
const browserPrepare = vi.fn(async ({ url }: { url: string }) => ({ url }))
const browserRelease = vi.fn(async () => ({ ok: true }))
const openLink = vi.fn(async () => {})

const preview = vi.fn(
  async (): Promise<MatrixDocumentPreview> => ({
    token: 'view1',
    kind: 'text',
    name: 'notes.txt',
    text: 'saved-not-unsaved'
  })
)

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  preview.mockResolvedValue({ token: 'view1', kind: 'text', name: 'notes.txt', text: 'saved-not-unsaved' })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.assign(window, {
    atumMatrix: { command, previewDocument: preview, closeDocumentPreview: close, document: documentPicker, openLink }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function frame(
  snapshot = state,
  hidden = false,
  compact = false,
  obstructed = false,
  onClose = () => {},
  props: Pick<
    ComponentProps<typeof MatrixWorkbench>,
    | 'documentRequest'
    | 'onTabCountChange'
    | 'browserRequest'
    | 'driveRequest'
    | 'onDriveRequestClose'
    | 'onAskDrivePreview'
    | 'onOpenDrive'
  > = {},
  locale: Locale = 'en'
) {
  return (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixWorkbench
        compact={compact}
        expanded={false}
        hidden={hidden}
        motion={{ phase: 'open', rendered: true, finishExit() {} }}
        obstructed={obstructed}
        onClose={onClose}
        onExpand={() => {}}
        onPercentChange={() => {}}
        percent={50}
        snapshot={snapshot}
        windowControls={null}
        {...props}
      />
    </I18nProvider>
  )
}

it('leases an opaque Drive preview, routes Ask to the active chat, and opens through the Drive opener', async () => {
  const snapshot = { ...state, linkedDocument: null }
  const request: MatrixDrivePreviewRequest = {
    id: 'opaque-drive-row',
    name: 'notes.txt',
    kind: 'file',
    size: 18,
    modifiedAt: Date.now(),
    scope: matrixWorkbenchScope(snapshot),
    serial: 1
  }
  const drivePreview = vi.fn(async () => ({
    token: 'opaque-preview-token',
    name: 'notes.txt',
    kind: 'text' as const,
    text: 'Drive preview body',
    size: 18,
    modifiedAt: request.modifiedAt
  }))
  const closePreview = vi.fn(async () => {})
  const open = vi.fn(async () => {})
  let destination = 'drive'
  const ask = vi.fn(() => {
    destination = 'chat'
  })
  Object.assign(window.atumMatrix, { drive: { preview: drivePreview, closePreview, open } })

  const view = render(frame(snapshot, false, false, false, () => {}, { driveRequest: request, onAskDrivePreview: ask }))
  await screen.findByText('Drive preview body')
  expect(drivePreview).toHaveBeenCalledWith('opaque-drive-row')
  expect(JSON.stringify(drivePreview.mock.results[0])).not.toContain('/Users/')

  fireEvent.click(screen.getByRole('button', { name: 'Ask Atum about this' }))
  expect(ask).toHaveBeenCalledWith(request)
  expect(destination).toBe('chat')

  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith('opaque-drive-row'))
  view.unmount()
  await waitFor(() => expect(closePreview).toHaveBeenCalledWith('opaque-preview-token'))
})

it('keeps the linked document tab while a new-tab launcher is active and reports only real tabs', async () => {
  const count = vi.fn()
  render(frame(state, false, false, false, () => {}, { onTabCountChange: count }))
  await screen.findByText('saved-not-unsaved')
  expect(count).toHaveBeenLastCalledWith(1)

  fireEvent.click(screen.getByRole('button', { name: 'Open a new workspace tab' }))
  expect(window.document.querySelector('[data-matrix-workbench-launcher]')).toBeTruthy()
  expect(screen.getByRole('tab', { name: /notes\.txt/ })).toBeTruthy()
  expect(count).toHaveBeenLastCalledWith(1)
  expect(preview).toHaveBeenCalledTimes(1)

  fireEvent.keyDown(screen.getByRole('tablist'), { key: 't', metaKey: true })
  expect(count).toHaveBeenLastCalledWith(1)

  fireEvent.click(screen.getByRole('tab', { name: /notes\.txt/ }))
  await screen.findByText('saved-not-unsaved')
  fireEvent.click(screen.getByRole('button', { name: 'Close workspace: notes.txt' }))
  await waitFor(() => expect(count).toHaveBeenLastCalledWith(0))
})

it('uses the scoped document picker and matrix app commands from the launcher', async () => {
  const app: AppDescriptor = {
    app: 'moon',
    app_id: '00000000-0000-4000-8000-bd7662a5eeb4',
    app_version_id: '00000000-0000-4000-8000-b454f82c5857',
    name: { en: 'Moon' },
    subtitle: null,
    description: null,
    icon: null,
    accent: null,
    affiliation: null,
    verified: true,
    availability: 'available' as const,
    roster_default: true,
    roster_order: 0,
    supported_modes: ['direct'],
    matrix_room_context: null,
    has_surface: true,
    link: { mode: 'none' as const, state: 'never_linked' as const }
  }

  const noDocument = { ...state, linkedDocument: null, apps: { state: 'ready' as const, apps: [app], connections: {} } }

  render(frame(noDocument))
  expect(screen.getByRole('heading', { name: 'Tools' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open a file…' }))
  await waitFor(() => expect(documentPicker).toHaveBeenCalledWith('!one:test', 'choose'))
  // Atum's own apps are not tiles on the page; they wait behind "More" with the Store.
  expect(screen.queryByRole('button', { name: 'Moon' })).toBeNull()
  fireEvent.click(within(openMoreApps()).getByRole('button', { name: 'Moon' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'selectApp', appId: app.app_id }))
  fireEvent.click(within(openMoreApps()).getByRole('button', { name: 'Store' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'discoverApps' }))
})

it('offers Files, which opens Drive, only where Drive exists, and steps aside for it when compact', async () => {
  const onOpenDrive = vi.fn()
  const onClose = vi.fn()
  const view = render(frame({ ...state, linkedDocument: null }, false, false, false, onClose, { onOpenDrive }))
  fireEvent.click(screen.getByRole('button', { name: 'Files' }))
  expect(onOpenDrive).toHaveBeenCalledOnce()
  expect(onClose).not.toHaveBeenCalled()
  view.rerender(frame({ ...state, linkedDocument: null }, false, true, false, onClose, { onOpenDrive }))
  fireEvent.click(screen.getByRole('button', { name: 'Files' }))
  expect(onOpenDrive).toHaveBeenCalledTimes(2)
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  view.rerender(frame({ ...state, linkedDocument: null }))
  expect(screen.queryByRole('button', { name: 'Files' })).toBeNull()
})

it('closes an empty launcher panel, or returns to an existing document without closing it', async () => {
  const onClose = vi.fn()
  const view = render(frame({ ...state, linkedDocument: null }, false, false, false, onClose))
  fireEvent.click(screen.getByRole('button', { name: 'Close workspace: New tab' }))
  expect(onClose).toHaveBeenCalledTimes(1)
  view.unmount()

  render(frame(state, false, false, false, onClose))
  await screen.findByText('saved-not-unsaved')
  fireEvent.click(screen.getByRole('button', { name: 'Open a new workspace tab' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close workspace: New tab' }))
  expect(screen.getByRole('tab', { name: /notes\.txt/ }).getAttribute('aria-selected')).toBe('true')
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(close).not.toHaveBeenCalled()
})

it('honors an explicit linked-document request after the launcher is active', async () => {
  const view = render(frame())
  await screen.findByText('saved-not-unsaved')
  fireEvent.click(screen.getByRole('button', { name: 'Open a new workspace tab' }))
  expect(window.document.querySelector('[data-matrix-workbench-launcher]')).toBeTruthy()

  view.rerender(frame(state, false, false, false, () => {}, { documentRequest: 1 }))
  await screen.findByText('saved-not-unsaved')
})

it('opens real Matrix browser tabs from the launcher, counts them, and releases them on close or scope change', async () => {
  Object.assign(window, {
    atumMatrix: {
      command,
      previewDocument: preview,
      closeDocumentPreview: close,
      document: documentPicker,
      consumerBrowser: {
        onPopup: vi.fn(() => () => undefined),
        onNotice: vi.fn(() => () => undefined),
        prepare: browserPrepare,
        release: browserRelease
      }
    }
  })
  const count = vi.fn()
  const view = render(frame(state, false, false, false, () => {}, { onTabCountChange: count }))
  await screen.findByText('saved-not-unsaved')
  fireEvent.click(screen.getByRole('button', { name: 'Open a new workspace tab' }))
  const address = screen.getByRole('textbox', { name: 'Search or type a website' })

  fireEvent.change(address, { target: { value: 'https://example.com/one' } })
  fireEvent.submit(address.closest('form')!)
  // A new tab is named for its site before the page names itself, never "Browser" in every language.
  const browserTab = await screen.findByRole('tab', { name: 'example.com' })
  expect(browserPrepare).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/one' }))
  expect(count).toHaveBeenLastCalledWith(2)

  view.rerender(frame(state, true, false, false, () => {}, { onTabCountChange: count }))
  expect(browserRelease).not.toHaveBeenCalled()
  view.rerender(frame(state, false, false, false, () => {}, { onTabCountChange: count }))
  expect(browserTab).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Close workspace: example.com' }))
  await waitFor(() => expect(browserRelease).toHaveBeenCalledTimes(1))
  expect(count).toHaveBeenLastCalledWith(1)

  fireEvent.click(screen.getByRole('button', { name: 'Open a new workspace tab' }))
  const launcherAddress = screen.getByRole('textbox', { name: 'Search or type a website' })
  fireEvent.change(launcherAddress, { target: { value: 'https://example.com/two' } })
  fireEvent.submit(launcherAddress.closest('form')!)
  await screen.findByRole('tab', { name: 'example.com' })
  view.rerender(
    frame({ ...state, roomId: '!other:test', linkedDocument: null }, false, false, false, () => {}, {
      onTabCountChange: count
    })
  )
  await waitFor(() => expect(browserRelease).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('tab', { name: 'New tab' })).toBeTruthy()
  expect(count).toHaveBeenLastCalledWith(0)
})

it('records only successful browser navigations, persists a redacted recent, and uses the trusted opener', async () => {
  Object.assign(window.atumMatrix, {
    consumerBrowser: {
      onPopup: vi.fn(() => () => undefined),
      onNotice: vi.fn(() => () => undefined),
      prepare: browserPrepare,
      release: browserRelease
    }
  })
  const noDocument = { ...state, linkedDocument: null }
  const view = render(frame(noDocument))
  const address = screen.getByRole('textbox', { name: 'Search or type a website' })

  fireEvent.change(address, {
    target: { value: 'https://alice:secret@example.com/account/path?access_token=top-secret#profile' }
  })
  fireEvent.submit(address.closest('form')!)

  const browserTab = await screen.findByRole('tab', { name: 'example.com' })

  const webview = await waitFor(() => {
    const node = window.document.querySelector('webview') as HTMLElement & {
      getTitle?: () => string
      getURL?: () => string
    }

    expect(node).toBeTruthy()

    return node
  })

  const currentUrl = 'https://alice:secret@example.com/account/path?access_token=top-secret#profile'

  webview.getTitle = () => 'Example account'
  webview.getURL = () => currentUrl
  fireEvent(webview, new Event('did-start-loading'))
  fireEvent(webview, Object.assign(new Event('did-fail-load'), { errorCode: -105 }))
  fireEvent(webview, new Event('did-stop-loading'))
  fireEvent.click(screen.getByRole('button', { name: 'Open a new workspace tab' }))
  expect(screen.queryByText('Recent')).toBeNull()

  fireEvent.click(browserTab)
  fireEvent(webview, new Event('did-start-loading'))
  fireEvent(webview, new Event('did-stop-loading'))
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Example account' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))
  expect(openLink).toHaveBeenCalledExactlyOnceWith(currentUrl)

  fireEvent.click(screen.getByRole('button', { name: 'Open a new workspace tab' }))
  expect(await screen.findByText('Recent')).toBeTruthy()
  const recentGroup = screen.getByText('Recent').nextElementSibling as HTMLElement
  expect(within(recentGroup).getByText('Example account')).toBeTruthy()
  expect(window.localStorage.getItem('atum:matrix-workbench-recents:v1')).not.toMatch(
    /alice:secret@|top-secret|access_token|#profile/u
  )

  view.unmount()
  render(frame(noDocument))
  const recentTitle = screen.getByText('Example account')
  fireEvent.click(recentTitle.closest('button')!)
  await waitFor(() =>
    expect(browserPrepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'https://example.com/account/path' })
    )
  )
})

it('adds a document recent only after its preview opens successfully', async () => {
  preview.mockRejectedValueOnce(new Error('preview failed'))
  render(frame())

  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Open a new workspace tab' }))
  expect(screen.queryByText('Recent')).toBeNull()

  fireEvent.click(screen.getByRole('tab', { name: /notes\.txt/u }))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('saved-not-unsaved')
  fireEvent.click(screen.getByRole('button', { name: 'Open a new workspace tab' }))

  expect(await screen.findByText('Recent')).toBeTruthy()
  const recentGroup = screen.getByText('Recent').nextElementSibling as HTMLElement
  expect(within(recentGroup).getByRole('button', { name: /notes\.txt/u })).toBeTruthy()
})

it('opens an explicit preview once through the existing browser and rejects a foreign scope', async () => {
  Object.assign(window.atumMatrix, {
    consumerBrowser: {
      onPopup: vi.fn(() => () => undefined),
      onNotice: vi.fn(() => () => undefined),
      prepare: browserPrepare,
      release: browserRelease
    }
  })
  const count = vi.fn()
  const request = { id: 'preview-one', url: 'https://example.test/preview', scope: matrixWorkbenchScope(state) }
  const view = render(frame(state, false, false, false, () => {}, { onTabCountChange: count }))
  await screen.findByText('saved-not-unsaved')
  expect(browserPrepare).not.toHaveBeenCalled()
  view.rerender(frame(state, false, false, false, () => {}, { onTabCountChange: count, browserRequest: request }))
  await screen.findByRole('tab', { name: 'example.test' })
  expect(browserPrepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: request.url }))
  expect(count).toHaveBeenLastCalledWith(2)
  view.rerender(frame(state, false, false, false, () => {}, { onTabCountChange: count, browserRequest: { ...request } }))
  expect(browserPrepare).toHaveBeenCalledTimes(1)
  expect(count).toHaveBeenLastCalledWith(2)
  view.rerender(frame({ ...state, roomId: '!foreign:test', linkedDocument: null }, false, false, false, () => {}, {
    onTabCountChange: count, browserRequest: request
  }))
  await waitFor(() => expect(browserRelease).toHaveBeenCalledTimes(1))
  expect(browserPrepare).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('tab', { name: 'example.test' })).toBeNull()
  expect(count).toHaveBeenLastCalledWith(0)
})

it('hides without unlinking or re-reading; closing the last tab yields the launcher and can reopen the existing link', async () => {
  const view = render(frame())
  await screen.findByText('saved-not-unsaved')
  expect(window.document.querySelector('[data-atum-workspace-add]')).toBeTruthy()
  view.rerender(frame(state, true))
  expect(close).not.toHaveBeenCalled()
  view.rerender(frame())
  expect(preview).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Close workspace: notes.txt' }))
  await waitFor(() => expect(close).toHaveBeenCalledWith('view1'))
  expect(window.atumMatrix.document).not.toHaveBeenCalled()
  expect(window.document.querySelector('[data-matrix-workbench-launcher]')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Reopen closed document' }))
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(2))
  await screen.findByText('saved-not-unsaved')
})

it.each(['room', 'account', 'revision'] as const)('discards late saved bytes after changing %s', async mode => {
  let finish!: (value: MatrixDocumentPreview) => void
  preview.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const view = render(frame())

  const next = {
    ...state,
    ...(mode === 'room'
      ? { roomId: '!other:test' }
      : mode === 'account'
        ? { identity: { userId: '@bob:test', deviceId: 'B' } }
        : {}),
    linkedDocument: {
      name: 'notes.txt',
      revision: mode === 'revision' ? 'two' : 'one',
      state: 'reconnect_required' as const
    }
  }

  view.rerender(frame(next))
  await act(async () => finish({ token: 'late', name: 'notes.txt', kind: 'text', text: 'OLD SECRET' }))
  expect(screen.queryByText('OLD SECRET')).toBeNull()
  expect(close).toHaveBeenCalledWith('late')
})

it('refresh reads saved bytes again and unavailable grants never render the old snapshot', async () => {
  const view = render(frame())
  await screen.findByText('saved-not-unsaved')
  preview.mockResolvedValue({ token: 'view2', kind: 'text', name: 'notes.txt', text: 'new-saved-content' })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('new-saved-content')
  expect(close).toHaveBeenCalledWith('view1')
  view.rerender(frame({ ...state, linkedDocument: { ...state.linkedDocument!, state: 'reconnect_required' } }))
  expect(screen.queryByText('new-saved-content')).toBeNull()
  expect(close).toHaveBeenCalledWith('view2')
})

it.each(['account', 'device'] as const)('retires a ready preview when the %s changes in the same room', async mode => {
  const view = render(frame())
  await screen.findByText('saved-not-unsaved')
  preview.mockResolvedValue({ token: 'view2', kind: 'text', name: 'notes.txt', text: 'current-scope-content' })

  view.rerender(frame({
    ...state,
    identity: { userId: mode === 'account' ? '@bob:test' : '@alice:test', deviceId: mode === 'account' ? 'A' : 'B' }
  }))

  await screen.findByText('current-scope-content')
  expect(screen.queryByText('saved-not-unsaved')).toBeNull()
  expect(close).toHaveBeenCalledWith('view1')
  expect(preview).toHaveBeenCalledTimes(2)
})

it.each(['account', 'device'] as const)('discards a late preview after a ready-linked %s change', async mode => {
  let finish!: (value: MatrixDocumentPreview) => void
  preview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(frame())
  preview.mockResolvedValue({ token: 'view2', kind: 'text', name: 'notes.txt', text: 'current-scope-content' })

  view.rerender(frame({
    ...state,
    identity: { userId: mode === 'account' ? '@bob:test' : '@alice:test', deviceId: mode === 'account' ? 'A' : 'B' }
  }))
  await screen.findByText('current-scope-content')
  await act(async () => finish({ token: 'late', kind: 'text', name: 'notes.txt', text: 'OLD SECRET' }))

  expect(screen.queryByText('OLD SECRET')).toBeNull()
  expect(screen.getByText('current-scope-content')).toBeTruthy()
  expect(close).toHaveBeenCalledWith('late')
})

it('offers a retry after a document preview fails, without changing the linked document', async () => {
  preview.mockRejectedValueOnce(new Error('preview failed'))
  render(frame())

  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('saved-not-unsaved')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(preview).toHaveBeenCalledTimes(2)
  expect(documentPicker).not.toHaveBeenCalled()
})

it.each(['unavailable', 'loading', 'absent'] as const)('reports the launcher catalog %s state honestly', async catalogState => {
  render(frame({
    ...state,
    linkedDocument: null,
    ...(catalogState === 'absent' ? {} : { apps: { state: catalogState, apps: [], connections: {} } })
  }))
  openMoreApps()

  if (catalogState === 'loading') {
    expect(screen.getByRole('status', { name: 'Loading apps…' })).toBeTruthy()
  } else {
    expect(screen.getByRole('status').textContent).toContain('Apps are unavailable right now')
    expect(screen.queryByText('Loading apps…')).toBeNull()
  }
})

it('shows a ready-empty app catalog without claiming a failed search or a pending read', () => {
  render(frame({ ...state, linkedDocument: null, apps: { state: 'ready', apps: [], connections: {} } }))
  openMoreApps()
  expect(screen.getByText('No apps are available for this account.')).toBeTruthy()
  expect(screen.queryByText('No apps match your search.')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('localizes the unavailable catalog recovery state in %s', locale => {
  render(frame(
    { ...state, linkedDocument: null, apps: { state: 'unavailable', apps: [], connections: {} } },
    false, false, false, () => {}, {}, locale
  ))
  openMoreApps(matrixWorkbenchCopy(locale).moreAppsLabel)
  expect(screen.getByRole('status').textContent).toBe(matrixAppCopy[locale].catalogUnavailable)
})

it('reopens the preview when a new linked-document revision arrives in the same room', async () => {
  const view = render(frame())
  await screen.findByText('saved-not-unsaved')
  preview.mockResolvedValue({ token: 'view2', kind: 'text', name: 'revised.txt', text: 'new-revision' })

  view.rerender(frame({ ...state, linkedDocument: { name: 'revised.txt', revision: 'two', state: 'linked' } }))

  await screen.findByText('new-revision')
  expect(close).toHaveBeenCalledWith('view1')
})

it('reports an unsupported format honestly without a write or native-launch bridge', async () => {
  preview.mockResolvedValue({ token: 'view1', name: 'file.docx', kind: 'unsupported' })
  render(frame())
  await screen.findByText('This file can’t be previewed.')
  expect(screen.queryByRole('textbox')).toBeNull()
  // A short status chip stands in for the old paragraph; the detail is one hover away.
  expect(screen.getByText('View only')).toBeTruthy()
  expect(screen.queryByText(/read-only preview of the saved file/)).toBeNull()
})

it('describes sync recovery without asking the user to choose the still-linked document again', async () => {
  render(frame({ ...state, state: 'offline' }))
  expect(screen.getByRole('status').textContent).toBe('Offline · reconnecting')
  expect(preview).not.toHaveBeenCalled()
})

it('keeps an editable room-scoped buffer mounted through offline reconnect without fetching another preview token', async () => {
  const textDocument = {
    read: vi.fn(async () => ({ revision: 'r1', text: 'Saved text', truncated: false })),
    write: vi.fn(async () => ({ revision: 'r2' })),
    recoveryDiscard: vi.fn(async () => ({ outcome: 'discarded' as const, record: null })),
    recoveryRead: vi.fn(async () => ({ outcome: 'absent' as const, record: null })),
    recoveryWrite: vi.fn(async () => ({ outcome: 'saved' as const, record: { draftRevision: 'd1', text: 'draft', baseRevision: 'r1', editorRevision: '1', documentId: 'doc', updatedAt: 'now', workspaceRelativePath: 'notes.txt' } }))
  }

  preview.mockResolvedValue({ token: 'editable-1', kind: 'editable', name: 'notes.txt', recovery: false })
  Object.assign(window, {
    atumMatrix: { command, previewDocument: preview, closeDocumentPreview: close, document: documentPicker, textDocument }
  })
  const view = render(frame())
  const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Source (advanced)' })

  fireEvent.change(editor, { target: { value: 'Offline buffer', selectionStart: 14, selectionEnd: 14 } })
  view.rerender(frame({ ...state, state: 'offline' }))

  expect(editor.value).toBe('Offline buffer')
  expect(editor.disabled).toBe(true)
  expect(screen.getByText('Your edits are kept until this room reconnects.')).toBeTruthy()
  await new Promise(resolve => setTimeout(resolve, 120))
  expect(textDocument.write).not.toHaveBeenCalled()
  expect(preview).toHaveBeenCalledTimes(1)
  expect(close).not.toHaveBeenCalled()

  view.rerender(frame(state))
  await waitFor(() => expect(textDocument.write).toHaveBeenCalledWith('editable-1', { expectedRevision: 'r1', text: 'Offline buffer' }))
  expect(preview).toHaveBeenCalledTimes(1)
})

it('leaves Escape to a covering sheet rather than also closing the compact workbench', async () => {
  const onClose = vi.fn()
  const view = render(frame(state, false, true, true, onClose))
  await screen.findByText('saved-not-unsaved')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
  view.rerender(frame(state, false, true, false, onClose))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})

it('gives a compact panel, which covers the chat, a visible way back to it', () => {
  const onClose = vi.fn()
  const view = render(frame({ ...state, linkedDocument: null }, false, true, false, onClose))
  fireEvent.click(screen.getByRole('button', { name: 'Back to the chat' }))
  expect(onClose).toHaveBeenCalledOnce()
  view.unmount()
  // Beside the chat there is nothing to go back to.
  render(frame({ ...state, linkedDocument: null }))
  expect(screen.queryByRole('button', { name: 'Back to the chat' })).toBeNull()
})

it('speaks Vietnamese in its tabs: "Thẻ mới", and a search names its tab "Trình duyệt"', async () => {
  Object.assign(window.atumMatrix, {
    consumerBrowser: {
      onPopup: vi.fn(() => () => undefined),
      onNotice: vi.fn(() => () => undefined),
      prepare: browserPrepare,
      release: browserRelease
    }
  })
  render(frame({ ...state, linkedDocument: null }, false, false, false, () => {}, {}, 'vi'))
  expect(screen.getByRole('tab', { name: 'Thẻ mới' })).toBeTruthy()
  const address = screen.getByRole('textbox', { name: 'Tìm kiếm hoặc nhập trang web' })
  fireEvent.change(address, { target: { value: 'cà phê đà lạt' } })
  fireEvent.submit(address.closest('form')!)
  expect(await screen.findByRole('tab', { name: 'Trình duyệt' })).toBeTruthy()
})

it('shows one truthful Word save status and one Open in Word action', async () => {
  const arrangeWord = vi.fn(async () => {})
  Object.assign(window.atumMatrix, { arrangeWord })
  preview.mockResolvedValue({ token: 'view1', kind: 'word', name: 'plan.docx', text: 'Live Word text', saved: false })
  render(frame({ ...state, linkedDocument: { name: 'plan.docx', revision: 'one', state: 'linked', kind: 'word' } }))
  await screen.findByText('Live Word text')
  const header = window.document.querySelector('[data-matrix-word-header]') as HTMLElement

  expect(within(header).getByText('plan.docx')).toBeTruthy()
  expect(within(header).getByText('Unsaved changes in Word')).toBeTruthy()
  expect(within(header).getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByText('View only')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Exit side by side' })).toBeNull()
  fireEvent.click(within(header).getByRole('button', { name: 'Open in Word' }))
  await waitFor(() => expect(arrangeWord).toHaveBeenCalledWith('!one:test', true))
  expect(arrangeWord).toHaveBeenCalledTimes(1)
})

it('shows no Word save status when an older preview omits native save metadata', async () => {
  Object.assign(window.atumMatrix, { arrangeWord: vi.fn(async () => {}) })
  preview.mockResolvedValue({
    token: 'view1', kind: 'word', name: 'plan.docx', text: 'Live Word text'
  } as MatrixDocumentPreview)
  render(frame({ ...state, linkedDocument: { name: 'plan.docx', revision: 'one', state: 'linked', kind: 'word' } }))

  await screen.findByText('Live Word text')
  const header = window.document.querySelector('[data-matrix-word-header]') as HTMLElement

  expect(header.querySelector('[data-matrix-word-save-status]')).toBeNull()
  expect(within(header).getByRole('button', { name: 'Open in Word' })).toBeTruthy()
})

it('folds the roster only when rail, roster and an open panel would leave the chat too narrow to read', () => {
  expect(matrixWorkbenchCrowdsRoster(1100, 50)).toBe(true)
  expect(matrixWorkbenchCrowdsRoster(1024, 50)).toBe(true)
  expect(matrixWorkbenchCrowdsRoster(1280, 50)).toBe(false)
  expect(matrixWorkbenchCrowdsRoster(1100, 30)).toBe(false)
})

it('retires the app pane when native account generation changes without changing the Matrix identity', async () => {
  const app: AppDescriptor = {
    app: 'moon', app_id: 'moon-id', app_version_id: 'moon-v1', name: { en: 'Moon' }, subtitle: null,
    description: null, icon: null, accent: '#D8612F', affiliation: 'first_party', verified: true,
    availability: 'available', roster_default: true, roster_order: 1, supported_modes: ['direct'], has_surface: true,
    link: { mode: 'external_account', state: 'linked' }, bot: {
      v: 1, user_id: '@moon:test', handle: 'moon', display_name: 'Moon', avatar: { url: '', sha256: 'a'.repeat(64) },
      device_generation: 1, device: { device_id: 'BOT', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
      state: 'active', groups: true, consent: 'accepted', disclosure_version: 1, open_route_id: 'chat',
      open_shared_memory: true, purchase_route_id: 'readings'
    }
  }

  const open = vi.fn(async (_input: { app: string; route_id: string; panelNavigation?: boolean }) => ({ viewId: 'generation-one-view' }))
  const closeView = vi.fn(async () => ({ ok: true as const }))
  const menu = vi.fn(async () => ({ app, routes: [{ id: 'readings', label: { en: 'Readings', vi: 'Luận giải' }, icon: 'moon', session: 'required' as const }] }))
  Object.assign(window.atumMatrix, { apps: { menu, onReturn: () => () => {}, view: {
    open, close: closeView, setVisibility: async () => ({ ok: true }), setBounds: async () => ({ ok: true }),
    focus: async () => ({ ok: true }), reload: async () => ({ ok: true }), onState: () => () => {}
  } } })

  const dm: MatrixSnapshot = { ...state, linkedDocument: null, petScope: 'account:1', apps: { state: 'ready', apps: [app], connections: {} },
    rooms: [{ id: state.roomId!, name: 'Moon', encrypted: true, direct: true, membership: 'join',
      participants: [{ userId: state.identity!.userId, membership: 'join' }, { userId: app.bot!.user_id, membership: 'join' }] }] }

  const view = render(frame(dm))
  fireEvent.click(await screen.findByRole('button', { name: 'Readings' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ app: 'moon', panelNavigation: true, route_id: 'readings' }))
  expect(open).toHaveBeenCalledOnce()
  view.rerender(frame({ ...dm, petScope: 'account:2' }))
  await waitFor(() => expect(closeView).toHaveBeenCalledWith('generation-one-view'))
  expect(open).toHaveBeenCalledOnce()
  // The retired page does not survive: the panel is back on the app's pages, none open.
  expect(await screen.findByRole('button', { name: 'Readings' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
})
