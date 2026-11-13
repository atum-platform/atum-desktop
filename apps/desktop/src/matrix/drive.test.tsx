import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { AtumNavSwitchSurface } from '@/app/atum/shell-surface'
import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixDriveBridge, MatrixDriveView } from '../../shared/matrix-drive'

import {
  formatDriveSize,
  formatDriveSyncTime,
  MatrixDrive,
  type MatrixDriveDestination,
  matrixDrivePhase,
  MatrixDriveSidebar,
  recentDriveRows
} from './drive'
import { matrixDriveCopy } from './drive-copy'
import { learnMatrixDrivePlaces, setMatrixDriveLayout } from './drive-finder'
import { $matrixDriveTaskSelection, setMatrixDriveTaskScope } from './drive-selection'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

afterEach(() => {
  cleanup()
  setMatrixDriveTaskScope(null, null)
  setMatrixDriveLayout('icon')
  learnMatrixDrivePlaces(null, 'en')
  localStorage.clear()
})

const item = (name: string) => screen.getByRole('option', { name })

it('adds Drive to the existing siderail with current-page and accessible labeling', () => {
  const navigate = vi.fn()
  render(
    <AtumNavSwitchSurface
      ariaLabel="Navigation"
      destination="drive"
      discoverLabel="Discover"
      driveLabel="Atum Drive"
      homeLabel="Assistant"
      onDestinationChange={navigate}
    />
  )
  const button = screen.getByRole('button', { name: 'Atum Drive' })
  expect(button.getAttribute('aria-current')).toBe('page')
  expect(button.hasAttribute('data-atum-nav-drive')).toBe(true)
  fireEvent.click(button)
  expect(navigate).toHaveBeenCalledWith('drive')
})

it('orders the local Recents projection by modified time and previews only the opaque row', async () => {
  const rows = [
    { id: 'older', name: 'older.txt', kind: 'file' as const, size: 1, modifiedAt: 10 },
    { id: 'newest', name: 'newest.txt', kind: 'file' as const, size: 2, modifiedAt: 30 },
    { id: 'middle', name: 'middle.txt', kind: 'file' as const, size: 3, modifiedAt: 20 }
  ]

  expect(recentDriveRows(rows).map(row => row.id)).toEqual(['newest', 'middle', 'older'])

  const view: MatrixDriveView = {
    state: 'ready',
    revision: 2,
    canGoBack: false,
    truncated: false,
    rows
  }

  const onPreview = vi.fn()
  const bridge = { read: async () => view, subscribe: () => () => {} } as unknown as MatrixDriveBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixDrive bridge={bridge} destination="recents" onPreview={onPreview} />
    </I18nProvider>
  )

  await screen.findByRole('heading', { name: 'Recents' })
  expect(screen.getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual([
    'newest.txt',
    'middle.txt',
    'older.txt'
  ])
  // One click selects, as in Finder; a double-click opens.
  fireEvent.click(item('newest.txt'))
  expect(onPreview).not.toHaveBeenCalled()
  fireEvent.doubleClick(item('newest.txt'))
  expect(onPreview).toHaveBeenCalledWith(rows[1])
  expect(JSON.stringify(onPreview.mock.calls)).not.toContain('/')
})

it('renders actual native rows and only sends an opaque file id to open', async () => {
  const view: MatrixDriveView = {
    state: 'ready',
    revision: 2,
    rootLabel: 'Files',
    canGoBack: false,
    truncated: false,
    rows: [{ id: 'opaque-file', name: 'notes.txt', kind: 'file', size: 14, modifiedAt: Date.now() }]
  }

  const open = vi.fn(async () => {})
  const bridge = { read: async () => view, subscribe: () => () => {}, open } as unknown as MatrixDriveBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixDrive bridge={bridge} />
    </I18nProvider>
  )
  await screen.findByText('Up to date')
  fireEvent.doubleClick(item('notes.txt'))
  await waitFor(() => expect(open).toHaveBeenCalledWith('opaque-file'))
})

it('drops old revisions after native account withdrawal and shows no foreign rows', async () => {
  let receive!: (view: MatrixDriveView) => void
  const initial: MatrixDriveView = { state: 'disconnected', revision: 4, canGoBack: false, truncated: false, rows: [] }

  const bridge = {
    read: async () => initial,
    subscribe: (listener: typeof receive) => {
      receive = listener

      return () => {}
    }
  } as MatrixDriveBridge

  render(
    <I18nProvider configClient={null} initialLocale="vi">
      <MatrixDrive bridge={bridge} />
    </I18nProvider>
  )
  await screen.findByText('Đang chuẩn bị Drive, khoảng một phút')
  await act(async () =>
    receive({
      ...initial,
      revision: 3,
      state: 'ready',
      rows: [{ id: 'old', name: 'foreign.txt', kind: 'file', size: 1, modifiedAt: 0 }]
    })
  )
  expect(screen.queryByText('foreign.txt')).toBeNull()
  expect(screen.queryByText('Đã cập nhật')).toBeNull()
})

it('shows one calm empty state and no controls when the pinned engine is absent', () => {
  render(
    <I18nProvider configClient={null} initialLocale="vi">
      <MatrixDrive />
    </I18nProvider>
  )
  expect(screen.getByText('Sắp có Atum Drive')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByText('Chọn cuộc trò chuyện với trợ lý để dùng tệp Drive.')).toBeNull()
})

