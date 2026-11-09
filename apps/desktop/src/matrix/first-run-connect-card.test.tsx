// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixAgentSourceGate, MatrixAgentSourcesView } from '../../shared/matrix-agent-sources'
import type { MatrixBrowserImportBridge } from '../../shared/matrix-browser-import'
import type { MatrixFolderAccessView } from '../../shared/matrix-folder-access'
import type { MatrixPermissionsSnapshot } from '../../shared/matrix-permissions'

import { MatrixFirstRunConnectCard } from './first-run-connect-card'

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@minh:test', deviceId: 'MAC' },
  assistant: { userId: '@atum:test', deviceId: 'ATUM' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  firstRunMarker: 'unseen',
  firstRunWelcome: 'open',
  firstRun: 'offer',
  firstRunOpen: true,
  googleAssistant: { state: 'connect' }
}

const allOff = {
  google: false,
  folders: false,
  messages: false,
  browser: false,
  location: false,
  team_spaces: false
}

function source(
  kind: string,
  gate: MatrixAgentSourceGate,
  grantable = true
): MatrixAgentSourcesView['sources'][number] {
  return {
    kind,
    optOutGate: gate,
    availability: grantable ? 'available' : 'unavailable',
    status: grantable ? 'ready' : 'unavailable',
    grantable
  }
}

function permissions(fullDisk: MatrixPermissionsSnapshot['permissions']['fullDisk'] = 'granted') {
  let listener: ((snapshot: MatrixPermissionsSnapshot) => void) | undefined
  let current = fullDisk

  const value = (): MatrixPermissionsSnapshot => ({
    platform: 'macos',
    permissions: {
      accessibility: 'not-granted',
      screen: 'not-granted',
      microphone: 'not-determined',
      automation: 'manual-check',
      files: 'manual-check',
      fullDisk: current,
      location: 'not-determined'
    }
  })

  const status = vi.fn(async () => value())
  const openSettings = vi.fn(async () => {})
  const relaunch = vi.fn(async () => {})

  return {
    bridge: {
      status,
      openSettings,
      relaunch,
      watch: vi.fn(next => {
        listener = next

        return vi.fn()
      })
    },
    grant() {
      current = 'granted'
      listener?.(value())
    },
    openSettings,
    relaunch,
    status
  }
}

function fixture(options: {
  fullDisk?: MatrixPermissionsSnapshot['permissions']['fullDisk']
  gates?: Partial<MatrixAgentSourcesView['gates']>
} = {}) {
  let view: MatrixAgentSourcesView = {
    gates: { ...allOff, ...options.gates },
    sources: [
      source('google.mail', 'google'),
      source('mac.files', 'folders'),
      source('mac.message-metadata', 'messages'),
      source('mac.browser-history', 'browser'),
      source('mac.location', 'location', false),
      source('matrix.owner-rooms', 'team_spaces')
    ]
  }

  const read = vi.fn(async () => view)

  const set = vi.fn(async (gate: MatrixAgentSourceGate, enabled: boolean) => {
    view = { ...view, gates: { ...view.gates, [gate]: enabled } }

    return view
  })

  const start = vi.fn(async () => {})
  const decline = vi.fn(async () => {})

  const connect = vi.fn(async () => ({
    status: {
      available: true,
      sources: [{
        id: 'mail', groupId: 'google', provider: 'google' as const, kind: 'email' as const,
        label: 'minh@example.com', state: 'connected' as const, enabled: true
      }]
    }
  }))

  const access = permissions(options.fullDisk)
  const setEnabled = vi.fn(async () => ({ enabled: true, city: 'Ho Chi Minh City' }))

  const bridge = {
    agentSources: { read, set },
    firstRun: { start, allow: vi.fn(), decline, finish: vi.fn() },
    googleConnections: { connect },
    ownerLocation: { read: vi.fn(), setEnabled },
    permissions: access.bridge
  } as unknown as MatrixUiBridge

  const run = vi.fn(async () => ({
    outcome: 'imported', siteCount: 2, skippedSiteCount: 0, agentPrincipal: 'agent', at: 1
  } as const))

  const browserImport = { run, status: vi.fn() } as unknown as MatrixBrowserImportBridge

  return { access, bridge, browserImport, connect, decline, read, run, set, setEnabled, start }
}

