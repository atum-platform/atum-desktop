import { describe, expect, it, vi } from 'vitest'

import {
  createMatrixOpenSourceNotices,
  MATRIX_NOTICE_FILE,
  type MatrixNoticesWindow,
  matrixNoticesWindowOptions,
  parseMatrixNoticesTitle
} from './open-source-notices'

function fakeWindow() {
  const listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>()
  const contents = new Map<string, ((event: { preventDefault(): void }) => void)[]>()
  let destroyed = false
  let openHandler: (() => { action: 'deny' }) | undefined

  const add = (map: typeof listeners, event: string, listener: (event: { preventDefault(): void }) => void) => {
    map.set(event, [...(map.get(event) ?? []), listener])
  }

  const window = {
    isDestroyed: () => destroyed,
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => {
      destroyed = true

      for (const listener of listeners.get('closed') ?? []) {
        listener({ preventDefault() {} })
      }
    }),
    setTitle: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => add(listeners, event, listener)),
    on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) =>
      add(listeners, event, listener)
    ),
    loadFile: vi.fn(async () => {}),
    webContents: {
      setWindowOpenHandler: vi.fn((handler: () => { action: 'deny' }) => {
        openHandler = handler
      }),
      on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) =>
        add(contents, event, listener)
      )
    }
  }

  const emit = (map: typeof listeners, event: string) => {
    const preventDefault = vi.fn()

    for (const listener of map.get(event) ?? []) {
      listener({ preventDefault })
    }

    return preventDefault
  }

  return {
    window: window as unknown as MatrixNoticesWindow & typeof window,
    emitWindow: (event: string) => emit(listeners, event),
    emitContents: (event: string) => emit(contents, event),
    openHandler: () => openHandler?.()
  }
}

describe('Settings › Legal › Open-source licences', () => {
  it('opens the packaged notice, and only it, in a locked-down window of the app', async () => {
    const fake = fakeWindow()
    const create = vi.fn(() => fake.window)
    const notices = createMatrixOpenSourceNotices({ directory: '/App/Resources/licenses', create, exists: () => true })

    await notices.open('Open-source licences')

    expect(create).toHaveBeenCalledWith(matrixNoticesWindowOptions('Open-source licences'))
    expect(fake.window.loadFile).toHaveBeenCalledWith(`/App/Resources/licenses/${MATRIX_NOTICE_FILE}`)
    expect(fake.openHandler()).toEqual({ action: 'deny' })
    expect(fake.emitContents('will-navigate')).toHaveBeenCalled()
    expect(fake.emitContents('will-attach-webview')).toHaveBeenCalled()
    expect(fake.emitWindow('page-title-updated')).toHaveBeenCalled()
    fake.emitWindow('ready-to-show')
    expect(fake.window.show).toHaveBeenCalled()
  })

  it('runs no script and no preload, and keeps nothing between launches', () => {
    const { webPreferences } = matrixNoticesWindowOptions('Licences')

    expect(webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true
    })
    expect(webPreferences?.preload).toBeUndefined()
    expect(webPreferences?.partition?.startsWith('persist:')).toBe(false)
  })

  it('brings the open window forward instead of opening a second', async () => {
    const fake = fakeWindow()
    const create = vi.fn(() => fake.window)
    const notices = createMatrixOpenSourceNotices({ directory: '/App/Resources/licenses', create, exists: () => true })

    await notices.open('Open-source licences')
    await notices.open('Giấy phép mã nguồn mở')

    expect(create).toHaveBeenCalledOnce()
    expect(fake.window.setTitle).toHaveBeenCalledWith('Giấy phép mã nguồn mở')
    expect(fake.window.focus).toHaveBeenCalled()

    fake.window.close()
    await notices.open('Open-source licences')
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('says the notice is unavailable where none was packaged', async () => {
    const create = vi.fn()

    await expect(
      createMatrixOpenSourceNotices({ directory: undefined, create, exists: () => true }).open('Licences')
    ).rejects.toThrow('matrix_notices_unavailable')
    await expect(
      createMatrixOpenSourceNotices({ directory: '/dev/licenses', create, exists: () => false }).open('Licences')
    ).rejects.toThrow('matrix_notices_unavailable')
    expect(create).not.toHaveBeenCalled()
  })

  it('closes the window again when the notice cannot load', async () => {
    const fake = fakeWindow()
    fake.window.loadFile.mockRejectedValueOnce(new Error('ERR_FILE_NOT_FOUND'))

    const notices = createMatrixOpenSourceNotices({
      directory: '/App/Resources/licenses',
      create: () => fake.window,
      exists: () => true
    })

    await expect(notices.open('Licences')).rejects.toThrow('ERR_FILE_NOT_FOUND')
    expect(fake.window.close).toHaveBeenCalled()
  })

  it.each([undefined, '', '   ', 'x'.repeat(121), 'Line\nbreak', 42])('refuses the title %j', value => {
    expect(() => parseMatrixNoticesTitle(value)).toThrow('matrix_command_invalid')
  })
})
