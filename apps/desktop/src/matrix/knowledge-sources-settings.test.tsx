// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type {
  MatrixAgentSourceGate,
  MatrixAgentSourcesBridge,
  MatrixAgentSourcesView
} from '../../shared/matrix-agent-sources'
import type { MatrixFolderAccessBridge, MatrixFolderAccessView } from '../../shared/matrix-folder-access'
import type { MatrixPermissionsBridge } from '../../shared/matrix-permissions'

import { MatrixKnowledgeSourcesSettings } from './knowledge-sources-settings'

const gates: MatrixAgentSourcesView['gates'] = {
  google: true,
  folders: true,
  messages: true,
  browser: true,
  location: true,
  team_spaces: true
}

const view: MatrixAgentSourcesView = {
  gates,
  sources: [
    ['google.mail', 'google'],
    ['google.calendar', 'google'],
    ['google.drive', 'google'],
    ['mac.files', 'folders'],
    ['mac.message-metadata', 'messages'],
    ['mac.browser-history', 'browser'],
    ['mac.location', 'location'],
    ['matrix.owner-rooms', 'team_spaces']
  ].map(([kind, optOutGate]) => ({
    kind,
    optOutGate,
    grantable: true,
    availability: 'available' as const,
    status: 'ready' as const
  }))
}

function bridge(initial: MatrixAgentSourcesView = view) {
  let current = initial
  const listeners = new Set<() => void>()

  const set = vi.fn(async (gate: MatrixAgentSourceGate, enabled: boolean) => {
    current = { ...current, gates: { ...current.gates, [gate]: enabled } }

    return current
  })

  return {
    value: {
      read: vi.fn(async () => current),
      set,
      subscribe: (listener: () => void) => {
        listeners.add(listener)

        return () => void listeners.delete(listener)
      }
    } as MatrixAgentSourcesBridge,
    set,
    /** Main saved a change elsewhere (first-run ask, another window) and announced it. */
    changeElsewhere: (next: MatrixAgentSourcesView) => {
      current = next

      for (const listener of listeners) {
        listener()
      }
    },
    replace: (next: MatrixAgentSourcesView) => void (current = next),
    listeners
  }
}

function withStatus(
  gate: MatrixAgentSourceGate,
  status: MatrixAgentSourcesView['sources'][number]['status'],
  extra: Partial<MatrixAgentSourcesView['sources'][number]> = {}
): MatrixAgentSourcesView {
  return {
    ...view,
    sources: view.sources.map(source => (source.optOutGate === gate ? { ...source, status, ...extra } : source))
  }
}

function show(
  current: MatrixAgentSourcesBridge | undefined,
  locale: Locale = 'en',
  permissions?: MatrixPermissionsBridge
) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixKnowledgeSourcesSettings bridge={current} permissions={permissions} />
    </I18nProvider>
  )
}

afterEach(cleanup)

it('shows one on switch per descriptor gate and no fake Forget action', async () => {
  const f = bridge()
  const rendered = show(f.value)

  expect(await screen.findByText('What Atum can read')).toBeTruthy()
  await waitFor(() => expect(rendered.container.querySelectorAll('[data-matrix-knowledge-source]')).toHaveLength(6))
  expect(screen.getAllByRole('switch').every(item => item.getAttribute('data-state') === 'checked')).toBe(true)
  expect(screen.getAllByRole('switch', { name: 'Google' })).toHaveLength(1)
  expect(screen.queryByText(/Forget what Atum learned/)).toBeNull()
})

it('writes a revocation through the fenced bridge and reflects the authoritative result', async () => {
  const f = bridge()
  show(f.value)
  const messages = await screen.findByRole('switch', { name: 'Messages' })

  fireEvent.click(messages)
  await waitFor(() => expect(f.set).toHaveBeenCalledExactlyOnceWith('messages', false))
  await waitFor(() => expect(messages.getAttribute('data-state')).toBe('unchecked'))
})