function show(f = fixture()) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixFirstRunConnectCard
        bridge={f.bridge}
        browserImport={f.browserImport}
        roomId="!atum:test"
        snapshot={snapshot}
      />
    </I18nProvider>
  )
}

afterEach(cleanup)

describe('registry-fed first-run consent', () => {
  it('reads only descriptor presentation before consent and starts no learning or provider work', async () => {
    const f = fixture()
    show(f)

    expect(await screen.findByRole('heading', { name: 'Let me get to know your world' })).toBeTruthy()
    expect(f.read).toHaveBeenCalledOnce()
    expect(f.set).not.toHaveBeenCalled()
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()
    expect(f.setEnabled).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
  })

  it('checks every grantable source by default', async () => {
    const f = fixture()
    show(f)

    const checkboxes = await screen.findAllByRole('checkbox')

    expect(checkboxes).toHaveLength(5)
    expect(checkboxes.every(checkbox => checkbox.getAttribute('data-state') === 'checked')).toBe(true)
  })

  it('Continue writes every checked gate in projection order and starts existing first learning', async () => {
    const f = fixture()
    show(f)

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(f.start).toHaveBeenCalledExactlyOnceWith({
      locale: 'en', ending: 'done', roomId: '!atum:test'
    }))
    expect(f.set.mock.calls.map(([gate]) => gate)).toEqual([
      'google', 'folders', 'messages', 'browser', 'team_spaces'
    ])
    expect(f.set.mock.calls.every(([, enabled]) => enabled === true)).toBe(true)
    expect(f.connect).toHaveBeenCalledExactlyOnceWith('google')
    expect(f.run).toHaveBeenCalledOnce()
    expect(f.setEnabled).not.toHaveBeenCalled()
  })

  it('unchecking one inline row excludes it from the grant', async () => {
    const f = fixture()
    show(f)

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Messages' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(f.set.mock.calls.map(([gate]) => gate)).toEqual(['google', 'folders', 'browser', 'team_spaces'])
    expect(f.access.status).not.toHaveBeenCalled()
  })

  it('Not now writes no gate, starts no learning, and settles the ask', async () => {
    const f = fixture()
    show(f)

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(f.decline).toHaveBeenCalledOnce())
    expect(f.set).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Let me get to know your world' })).toBeNull()
  })

  it('keeps unavailable descriptor rows honest and not grantable', async () => {
    const f = fixture()
    const rendered = show(f)

    await screen.findByText('Location')
    expect(rendered.container.querySelector('[data-atum-ask="location"]')?.textContent).toContain(
      'Not available yet.'
    )
    expect(screen.queryByRole('checkbox', { name: 'Location' })).toBeNull()
  })

  it('requests Full Disk Access by default, offers one Settings pill, and continues only after the grant', async () => {
    const f = fixture({ fullDisk: 'not-granted' })
    show(f)

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(f.access.openSettings).toHaveBeenCalledExactlyOnceWith('fullDisk'))
    expect(f.start).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()

    act(() => f.access.grant())
    await waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(f.set).toHaveBeenCalledWith('messages', true)
  })

  it('shows an already granted row as done without another checkbox', async () => {
    const f = fixture({ gates: { google: true } })
    const rendered = show(f)

    await screen.findByText('Google')
    expect(rendered.container.querySelector('[data-atum-ask="google"]')?.textContent).toContain('Done')
    expect(screen.queryByRole('checkbox', { name: 'Google' })).toBeNull()
  })
})