it('writes file sizes the way Finder does, never as a raw byte count', () => {
  expect(formatDriveSize(14, 'en')).toBe('14 byte')
  expect(formatDriveSize(2_483_712, 'en')).toBe('2.5 MB')
  expect(formatDriveSize(2_483_712, 'vi')).toBe('2,5 MB')
  expect(formatDriveSize(48_200, 'en')).toBe('48 kB')
  expect(formatDriveSize(3_100_000_000, 'en')).toBe('3.1 GB')
})

it('offers plain file actions, title-bar controls and no Turn off on a running Drive', async () => {
  const view: MatrixDriveView = {
    state: 'ready',
    revision: 2,
    rootLabel: 'Files',
    canGoBack: false,
    truncated: false,
    rows: [
      { id: 'opaque-file', name: 'notes.txt', kind: 'file', size: 2_483_712, modifiedAt: Date.now() },
      { id: 'opaque-folder', name: 'Reports', kind: 'folder', size: 0, modifiedAt: Date.now() }
    ]
  }

  const disconnect = vi.fn(async () => ({ ...view, state: 'disconnected' as const, rows: [] }))
  const bridge = { read: async () => view, subscribe: () => () => {}, disconnect } as unknown as MatrixDriveBridge

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixDrive
        bridge={bridge}
        taskScope={{ userId: '@owner:test', deviceId: 'OWNER', roomId: '!assistant:test' }}
      />
    </I18nProvider>
  )
  await screen.findByText('Up to date')
  expect(screen.getByRole('button', { name: 'Icons' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'List' }))
  expect(screen.getByText('2.5 MB')).toBeTruthy()
  // The selected item's actions for this chat float in one bar: a file can be read or edited…
  expect(screen.queryByRole('button', { name: 'Let assistant read' })).toBeNull()
  fireEvent.click(item('notes.txt'))
  expect(screen.getByRole('button', { name: 'Let assistant read' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Let assistant edit' })).toBeTruthy()
  // …and a folder can take a result.
  fireEvent.click(item('Reports'))
  expect(screen.queryByRole('button', { name: 'Let assistant read' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save result here' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Result file name' }), { target: { value: 'summary.md' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect($matrixDriveTaskSelection.get().selections).toEqual([
    expect.objectContaining({ id: 'opaque-folder', mode: 'create', leafName: 'summary.md' })
  ])
  expect(screen.queryByRole('button', { name: 'Turn off Drive' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Search Drive' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'More Drive actions' })).toBeTruthy()
  expect(disconnect).not.toHaveBeenCalled()
})

it('clears an old bridge action on replacement and ignores its late result', async () => {
  const view: MatrixDriveView = {
    state: 'ready', revision: 10, rows: [{ id: 'folder', name: 'Folder', kind: 'folder', size: 0, modifiedAt: 0 }],
    canGoBack: false, truncated: false
  }

  let finish!: (value: MatrixDriveView) => void

  const read = vi.fn().mockResolvedValue(view)

  const enter = vi.fn().mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )

  const old = { read, enter, subscribe: () => () => {} } as unknown as MatrixDriveBridge

  const next = {
    read: async () => ({ ...view, revision: 1, state: 'disconnected' as const }),
    subscribe: () => () => {}
  } as unknown as MatrixDriveBridge

  const surface = (bridge: MatrixDriveBridge) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixDrive bridge={bridge} />
    </I18nProvider>
  )

  const rendered = render(surface(old))
  await screen.findByText('Up to date')
  fireEvent.doubleClick(item('Folder'))
  rendered.rerender(surface(next))
  await screen.findByText('Getting your Drive ready — about a minute')
  expect(screen.queryByRole('button', { name: 'Turn on Atum Drive' })).toBeNull()
  await act(async () =>
    finish({ ...view, rows: [{ id: 'old', name: 'old-owner.txt', kind: 'file', size: 1, modifiedAt: 0 }] })
  )
  expect(screen.queryByText('old-owner.txt')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Turn on Atum Drive' })).toBeNull()
})

it('stages only opaque selections for the current assistant conversation and returns through its callback', async () => {
  const view: MatrixDriveView = {
    state: 'ready',
    revision: 3,
    canGoBack: false,
    truncated: false,
    rows: [
      { id: 'opaque-file', name: 'notes.txt', kind: 'file', size: 14, modifiedAt: Date.now() },
      { id: 'opaque-folder', name: 'Reports', kind: 'folder', size: 0, modifiedAt: Date.now() }
    ]
  }

  const useConversation = vi.fn()

  const bridge = {
    read: async () => view,
    subscribe: () => () => {},
    open: async () => {},
    enter: async () => view,
    taskStatus: async () => ({ state: 'ready' as const })
  } as unknown as MatrixDriveBridge

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixDrive
        bridge={bridge}
        onUseInConversation={useConversation}
        taskScope={{ userId: '@owner:test', deviceId: 'OWNER', roomId: '!assistant:test' }}
      />
    </I18nProvider>
  )
  await screen.findByText('Up to date')
  fireEvent.click(item('notes.txt'))
  fireEvent.click(screen.getByRole('button', { name: 'Let assistant read' }))
  expect($matrixDriveTaskSelection.get().selections).toEqual([
    expect.objectContaining({ id: 'opaque-file', mode: 'read' })
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Back to the chat' }))
  expect(useConversation).toHaveBeenCalledOnce()
})

function staticBridge(view: MatrixDriveView) {
  const actions = {
    connect: vi.fn(async () => view),
    chooseFolder: vi.fn(async () => ({ cancelled: true as const })),
    cancelSignIn: vi.fn(async () => ({ ...view, state: 'disconnected' as const, waitingForBrowser: undefined })),
    disconnect: vi.fn(async () => view),
    reveal: vi.fn(async () => {})
  }

  return {
    bridge: { read: async () => view, subscribe: () => () => {}, ...actions } as unknown as MatrixDriveBridge,
    ...actions
  }
}

function base(overrides: Partial<MatrixDriveView>): MatrixDriveView {
  return { state: 'disconnected', revision: 5, rows: [], canGoBack: false, truncated: false, ...overrides }
}

function show(bridge: MatrixDriveBridge, locale: 'en' | 'vi' = 'vi') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixDrive bridge={bridge} />
    </I18nProvider>
  )
}

it('sets Drive up automatically: a calm hero, no connect button and no folder picker', async () => {
  const drive = staticBridge(base({}))
  show(drive.bridge)
  await screen.findByRole('heading', { name: 'Đang chuẩn bị Drive, khoảng một phút' })
  expect(screen.getByRole('status', { name: 'Đang chuẩn bị Drive, khoảng một phút' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Bật Atum Drive' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Chọn thư mục khác…' })).toBeNull()
  expect(drive.connect).not.toHaveBeenCalled()
  expect(drive.chooseFolder).not.toHaveBeenCalled()
  // No file list or Refresh while Drive is starting.
  expect(screen.queryByRole('button', { name: 'Làm mới' })).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
})

it('a folder Drive could not use is a status row with Try again and, only if another folder helps, a choice', async () => {
  const drive = staticBridge(base({ problem: 'folder_nested_taken' }))
  show(drive.bridge)
  const words = await screen.findByText('Ở đó đã có một thư mục Drive chứa tệp khác. Hãy chọn thư mục khác.')
  expect(words.getAttribute('data-matrix-drive-problem')).toBe('folder_nested_taken')
  expect(screen.getByRole('heading', { name: 'Drive chưa bật được' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Bật Atum Drive' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
  await waitFor(() => expect(drive.connect).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Chọn thư mục khác…' }))
  await waitFor(() => expect(drive.chooseFolder).toHaveBeenCalledOnce())
  // A non-folder failure has no folder link: only Try again.
  drive.bridge = staticBridge(base({ state: 'error', problem: 'network' })).bridge
})

it('a changed saved folder offers only explicit re-selection or forgetting, never a blind retry', async () => {
  const drive = staticBridge(base({ state: 'disconnected', problem: 'folder_changed', rootLocation: '~/Atum/Drive' }))
  show(drive.bridge, 'en')

  await screen.findByRole('heading', { name: 'Choose your Drive folder again' })
  expect(
    screen.getByText(
      'The saved Drive folder was moved or replaced. Atum did not use the changed folder. Choose that folder again or choose another one, or stop using it on this Mac.'
    )
  ).toBeTruthy()
  expect(screen.getByText('Drive folder: ~/Atum/Drive')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Turn on Atum Drive' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
  await waitFor(() => expect(drive.chooseFolder).toHaveBeenCalledOnce())
  expect(drive.connect).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Stop using this folder' }))
  await waitFor(() => expect(drive.disconnect).toHaveBeenCalledOnce())
  expect(drive.connect).not.toHaveBeenCalled()
})

it('never shows a browser sign-in: a held or waiting sign-in is a plain status row', async () => {
  for (const view of [
    base({ state: 'authorizing', waitingForBrowser: true, rootLocation: '~/Documents/Atum Drive' }),
    base({ state: 'authorizing', signInNeeded: true, rootLocation: '~/Atum/Drive' }),
    base({ state: 'reauthenticate', signInNeeded: true, rootLocation: '~/Atum/Drive' })
  ]) {
    const drive = staticBridge(view)
    const rendered = show(drive.bridge)

    if (view.state === 'reauthenticate') {
      await screen.findByRole('heading', { name: 'Drive đã dừng' })
      fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
      await waitFor(() => expect(drive.connect).toHaveBeenCalledOnce())
    } else {
      await screen.findByRole('heading', { name: 'Đang chuẩn bị Drive, khoảng một phút' })
    }

    expect(screen.queryByRole('button', { name: 'Mở lại' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hủy' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Đăng nhập' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Bật Atum Drive' })).toBeNull()
    expect(drive.cancelSignIn).not.toHaveBeenCalled()
    rendered.unmount()
  }
})

it('getting ready: the spinner and the minute it takes, with nothing to press', async () => {
  for (const view of [
    base({ state: 'connecting', rootLocation: '~/Atum/Drive' }),
    base({ state: 'connecting', problem: 'setting_up' })
  ]) {
    const drive = staticBridge(view)
    const rendered = show(drive.bridge)
    await screen.findByRole('heading', { name: 'Đang chuẩn bị Drive, khoảng một phút' })
    expect(screen.getByRole('status', { name: 'Đang chuẩn bị Drive, khoảng một phút' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Bật Atum Drive' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hủy' })).toBeNull()
    rendered.unmount()
  }
})

it('up to date: keeps time and folder path out of the title bar and puts Finder in the more menu', async () => {
  const today = new Date()
  today.setHours(14, 32, 0, 0)

  const drive = staticBridge(
    base({
      state: 'ready',
      lastSyncAt: today.getTime(),
      rootLocation: '~/Atum/Drive',
      rows: [{ id: 'f', name: 'Kế hoạch.docx', kind: 'file', size: 48_200, modifiedAt: today.getTime() }]
    })
  )

  show(drive.bridge)
  const status = await screen.findByText('Đã cập nhật')
  expect(status.closest('[role="status"]')).toBeTruthy()
  const titlebar = window.document.querySelector<HTMLElement>('[data-matrix-drive-titlebar]')!
  expect(within(titlebar).queryByText(/14:32/)).toBeNull()
  expect(within(titlebar).queryByText(/Thư mục Drive/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Làm mới' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Thêm thao tác Drive' }), { key: 'Enter' })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hiện trong Finder' }))
  await waitFor(() => expect(drive.reveal).toHaveBeenCalledOnce())
  expect(formatDriveSyncTime(today.getTime(), 'vi', today.getTime())).toBe('14:32')
})

it.each(Object.keys(matrixDriveCopy) as Locale[])(
  'keeps the %s search action icon-only while its translated label remains in the tooltip',
  async locale => {
    const drive = staticBridge(base({ state: 'ready' }))

    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixDrive bridge={drive.bridge} />
      </I18nProvider>
    )

    await screen.findByText(matrixDriveCopy[locale].status.ready)
    const search = screen.getByRole('button', { name: matrixDriveCopy[locale].search })
    expect(search.textContent).toBe('')
    fireEvent.pointerMove(search, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toBe(matrixDriveCopy[locale].search)
  }
)

it('opens the kit search field and filters the current Drive rows', async () => {
  const drive = staticBridge(base({ state: 'ready', rows: [
    { id: 'notes', name: 'notes.txt', kind: 'file', size: 14, modifiedAt: 0 },
    { id: 'plan', name: 'plan.txt', kind: 'file', size: 14, modifiedAt: 0 }
  ] }))

  show(drive.bridge, 'en')
  fireEvent.click(await screen.findByRole('button', { name: 'Search Drive' }))
  const search = screen.getByRole('textbox', { name: 'Search Drive' })
  expect(search.closest('.ak-field--search')).toBeTruthy()
  fireEvent.change(search, { target: { value: 'plan' } })
  expect(screen.getByRole('option', { name: 'plan.txt' })).toBeTruthy()
  expect(screen.queryByRole('option', { name: 'notes.txt' })).toBeNull()
})

it('offline: says the files are still here, and keeps the list', async () => {
  const drive = staticBridge(
    base({ state: 'offline', rows: [{ id: 'f', name: 'notes.txt', kind: 'file', size: 14, modifiedAt: 0 }] })
  )

  show(drive.bridge)
  expect((await screen.findByText('Mất mạng, tệp của bạn vẫn ở đây')).closest('[role="status"]')).toBeTruthy()
  expect(screen.getByRole('option', { name: 'notes.txt' })).toBeTruthy()
})

it('offline with no cached rows never pretends the Drive is empty', async () => {
  const drive = staticBridge(base({ state: 'offline' }))
  show(drive.bridge)

  expect(await screen.findAllByText('Mất mạng, tệp của bạn vẫn ở đây')).toHaveLength(1)
  expect(screen.queryByText('Chưa có gì.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
  await waitFor(() => expect(drive.connect).toHaveBeenCalledOnce())
})

it('empty: says what to do and opens the folder from the title-bar menu', async () => {
  const drive = staticBridge(base({ state: 'ready' }))
  show(drive.bridge)
  await screen.findByText('Chưa có gì.')
  expect(screen.getByText('Thả tệp vào thư mục Atum Drive.')).toBeTruthy()
  expect(screen.queryByText('Mở cuộc trò chuyện với trợ lý để dùng các tệp này.')).toBeNull()
  const empty = screen.getByText('Chưa có gì.').closest('[data-matrix-drive-empty]') as HTMLElement
  expect(within(empty).queryByRole('button', { name: 'Hiện trong Finder' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Thêm thao tác Drive' }), { key: 'Enter' })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hiện trong Finder' }))
  await waitFor(() => expect(drive.reveal).toHaveBeenCalledOnce())
})

it('every state that needs the person has its own way forward', async () => {
  const cases = [
    { view: base({ state: 'reauthenticate' }), button: 'Thử lại', action: 'connect' },
    { view: base({ state: 'cleanup_failed' }), button: 'Thử lại', action: 'disconnect' },
    { view: base({ state: 'paused', rows: [] }), button: 'Tiếp tục', action: 'connect' },
    { view: base({ state: 'error' }), button: 'Thử lại', action: 'connect' },
    { view: base({ state: 'error', problem: 'not_allowed' }), button: 'Thử lại', action: 'connect' }
  ] as const

  for (const { view, button, action } of cases) {
    const drive = staticBridge(view)
    const rendered = show(drive.bridge)
    fireEvent.click(await screen.findByRole('button', { name: button }))
    await waitFor(() => expect(drive[action]).toHaveBeenCalledOnce())
    // Never "Connect" for these: each says what it does.
    expect(screen.queryByRole('button', { name: 'Bật Atum Drive' })).toBeNull()
    rendered.unmount()
  }
})

it('offers Try again, with the reason, when the folder was not the problem', async () => {
  const { bridge } = staticBridge(base({ state: 'error', problem: 'network' }))
  show(bridge, 'en')
  await screen.findByText('Couldn’t reach Atum Drive. Check your internet connection and try again.')
  expect(screen.getByRole('heading', { name: 'Drive isn’t on yet' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Turn on Atum Drive' })).toBeNull()
})

it('never leaves a stopped Drive at a bare “needs attention”: it says to try again', async () => {
  const { bridge } = staticBridge(base({ state: 'error' }))
  show(bridge)
  await screen.findByRole('heading', { name: 'Drive đã dừng' })
  expect(screen.getByText('Tệp của bạn vẫn được giữ nguyên. Hãy thử lại.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy()
})

it('says plainly when Drive is not open for this account', async () => {
  const { bridge } = staticBridge(base({ state: 'error', problem: 'not_allowed' }))
  show(bridge)
  await screen.findByText('Atum Drive chưa mở cho tài khoản này.')
  expect(screen.queryByText('Chưa kết nối được tới Atum Drive. Hãy kiểm tra kết nối mạng rồi thử lại.')).toBeNull()
})

it.each(['connecting', 'error', 'reauthenticate', 'offline'] as const)(
  'keeps a verified local list visible while Drive is %s',
  async state => {
    const drive = staticBridge(
      base({
        state,
        canBrowseLocally: true,
        listingStatus: 'stale',
        rows: [{ id: `${state}-file`, name: `${state}.txt`, kind: 'file', size: 14, modifiedAt: 0 }]
      })
    )

    show(drive.bridge, 'en')
    expect(await screen.findByRole('option', { name: `${state}.txt` })).toBeTruthy()
    expect(screen.getByText(matrixDriveCopy.en.status[state])).toBeTruthy()
    expect(screen.getByText('Showing the last known files on this Mac. Refresh to try again.')).toBeTruthy()
    expect(
      screen
        .getByRole('option', { name: `${state}.txt` })
        .closest('[data-matrix-drive-phase]')
        ?.getAttribute('data-matrix-drive-phase')
    ).toBe('files')
  }
)

it('keeps a verified local list visible during setup, and a retry only when it stopped', async () => {
  const starting = staticBridge(
    base({
      state: 'authorizing',
      canBrowseLocally: true,
      signInNeeded: true,
      rows: [{ id: 'local-sign-in', name: 'kept.txt', kind: 'file', size: 14, modifiedAt: 0 }]
    })
  )

  const startingSurface = show(starting.bridge, 'en')
  await screen.findByRole('option', { name: 'kept.txt' })
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()

  startingSurface.unmount()

  const retry = staticBridge(
    base({
      state: 'error',
      canBrowseLocally: true,
      rows: [{ id: 'local-retry', name: 'retry.txt', kind: 'file', size: 14, modifiedAt: 0 }]
    })
  )

  show(retry.bridge, 'en')
  await screen.findByRole('option', { name: 'retry.txt' })
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(retry.connect).toHaveBeenCalledOnce())
})

it('turns a signed-out issue into Try again beside a verified local list, never a sign-in', async () => {
  const drive = staticBridge(
    base({
      state: 'reauthenticate',
      canBrowseLocally: true,
      issues: [{ id: 'signed-out', code: 'signed_out' }],
      rows: [{ id: 'local-file', name: 'kept.txt', kind: 'file', size: 14, modifiedAt: 0 }]
    })
  )

  show(drive.bridge, 'en')
  await screen.findByRole('option', { name: 'kept.txt' })
  const retry = screen.getAllByRole('button', { name: 'Try again' })
  expect(retry.length).toBeGreaterThanOrEqual(1)
  expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
  fireEvent.click(retry[0])
  await waitFor(() => expect(drive.connect).toHaveBeenCalledOnce())
})

it('never shows browser-wait controls beside a verified local list', async () => {
  const drive = staticBridge(
    base({
      state: 'authorizing',
      canBrowseLocally: true,
      waitingForBrowser: true,
      rows: [{ id: 'local-file', name: 'kept.txt', kind: 'file', size: 14, modifiedAt: 0 }]
    })
  )

  show(drive.bridge, 'en')
  await screen.findByRole('option', { name: 'kept.txt' })
  expect(screen.queryByRole('button', { name: 'Open again' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  expect(drive.cancelSignIn).not.toHaveBeenCalled()
})

it('keeps local navigation and keyboard focus through a sync-only status update', async () => {
  let receive!: (view: MatrixDriveView) => void

  const ready = base({
    state: 'ready',
    revision: 10,
    canBrowseLocally: true,
    canGoBack: true,
    folderLabel: 'Projects',
    rows: [{ id: 'kept-row', name: 'kept.txt', kind: 'file', size: 14, modifiedAt: 0 }]
  })

  const bridge = {
    read: async () => ready,
    subscribe: (listener: typeof receive) => {
      receive = listener

      return () => {}
    }
  } as unknown as MatrixDriveBridge

  show(bridge, 'en')
  const row = await screen.findByRole('option', { name: 'kept.txt' })
  row.focus()
  await act(async () => receive({ ...ready, state: 'error', revision: 11, listingStatus: 'stale' }))

  expect(screen.getByRole('option', { name: 'kept.txt' })).toBe(row)
  expect(row.ownerDocument.activeElement).toBe(row)
  expect(screen.getByText('Projects')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
})

it('keeps first-connect setup as a hero until main grants local browsing', async () => {
  const drive = staticBridge(
    base({
      state: 'connecting',
      rows: [{ id: 'unverified', name: 'not-yet.txt', kind: 'file', size: 14, modifiedAt: 0 }]
    })
  )

  show(drive.bridge, 'en')
  await screen.findByRole('heading', { name: 'Getting your Drive ready — about a minute' })
  expect(screen.queryByRole('option', { name: 'not-yet.txt' })).toBeNull()
})

it('never calls a verified local folder empty before its first scan completes', async () => {
  const drive = staticBridge(base({ state: 'connecting', canBrowseLocally: true, listingStatus: 'loading' }))

  show(drive.bridge, 'en')
  expect(await screen.findByRole('status', { name: 'Updating files on this Mac…' })).toBeTruthy()
  expect(screen.queryByText('Nothing here yet.')).toBeNull()
})

it.each(['connecting', 'error', 'reauthenticate', 'offline'] as const)(
  'does not offer cloud task actions while locally browsing in %s',
  async state => {
    const drive = staticBridge(
      base({
        state,
        canBrowseLocally: true,
        rows: [
          { id: 'file', name: 'local.txt', kind: 'file', size: 14, modifiedAt: 0 },
          { id: 'folder', name: 'Local folder', kind: 'folder', size: 0, modifiedAt: 0 }
        ]
      })
    )

    const bridge = {
      ...drive.bridge,
      importPlan: vi.fn(),
      importRun: vi.fn(),
      importCancel: vi.fn()
    } as unknown as MatrixDriveBridge

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixDrive
          bridge={bridge}
          taskScope={{ userId: '@owner:test', deviceId: 'OWNER', roomId: '!assistant:test' }}
        />
      </I18nProvider>
    )

    await screen.findByRole('option', { name: 'local.txt' })
    expect(screen.queryByRole('button', { name: 'Let assistant read' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Let assistant edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save result here' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add to Drive' })).toBeNull()
  }
)

it('keeps the old error hero when an older main process does not provide local access', async () => {
  const drive = staticBridge(
    base({ state: 'error', rows: [{ id: 'legacy', name: 'legacy.txt', kind: 'file', size: 14, modifiedAt: 0 }] })
  )

  show(drive.bridge, 'en')
  await screen.findByRole('heading', { name: 'Drive stopped' })
  expect(screen.queryByRole('option', { name: 'legacy.txt' })).toBeNull()
})

it('withdraws local rows when main explicitly revokes local browsing', async () => {
  const drive = staticBridge(
    base({
      state: 'offline',
      canBrowseLocally: false,
      rows: [{ id: 'revoked', name: 'revoked.txt', kind: 'file', size: 14, modifiedAt: 0 }]
    })
  )

  show(drive.bridge, 'en')
  await screen.findByRole('heading', { name: 'Getting your Drive ready — about a minute' })
  expect(screen.queryByRole('option', { name: 'revoked.txt' })).toBeNull()
})

it('keeps the small print behind a quiet “About syncing”, passwords and keys first', async () => {
  for (const view of [base({}), base({ state: 'ready' })]) {
    const { bridge } = staticBridge(view)
    const rendered = show(bridge, 'en')
    const about = await screen.findByRole('button', { name: 'About syncing' })
    expect(about.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Passwords and private keys are never synced.')).toBeNull()
    fireEvent.click(about)
    expect(about.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Passwords and private keys are never synced.')).toBeTruthy()
    expect(screen.getByText('Each account has 1 GB of storage.')).toBeTruthy()
    expect(screen.getByText(/“token” in the name/)).toBeTruthy()
    rendered.unmount()
  }
})

it('puts every state and problem in plain words in every language, with the same shape as Vietnamese', () => {
  const shape = (value: unknown): unknown =>
    value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .map(([key, inner]) => [key, shape(inner)])
            .sort(([a], [b]) => String(a).localeCompare(String(b)))
        )
      : typeof value

  for (const copy of Object.values(matrixDriveCopy)) {
    expect(shape(copy)).toEqual(shape(matrixDriveCopy.vi))

    for (const words of [...Object.values(copy.problem), ...Object.values(copy.status), ...Object.values(copy.about)]) {
      expect(words.trim().length).toBeGreaterThan(1)
      expect(words).not.toMatch(/Hermes|Matrix|OpenCloud|candidate|OAuth|provider|endpoint/)
    }

    // No closed code leaks into the words (node_modules in the small print is a folder name).
    for (const words of [...Object.values(copy.problem), ...Object.values(copy.status)]) {
      expect(words).not.toContain('_')
    }

    // The primary copy never says "token"; only the small print names that exclusion.
    for (const words of [copy.hero.title, copy.hero.body, copy.waiting.title, copy.waiting.body, copy.gettingReady]) {
      expect(words).not.toMatch(/token/i)
    }

    expect(copy.location).toContain('{folder}')
    expect(copy.about.quota).toContain('1 GB')
    expect(copy.about.skipped).toContain('token')
  }
})

it('names a phase for every native state; a browser wait or sign-in is only a status row', () => {
  expect(matrixDrivePhase({ state: 'disconnected' })).toBe('off')
  expect(matrixDrivePhase({ state: 'disconnected', problem: 'folder_other_drive' })).toBe('notOn')
  expect(matrixDrivePhase({ state: 'authorizing', signInNeeded: true })).toBe('preparing')
  expect(matrixDrivePhase({ state: 'authorizing', waitingForBrowser: true })).toBe('preparing')
  expect(matrixDrivePhase({ state: 'reauthenticate', signInNeeded: true })).toBe('stopped')
  expect(matrixDrivePhase({ state: 'reauthenticate', waitingForBrowser: true })).toBe('stopped')
  expect(matrixDrivePhase({ state: 'connecting' })).toBe('preparing')
  expect(matrixDrivePhase({ state: 'disconnected', problem: 'folder_changed' })).toBe('folderRecovery')
  expect(matrixDrivePhase({ state: 'error', problem: 'network' })).toBe('notOn')
  expect(matrixDrivePhase({ state: 'error' })).toBe('stopped')

  for (const state of ['ready', 'syncing', 'paused', 'offline'] as const) {
    expect(matrixDrivePhase({ state })).toBe('files')
  }
})

/** A small Drive that really moves between folders, as main does: opaque ids, one listing at a time. */
function treeBridge(lastSyncAt = 1_000) {
  const folders: Record<string, { label?: string; parent?: string; rows: MatrixDriveView['rows'] }> = {
    root: {
      rows: [
        { id: 'h-reports', name: 'Reports', kind: 'folder', size: 0, modifiedAt: 500 },
        { id: 'h-agent', name: 'Agent Reports', kind: 'folder', size: 0, modifiedAt: 500 },
        { id: 'h-plan', name: 'plan.docx', kind: 'file', size: 48_200, modifiedAt: 900 },
        { id: 'h-new', name: 'new.md', kind: 'file', size: 10, modifiedAt: 2_000 }
      ]
    },
    'h-reports': {
      label: 'Reports',
      parent: 'root',
      rows: [{ id: 'h-q3', name: 'Q3.docx', kind: 'file', size: 88_000, modifiedAt: 400 }]
    },
    'h-agent': { label: 'Agent Reports', parent: 'root', rows: [] }
  }

  let at = 'root'
  let revision = 1

  const view = (): MatrixDriveView => ({
    state: 'ready',
    revision,
    lastSyncAt,
    canBrowseLocally: true,
    listingStatus: 'current',
    canGoBack: at !== 'root',
    folderLabel: folders[at]!.label,
    truncated: false,
    rows: folders[at]!.rows
  })

  const go = (id: string) => {
    at = id
    revision += 1

    return view()
  }

  const enter = vi.fn(async (id: string) => go(id))
  const back = vi.fn(async () => go(folders[at]!.parent ?? 'root'))
  const bridge = { read: async () => view(), subscribe: () => () => {}, enter, back } as unknown as MatrixDriveBridge

  return { bridge, enter, back }
}

function Finder({ bridge, onPreview }: { bridge: MatrixDriveBridge; onPreview?: () => void }) {
  const [destination, setDestination] = useState<MatrixDriveDestination>('all')

  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixDriveSidebar compact={false} current={destination} onSelect={setDestination} windowControls={null} />
      <MatrixDrive bridge={bridge} destination={destination} onDestinationChange={setDestination} onPreview={onPreview} />
    </I18nProvider>
  )
}

const sidebar = () => within(window.document.querySelector<HTMLElement>('[data-matrix-drive-sidebar]')!)

it('lays the sidebar out as Finder does: Recents, the Drive’s folders as Favorites, the Drive under Locations', async () => {
  const drive = treeBridge()
  render(<Finder bridge={drive.bridge} />)

  await screen.findByRole('heading', { name: 'Atum Drive' })
  expect(sidebar().getByText('Favorites')).toBeTruthy()
  expect(sidebar().getByText('Locations')).toBeTruthy()
  // Assistants' folders sit beside the owner's: nothing in the data tells them apart.
  expect(
    [...window.document.querySelectorAll('[data-matrix-drive-favorites] button')].map(button => button.textContent)
  ).toEqual(['Agent Reports', 'Reports'])
  expect(sidebar().getByRole('button', { name: 'Atum Drive' }).getAttribute('aria-current')).toBe('page')

  fireEvent.click(sidebar().getByRole('button', { name: 'Reports' }))
  await screen.findByRole('heading', { name: 'Reports' })
  expect(drive.enter).toHaveBeenCalledWith('h-reports')
  expect(sidebar().getByRole('button', { name: 'Reports' }).getAttribute('aria-current')).toBe('page')
  expect(sidebar().getByRole('button', { name: 'Atum Drive' }).getAttribute('aria-current')).toBeNull()

  // Another favourite goes up to the Drive first, then into that folder.
  fireEvent.click(sidebar().getByRole('button', { name: 'Agent Reports' }))
  await screen.findByRole('heading', { name: 'Agent Reports' })
  expect(drive.back).toHaveBeenCalledOnce()
  expect(drive.enter).toHaveBeenLastCalledWith('h-agent')

  fireEvent.click(sidebar().getByRole('button', { name: 'Recents' }))
  await screen.findByRole('heading', { name: 'Recents' })
  expect(sidebar().getByRole('button', { name: 'Recents' }).getAttribute('aria-current')).toBe('page')
  expect(screen.getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual([
    'new.md',
    'plan.docx',
    'Agent Reports',
    'Reports'
  ])
})

it('goes back and forward from the toolbar, as Finder’s ‹ › do', async () => {
  const drive = treeBridge()
  render(<Finder bridge={drive.bridge} />)

  await screen.findByRole('heading', { name: 'Atum Drive' })
  const back = screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement
  const forward = screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement
  expect(back.disabled).toBe(true)
  expect(forward.disabled).toBe(true)

  fireEvent.doubleClick(item('Reports'))
  await screen.findByRole('heading', { name: 'Reports' })
  expect(back.disabled).toBe(false)
  fireEvent.click(back)
  await screen.findByRole('heading', { name: 'Atum Drive' })
  expect(drive.back).toHaveBeenCalledOnce()
  // The folder you came out of is the one selected.
  expect(item('Reports').getAttribute('aria-selected')).toBe('true')
  await waitFor(() => expect(forward.disabled).toBe(false))
  fireEvent.click(forward)
  await screen.findByRole('heading', { name: 'Reports' })
  expect(drive.enter).toHaveBeenLastCalledWith('h-reports')
  expect(forward.disabled).toBe(true)
})

it('selects with a click, clears on empty space, and opens with a double-click', async () => {
  const drive = treeBridge()
  const onPreview = vi.fn()
  render(<Finder bridge={drive.bridge} onPreview={onPreview} />)

  await screen.findByRole('heading', { name: 'Atum Drive' })
  fireEvent.click(item('plan.docx'))
  expect(item('plan.docx').getAttribute('aria-selected')).toBe('true')
  fireEvent.click(item('Reports'))
  expect(item('plan.docx').getAttribute('aria-selected')).toBe('false')
  expect(item('Reports').getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('listbox'))
  expect(item('Reports').getAttribute('aria-selected')).toBe('false')
  expect(drive.enter).not.toHaveBeenCalled()
  expect(onPreview).not.toHaveBeenCalled()

  fireEvent.doubleClick(item('plan.docx'))
  expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'h-plan' }))
  fireEvent.doubleClick(item('Reports'))
  await screen.findByRole('heading', { name: 'Reports' })
  expect(drive.enter).toHaveBeenCalledWith('h-reports')
  expect(item('Q3.docx').getAttribute('aria-selected')).toBe('false')
})

it('moves, opens, previews and goes back from the keyboard, as Finder does', async () => {
  const drive = treeBridge()
  const onPreview = vi.fn()
  render(<Finder bridge={drive.bridge} onPreview={onPreview} />)

  await screen.findByRole('heading', { name: 'Atum Drive' })
  act(() => setMatrixDriveLayout('list'))
  const list = await screen.findByRole('listbox')
  // Name order: Agent Reports, new.md, plan.docx, Reports.
  fireEvent.keyDown(list, { key: 'ArrowDown' })
  expect(item('Agent Reports').getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(list, { key: 'ArrowDown' })
  fireEvent.keyDown(list, { key: 'ArrowDown' })
  expect(item('plan.docx').getAttribute('aria-selected')).toBe('true')
  expect(window.document.activeElement).toBe(item('plan.docx'))
  fireEvent.keyDown(list, { key: ' ' })
  expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'h-plan' }))
  fireEvent.keyDown(list, { key: 'Escape' })
  expect(item('plan.docx').getAttribute('aria-selected')).toBe('false')

  // Typing a name's first letters jumps to it; Return opens it.
  fireEvent.keyDown(list, { key: 'r' })
  expect(item('Reports').getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(list, { key: 'Enter' })
  await screen.findByRole('heading', { name: 'Reports' })
  expect(drive.enter).toHaveBeenCalledWith('h-reports')

  fireEvent.keyDown(screen.getByRole('listbox'), { key: '[', metaKey: true })
  await screen.findByRole('heading', { name: 'Atum Drive' })
  expect(drive.back).toHaveBeenCalledOnce()
  fireEvent.keyDown(screen.getByRole('listbox'), { key: ']', metaKey: true })
  await screen.findByRole('heading', { name: 'Reports' })
})

it('switches between icons and list, keeps the choice, and sorts the list from its headers', async () => {
  const drive = treeBridge()
  const first = render(<Finder bridge={drive.bridge} />)

  await screen.findByRole('heading', { name: 'Atum Drive' })
  expect(window.document.querySelector('[data-matrix-drive-browser]')?.getAttribute('data-matrix-drive-browser')).toBe(
    'icon'
  )
  expect(screen.queryByRole('button', { name: 'Size' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'List' }))
  expect(window.document.querySelector('[data-matrix-drive-browser]')?.getAttribute('data-matrix-drive-browser')).toBe(
    'list'
  )
  expect(screen.getByText('48 kB')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Size' }))
  expect(screen.getAllByRole('option').map(option => option.getAttribute('aria-label'))).toEqual([
    'plan.docx',
    'new.md',
    'Agent Reports',
    'Reports'
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Size' }))
  expect(screen.getAllByRole('option')[0]!.getAttribute('aria-label')).toBe('Agent Reports')

  first.unmount()
  render(<Finder bridge={drive.bridge} />)
  await screen.findByRole('heading', { name: 'Atum Drive' })
  expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true')
})

it.each(['icon', 'list'] as const)('badges each item with its sync state in the %s view', async layout => {
  setMatrixDriveLayout(layout)
  const drive = treeBridge(1_000)
  render(<Finder bridge={drive.bridge} />)

  await screen.findByRole('heading', { name: 'Atum Drive' })
  const badge = (name: string) => item(name).querySelector('[data-matrix-drive-sync]')?.getAttribute('data-matrix-drive-sync')
  expect(badge('plan.docx')).toBe('synced')
  // Changed after Drive last finished syncing: still waiting.
  expect(badge('new.md')).toBe('pending')
  const describedBy = item('new.md').getAttribute('aria-describedby')!
  expect(window.document.getElementById(describedBy)?.textContent).toBe('Waiting to sync')
})

it('shows no sync badge when Drive’s facts are stale', async () => {
  const drive = staticBridge(
    base({
      state: 'ready',
      factsStale: true,
      rows: [{ id: 'f', name: 'notes.txt', kind: 'file', size: 14, modifiedAt: 0 }]
    })
  )

  show(drive.bridge, 'en')
  expect((await screen.findByRole('option', { name: 'notes.txt' })).querySelector('[data-matrix-drive-sync]')).toBeNull()
})

it('cuts a long icon label in the middle and shows it whole once selected', async () => {
  const name = 'Impromptu Google Meeting (3).docx'
  const drive = staticBridge(base({ state: 'ready', rows: [{ id: 'f', name, kind: 'file', size: 14, modifiedAt: 0 }] }))

  show(drive.bridge, 'en')
  const option = await screen.findByRole('option', { name })
  expect(option.textContent).toContain('…')
  expect(option.textContent).toContain('(3).docx')
  fireEvent.click(option)
  expect(option.textContent).toContain(name)
})