it('rolls back a refused switch and shows one short failure line', async () => {
  const f = bridge()
  f.set.mockRejectedValueOnce(new Error('private detail'))
  show(f.value)
  const browser = await screen.findByRole('switch', { name: 'Browser' })

  fireEvent.click(browser)
  expect(await screen.findByText('Couldn’t save that switch. Try again.')).toBeTruthy()
  expect(browser.getAttribute('data-state')).toBe('checked')
  expect(screen.queryByText('private detail')).toBeNull()
})

it('keeps an unavailable source on its saved switch, still switchable, with one quiet line', async () => {
  const f = bridge({
    gates,
    sources: [
      {
        kind: 'future.private-journal',
        optOutGate: 'messages',
        grantable: false,
        availability: 'unavailable',
        status: 'unavailable'
      }
    ]
  })

  show(f.value)

  const item = await screen.findByRole('switch', { name: 'Other source' })
  expect(item.getAttribute('data-state')).toBe('checked')
  expect(item.hasAttribute('disabled')).toBe(false)
  expect(screen.getByText('Not available yet.')).toBeTruthy()
  expect(screen.queryByText(/this assistant/i)).toBeNull()
})

it('never flips a saved switch when the status changes underneath it', async () => {
  const f = bridge()
  show(f.value)
  const messages = await screen.findByRole('switch', { name: 'Messages' })

  f.changeElsewhere(withStatus('messages', 'needs_mac', { grantable: false, availability: 'unavailable' }))
  expect(await screen.findByText('Needs a Mac.')).toBeTruthy()
  expect(messages.getAttribute('data-state')).toBe('checked')
  expect(messages.hasAttribute('disabled')).toBe(false)
})

it.each([
  ['mac_only', 'On this Mac only for now.'],
  ['needs_permission', 'Needs permission in System Settings.'],
  ['not_connected', 'Not connected yet.']
] as const)('says %s in one short line beside a switched-on source', async (status, line) => {
  show(bridge(withStatus('browser', status)).value)

  const row = (await screen.findByText(line)).closest('[data-matrix-knowledge-source]')
  expect(row?.getAttribute('data-matrix-knowledge-source')).toBe('browser')
  expect(row?.getAttribute('data-matrix-knowledge-source-status')).toBe(status)
})

it('keeps the ordinary description while a source is off', async () => {
  show(bridge({ ...withStatus('browser', 'mac_only'), gates: { ...gates, browser: false } }).value)

  expect(await screen.findByText('Safari and Chrome titles, domains and visit counts.')).toBeTruthy()
  expect(screen.queryByText('On this Mac only for now.')).toBeNull()
})