function folderAccess(macAnswer: 'granted' | 'denied' = 'granted') {
  let view: MatrixFolderAccessView = {
    platform: 'macos',
    folders: (['desktop', 'documents', 'downloads', 'icloud'] as const).map(kind => ({
      id: kind, kind, shared: true, mac: 'not-asked' as const
    }))
  }

  const apply = vi.fn(async (choices: Record<string, boolean>) => {
    view = {
      ...view,
      folders: view.folders
        .filter(row => row.kind !== 'added' || choices[row.id] !== false)
        .map(row => {
          if (row.kind === 'added') {return row}

          const shared = choices[row.id] ?? row.shared

          return { ...row, shared, mac: shared ? macAnswer : row.mac }
        })
    }

    return view
  })

  const add = vi.fn(async () => {
    view = { ...view, folders: [...view.folders, { id: 'added:0', kind: 'added', name: 'Clients', shared: true, mac: 'granted' }] }

    return view
  })

  return { bridge: { read: vi.fn(async () => view), apply, add, remove: vi.fn() }, apply, add }
}

function showWithFolders(macAnswer: 'granted' | 'denied' = 'granted') {
  const f = fixture()
  const folders = folderAccess(macAnswer)
  ;(f.bridge as { folderAccess?: unknown }).folderAccess = folders.bridge
  show(f)

  return { ...f, folders }
}

describe('first-run folder checklist', () => {
  it('lists each Mac folder under Mac folders, every one ticked, and asks macOS nothing yet', async () => {
    const f = showWithFolders()

    for (const name of ['Desktop', 'Documents', 'Downloads', 'iCloud Drive']) {
      expect((await screen.findByRole('checkbox', { name })).getAttribute('data-state')).toBe('checked')
    }

    expect(screen.getByRole('button', { name: 'Add a folder…' })).toBeTruthy()
    expect(f.folders.apply).not.toHaveBeenCalled()
  })

  it('Continue saves the unticked folder as closed and lets macOS ask for the rest', async () => {
    const f = showWithFolders()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Documents' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(f.folders.apply).toHaveBeenCalledExactlyOnceWith({
      desktop: true, documents: false, downloads: true, icloud: true
    })
    expect(f.set.mock.calls.map(([gate]) => gate)).toContain('folders')
  })

  it('unticking Mac folders closes every folder and leaves the folder tools off', async () => {
    const f = showWithFolders()

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Mac folders' }))

    for (const name of ['Desktop', 'Documents', 'Downloads', 'iCloud Drive']) {
      expect(screen.getByRole('checkbox', { name }).getAttribute('data-state')).toBe('unchecked')
    }

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(f.folders.apply).toHaveBeenCalledExactlyOnceWith({
      desktop: false, documents: false, downloads: false, icloud: false
    })
    expect(f.set.mock.calls.map(([gate]) => gate)).not.toContain('folders')
  })

  it('unticking the last folder unticks Mac folders; ticking one ticks it again', async () => {
    showWithFolders()

    for (const name of ['Desktop', 'Documents', 'Downloads', 'iCloud Drive']) {
      fireEvent.click(await screen.findByRole('checkbox', { name }))
    }

    expect(screen.getByRole('checkbox', { name: 'Mac folders' }).getAttribute('data-state')).toBe('unchecked')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Downloads' }))
    expect(screen.getByRole('checkbox', { name: 'Mac folders' }).getAttribute('data-state')).toBe('checked')
  })

  it('an added folder joins the list ticked and is saved with the rest', async () => {
    const f = showWithFolders()

    fireEvent.click(await screen.findByRole('button', { name: 'Add a folder…' }))

    expect((await screen.findByRole('checkbox', { name: 'Clients' })).getAttribute('data-state')).toBe('checked')

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(f.folders.apply).toHaveBeenCalledOnce())
    expect(f.folders.apply.mock.calls[0]![0]).toMatchObject({ 'added:0': true })
  })

  it('when macOS keeps every folder closed, the folder tools stay off', async () => {
    const f = showWithFolders('denied')

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(f.set.mock.calls.map(([gate]) => gate)).not.toContain('folders')
  })

  it('explains the folders and Full Disk Access behind a tip, not on the card', async () => {
    showWithFolders()

    await screen.findByRole('checkbox', { name: 'Desktop' })

    expect(screen.queryByText('Files in folders available to Atum.')).toBeNull()
    expect(screen.queryByText(/Full Disk Access/u)).toBeNull()
    expect(screen.getAllByRole('button', { name: 'More info' }).length).toBeGreaterThanOrEqual(2)
  })
})