it('offers the one-tap macOS pane for a source that needs permission, and only when it is on', async () => {
  const openSettings = vi.fn(async () => {})
  const permissions = { status: vi.fn(), openSettings } as MatrixPermissionsBridge
  const f = bridge(withStatus('messages', 'needs_permission', { permission: 'fullDisk' }))
  show(f.value, 'en', permissions)

  const open = await screen.findByRole('button', { name: 'Open System Settings' })
  fireEvent.click(open)
  await waitFor(() => expect(openSettings).toHaveBeenCalledExactlyOnceWith('fullDisk'))

  fireEvent.click(screen.getByRole('switch', { name: 'Messages' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Open System Settings' })).toBeNull())
})

it('re-reads the saved switches when main announces a change elsewhere', async () => {
  const f = bridge()
  show(f.value)
  const location = await screen.findByRole('switch', { name: 'Location' })

  f.changeElsewhere({ ...view, gates: { ...gates, location: false } })
  await waitFor(() => expect(location.getAttribute('data-state')).toBe('unchecked'))
})

it('re-reads on window focus and when the page becomes visible', async () => {
  const f = bridge()
  show(f.value)
  const browser = await screen.findByRole('switch', { name: 'Browser' })
  const reads = vi.mocked(f.value.read).mock.calls.length

  f.replace({ ...view, gates: { ...gates, browser: false } })
  act(() => void window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(browser.getAttribute('data-state')).toBe('unchecked'))

  f.replace(view)
  act(() => void window.document.dispatchEvent(new Event('visibilitychange')))
  await waitFor(() => expect(browser.getAttribute('data-state')).toBe('checked'))
  expect(vi.mocked(f.value.read).mock.calls.length).toBe(reads + 2)
})

it('a quiet refresh that fails keeps the switches and shows no error', async () => {
  const f = bridge()
  show(f.value)
  await screen.findByRole('switch', { name: 'Google' })

  vi.mocked(f.value.read).mockRejectedValueOnce(new Error('offline'))
  act(() => void window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(f.value.read).toHaveBeenCalledTimes(2))
  expect(screen.getAllByRole('switch')).toHaveLength(6)
  expect(screen.queryByText('Couldn’t load these controls.')).toBeNull()
})

it('lets a save in flight settle on its own answer, not a refresh that raced it', async () => {
  const f = bridge()
  let finish!: (value: MatrixAgentSourcesView) => void
  f.set.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  show(f.value)
  const folders = await screen.findByRole('switch', { name: 'Mac folders' })

  fireEvent.click(folders)
  expect(folders.getAttribute('data-state')).toBe('unchecked')
  // A stale record arrives through focus while the save is still running: it must not win.
  act(() => void window.dispatchEvent(new Event('focus')))
  await act(async () => finish({ ...view, gates: { ...gates, folders: false } }))
  expect(folders.getAttribute('data-state')).toBe('unchecked')
})

it('after a refused save shows the record main actually holds', async () => {
  const f = bridge()
  f.set.mockImplementationOnce(async () => {
    // Main committed the switch and then failed later (e.g. the policy file): the record moved.
    f.replace({ ...view, gates: { ...gates, location: false } })
    throw new Error('late failure')
  })
  show(f.value)
  const location = await screen.findByRole('switch', { name: 'Location' })

  fireEvent.click(location)
  expect(await screen.findByText('Couldn’t save that switch. Try again.')).toBeTruthy()
  expect(location.getAttribute('data-state')).toBe('unchecked')
})

it.each([
  ['data:image/png;base64,QUJDRA==', true],
  ['https://apps.example/icon.png', true],
  ['data:image/svg+xml;base64,PHN2Zz4=', false],
  ['javascript:alert(1)', false]
] as const)('renders only allowlisted presentation icons: %s', async (iconDataUrl, rendered) => {
  const f = bridge({
    gates,
    sources: [{
      kind: 'future.travel', optOutGate: 'team_spaces', availability: 'available', status: 'ready', grantable: true,
      presentation: { label: 'Travel', iconDataUrl }
    }]
  })

  const result = show(f.value)

  await screen.findByRole('switch', { name: 'Travel' })
  expect(result.container.querySelector('img') !== null).toBe(rendered)
})

it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
  'routes every projected row through the %s copy',
  async locale => {
    const rendered = show(bridge().value, locale)
    await waitFor(() => expect(rendered.container.querySelectorAll('[data-matrix-knowledge-source]')).toHaveLength(6))
  }
)

it('is honest when the trusted source bridge is missing', () => {
  show(undefined)
  expect(screen.getByText('Source controls aren’t available in this version.')).toBeTruthy()
})

it('shows a closed read failure instead of unchecked switches', async () => {
  const f = bridge()
  f.value.read = vi.fn(async () => Promise.reject(new Error('private detail')))
  show(f.value)

  expect(await screen.findByText('Couldn’t load these controls.')).toBeTruthy()
  expect(screen.queryAllByRole('switch')).toHaveLength(0)
  expect(screen.queryByText('private detail')).toBeNull()
})

it('retries a failed read without writing any gates', async () => {
  const f = bridge()
  vi.mocked(f.value.read).mockRejectedValueOnce(new Error('offline'))
  show(f.value)
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  await screen.findByRole('switch', { name: 'Google' })
  expect(f.value.read).toHaveBeenCalledTimes(2)
  expect(f.set).not.toHaveBeenCalled()
})

it('rejects a late write result after the source bridge changes scope', async () => {
  const old = bridge()
  let finish!: (value: MatrixAgentSourcesView) => void
  old.set.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const rendered = show(old.value)
  fireEvent.click(await screen.findByRole('switch', { name: 'Google' }))
  const next = bridge({ ...view, gates: { ...gates, google: false } })
  rendered.rerender(<I18nProvider configClient={null} initialLocale="en"><MatrixKnowledgeSourcesSettings bridge={next.value} /></I18nProvider>)
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Google' }).getAttribute('data-state')).toBe('unchecked'))
  await act(async () => finish(view))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Google' }).getAttribute('data-state')).toBe('unchecked'))
})

function folderBridge(mac: 'granted' | 'denied' = 'granted') {
  let current: MatrixFolderAccessView = {
    platform: 'macos',
    folders: [
      ...(['desktop', 'documents', 'downloads'] as const).map(kind => ({ id: kind, kind, shared: true, mac })),
      { id: 'added:0', kind: 'added' as const, name: 'Clients', shared: true, mac: 'granted' as const }
    ]
  }

  const apply = vi.fn(async (choices: Record<string, boolean>) => {
    current = { ...current, folders: current.folders.map(row => ({ ...row, shared: choices[row.id] ?? row.shared })) }

    return current
  })

  const remove = vi.fn(async (id: string) => {
    current = { ...current, folders: current.folders.filter(row => row.id !== id) }

    return current
  })

  return {
    value: { read: vi.fn(async () => current), apply, add: vi.fn(async () => current), remove } as MatrixFolderAccessBridge,
    apply,
    remove
  }
}

function showFolders(sources: MatrixAgentSourcesBridge, folders: MatrixFolderAccessBridge, openSettings = vi.fn(async () => {})) {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixKnowledgeSourcesSettings
        bridge={sources}
        folderAccess={folders}
        permissions={{ status: vi.fn(), openSettings }}
      />
    </I18nProvider>
  )

  return openSettings
}

it('lists the shared Mac folders under Mac folders, the same list as first run', async () => {
  const folders = folderBridge()
  showFolders(bridge().value, folders.value)

  fireEvent.click(await screen.findByRole('switch', { name: 'Documents' }))

  await waitFor(() => expect(folders.apply).toHaveBeenCalledExactlyOnceWith({ documents: false }))
  expect(screen.getByRole('switch', { name: 'Desktop' }).getAttribute('data-state')).toBe('checked')
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Documents' }).getAttribute('data-state')).toBe('unchecked'))

  fireEvent.click(screen.getByRole('button', { name: 'Remove Clients' }))
  await waitFor(() => expect(folders.remove).toHaveBeenCalledExactlyOnceWith('added:0'))
  await waitFor(() => expect(screen.queryByText('Clients')).toBeNull())
  expect(screen.getByRole('button', { name: 'Add a folder…' })).toBeTruthy()
})

it('a folder macOS kept closed offers System Settings beside its own switch', async () => {
  const folders = folderBridge('denied')
  const openSettings = showFolders(bridge().value, folders.value)

  const buttons = await screen.findAllByRole('button', { name: 'Open System Settings' })
  expect(buttons).toHaveLength(3)
  expect(screen.getAllByText('macOS kept this closed.')).toHaveLength(3)

  fireEvent.click(buttons[0]!)
  await waitFor(() => expect(openSettings).toHaveBeenCalledExactlyOnceWith('files'))

  // Back from System Settings: that one folder is checked again.
  act(() => void window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(folders.apply).toHaveBeenCalledExactlyOnceWith({ desktop: true }))
})

it('a folder macOS refused can still be turned off by the owner', async () => {
  const folders = folderBridge('denied')
  showFolders(bridge().value, folders.value)

  const documents = await screen.findByRole('switch', { name: 'Documents' })
  expect(documents.getAttribute('data-state')).toBe('checked')

  fireEvent.click(documents)
  await waitFor(() => expect(folders.apply).toHaveBeenCalledExactlyOnceWith({ documents: false }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Documents' }).getAttribute('data-state')).toBe('unchecked'))
  // Closed by the owner now, not by macOS: no System Settings detour for it.
  expect(screen.getAllByRole('button', { name: 'Open System Settings' })).toHaveLength(2)
})

it('hides the folder list while Mac folders is off', async () => {
  showFolders(bridge({ ...view, gates: { ...gates, folders: false } }).value, folderBridge().value)

  await screen.findByRole('switch', { name: 'Mac folders' })
  expect(screen.queryByRole('switch', { name: 'Desktop' })).toBeNull()
})
