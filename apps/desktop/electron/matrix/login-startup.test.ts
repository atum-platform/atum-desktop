import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { App, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_LOGIN_STARTUP as channels } from '../../shared/matrix-login-startup'

import { requireMatrixCaller } from './ipc-policy'
import {
  fileLoginStartupMemory,
  LOGIN_ITEMS_SETTINGS_URL,
  loginStartupStatusFrom,
  MatrixLoginStartup,
  type MatrixLoginStartupMemory,
  type MatrixLoginStartupRecord,
  registerMatrixLoginStartupIpc
} from './login-startup'

/** macOS 13+ reports a ServiceManagement status, so its readings say the Login Items pane exists. */
const pane = { loginItemsPane: true } as const

function fixture(
  options: { platform?: NodeJS.Platform; packaged?: boolean; memory?: MatrixLoginStartupMemory } = {}
) {
  const settings = { openAtLogin: false, wasOpenedAtLogin: false, status: 'not-registered' as string | undefined }

  const app = {
    getLoginItemSettings: vi.fn(() => settings as ReturnType<App['getLoginItemSettings']>),
    setLoginItemSettings: vi.fn(({ openAtLogin }: { openAtLogin?: boolean }) => {
      settings.openAtLogin = openAtLogin === true
      settings.status = openAtLogin ? 'enabled' : 'not-registered'
    })
  }

  const openExternal = vi.fn(async () => {})

  const startup = new MatrixLoginStartup({
    app,
    openExternal,
    platform: options.platform ?? 'darwin',
    packaged: options.packaged ?? true,
    ...(options.memory ? { memory: options.memory } : {})
  })

  return { app, openExternal, settings, startup }
}

describe('device-local OS login startup', () => {
  it('reads current OS state without registering anything, including an external change', () => {
    const f = fixture()
    expect(f.app.getLoginItemSettings).not.toHaveBeenCalled()
    expect(f.startup.status()).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
    f.settings.openAtLogin = true
    f.settings.wasOpenedAtLogin = true
    f.settings.status = 'enabled'
    expect(f.startup.status()).toEqual({ state: 'enabled', wasOpenedAtLogin: true, ...pane })
    expect(f.app.getLoginItemSettings.mock.calls).toEqual([[], []])
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('enables and removes only this primary app through explicit booleans, with OS readback', () => {
    const f = fixture()
    expect(f.startup.setEnabled(true)).toEqual({ state: 'enabled', wasOpenedAtLogin: false, ...pane })
    expect(f.startup.setEnabled(false)).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
    expect(f.app.setLoginItemSettings.mock.calls).toEqual([[{ openAtLogin: true }], [{ openAtLogin: false }]])
    expect(f.app.getLoginItemSettings).toHaveBeenCalledTimes(4)
  })

  it('does not rewrite a matching OS choice or silently re-enable a disabled item', () => {
    const f = fixture()
    f.startup.setEnabled(false)
    f.startup.setEnabled(true)
    f.startup.setEnabled(true)
    f.settings.openAtLogin = false
    f.settings.status = 'not-registered'
    expect(f.startup.status().state).toBe('disabled')
    expect(f.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true })
  })

  it('reports actual macOS approval without claiming login activation and permits removal', () => {
    const f = fixture()
    f.settings.status = 'requires-approval'
    expect(f.startup.status()).toEqual({ state: 'requires_approval', wasOpenedAtLogin: false, ...pane })
    expect(f.startup.setEnabled(false)).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
    expect(f.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: false })
  })

  it('uses openAtLogin when an older macOS omits ServiceManagement status', () => {
    const f = fixture()
    f.settings.status = undefined
    expect(f.startup.status()).toEqual({ state: 'disabled', wasOpenedAtLogin: false })
    f.settings.openAtLogin = true
    expect(f.startup.status()).toEqual({ state: 'enabled', wasOpenedAtLogin: false })
  })

  it('does not mistake a silently ignored setter for success', () => {
    const f = fixture()
    f.app.setLoginItemSettings.mockImplementation(() => {})
    expect(f.startup.setEnabled(true)).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
  })

  it.each([
    { platform: 'linux' as const, packaged: true, reason: 'unsupported' },
    { platform: 'win32' as const, packaged: true, reason: 'unsupported' },
    { platform: 'darwin' as const, packaged: false, reason: 'development' }
  ])('never reads or writes login items in $reason ($platform)', options => {
    const f = fixture(options)
    expect(f.startup.status()).toEqual({ state: 'unavailable', reason: options.reason })
    expect(f.startup.setEnabled(true)).toEqual({ state: 'unavailable', reason: options.reason })
    expect(f.app.getLoginItemSettings).not.toHaveBeenCalled()
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('registers a never-registered app that macOS reports as not found (macOS 13+ first run)', () => {
    const f = fixture()
    // macOS 26 answers `not-found` for a main app with no Background Task record yet.
    f.settings.status = 'not-found'
    expect(f.startup.status()).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
    expect(f.startup.setEnabled(true)).toEqual({ state: 'enabled', wasOpenedAtLogin: false, ...pane })
    expect(f.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true })
  })

  it('stays off, not falsely on, when macOS still cannot find the service after enabling', () => {
    const f = fixture()
    f.settings.status = 'not-found'
    f.app.setLoginItemSettings.mockImplementation(() => {})
    expect(f.startup.setEnabled(true)).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
  })

  it('contains broken OS reads without disabling a real registration', () => {
    const f = fixture()
    f.app.getLoginItemSettings.mockImplementation(() => {
      throw new Error('/private/fixture/OS detail')
    })
    expect(f.startup.status()).toEqual({ state: 'unavailable', reason: 'os_error' })
    expect(f.startup.setEnabled(true)).toEqual({ state: 'unavailable', reason: 'os_error' })
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('opens only the fixed macOS Login Items pane, and nothing off a packaged Mac', async () => {
    const f = fixture()
    await f.startup.openSettings()
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith(LOGIN_ITEMS_SETTINGS_URL)

    for (const options of [{ platform: 'win32' as const }, { packaged: false }]) {
      const other = fixture(options)
      await expect(other.startup.openSettings()).rejects.toThrow('matrix_login_startup_unavailable')
      expect(other.openExternal).not.toHaveBeenCalled()
    }
  })

  it('never offers or opens the Login Items pane on a macOS without it (12 reports no status)', async () => {
    const f = fixture()
    f.settings.status = undefined
    expect(f.startup.status()).toEqual({ state: 'disabled', wasOpenedAtLogin: false })
    await expect(f.startup.openSettings()).rejects.toThrow('matrix_login_startup_unavailable')
    expect(f.openExternal).not.toHaveBeenCalled()
  })

  it('returns a closed write error, never the OS error detail', () => {
    const f = fixture()
    f.app.setLoginItemSettings.mockImplementation(() => {
      throw new Error('/private/fixture/OS detail')
    })
    expect(() => f.startup.setEnabled(true)).toThrow('matrix_login_startup_failed')
    expect(f.startup.status().state).toBe('disabled')
  })

  it.each([null, {}, { enabled: true, path: '/fixture/other-app' }, 'true', 1])(
    'rejects non-boolean renderer authority %j before OS access',
    value => {
      const f = fixture()
      expect(() => f.startup.setEnabled(value)).toThrow('matrix_login_startup_invalid')
      expect(f.app.getLoginItemSettings).not.toHaveBeenCalled()
      expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
    }
  )
})

describe('loginStartupStatusFrom (one OS read → Settings state)', () => {
  it.each([
    [{ status: 'enabled', openAtLogin: true, wasOpenedAtLogin: true }, { state: 'enabled', wasOpenedAtLogin: true, ...pane }],
    [{ status: 'requires-approval', openAtLogin: false }, { state: 'requires_approval', wasOpenedAtLogin: false, ...pane }],
    [{ status: 'not-registered', openAtLogin: false }, { state: 'disabled', wasOpenedAtLogin: false, ...pane }],
    [{ status: 'not-found', openAtLogin: false }, { state: 'disabled', wasOpenedAtLogin: false, ...pane }],
    // ServiceManagement status is the authority when present, even if openAtLogin disagrees.
    [{ status: 'not-registered', openAtLogin: true }, { state: 'disabled', wasOpenedAtLogin: false, ...pane }],
    // Older macOS: no status, so no Login Items pane either.
    [{ openAtLogin: true }, { state: 'enabled', wasOpenedAtLogin: false }],
    [{ openAtLogin: false }, { state: 'disabled', wasOpenedAtLogin: false }],
    [{}, { state: 'unavailable', reason: 'os_error' }],
    // A status a later macOS adds is not guessed at: openAtLogin decides, as on older macOS.
    [{ status: 'something-new', openAtLogin: true }, { state: 'enabled', wasOpenedAtLogin: false, ...pane }],
    [{ status: 'something-new' }, { state: 'unavailable', reason: 'os_error' }],
    [{ status: 3, openAtLogin: true }, { state: 'unavailable', reason: 'os_error' }],
    [{ status: 'enabled', wasOpenedAtLogin: 'yes' }, { state: 'enabled', wasOpenedAtLogin: false, ...pane }]
  ])('%j → %j', (reading, expected) => {
    expect(loginStartupStatusFrom(reading)).toEqual(expected)
  })
})

it('composes the actual main-frame caller fence before reading or writing OS state', async () => {
  const f = fixture()
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => unknown>()

  const ipc = {
    handle: vi.fn((name: string, handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown) => {
      handlers.set(name, handler)
    }),
    removeHandler: vi.fn()
  }

  const ui = { mainFrame: { url: 'file:///fixture/matrix.html' } }
  const event = { sender: ui, senderFrame: ui.mainFrame } as unknown as IpcMainInvokeEvent

  const dispose = registerMatrixLoginStartupIpc(ipc, f.startup, caller =>
    requireMatrixCaller(caller, ui, 'file:///fixture/matrix.html')
  )

  const foreign = { ...event, senderFrame: {} } as IpcMainInvokeEvent
  expect(() => handlers.get(channels.enabled)!(foreign, true)).toThrow('matrix_ipc_denied')
  expect(() => handlers.get(channels.status)!(foreign)).toThrow('matrix_ipc_denied')
  await expect(handlers.get(channels.openSettings)!(foreign)).rejects.toThrow('matrix_ipc_denied')
  expect(f.openExternal).not.toHaveBeenCalled()
  expect(f.app.getLoginItemSettings).not.toHaveBeenCalled()
  expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
  expect(await handlers.get(channels.status)!(event)).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
  expect(await handlers.get(channels.enabled)!(event, true)).toEqual({ state: 'enabled', wasOpenedAtLogin: false, ...pane })
  await handlers.get(channels.openSettings)!(event)
  expect(f.openExternal).toHaveBeenCalledExactlyOnceWith(LOGIN_ITEMS_SETTINGS_URL)
  expect(() => handlers.get(channels.acknowledge)!(foreign)).toThrow('matrix_ipc_denied')
  await handlers.get(channels.acknowledge)!(event)
  dispose()
  expect(ipc.removeHandler.mock.calls).toEqual([
    [channels.status],
    [channels.enabled],
    [channels.openSettings],
    [channels.acknowledge]
  ])
})

/** This Mac's memory of the default, in memory: `record` is what a relaunch would read. */
function memory(initial: MatrixLoginStartupRecord = {}) {
  const box = { record: { ...initial }, unreadable: false, unwritable: false }

  const value: MatrixLoginStartupMemory = {
    read: vi.fn(() => {
      if (box.unreadable) {
        throw new Error('unreadable')
      }

      return { ...box.record }
    }),
    write: vi.fn((record: MatrixLoginStartupRecord) => {
      if (box.unwritable) {
        throw new Error('unwritable')
      }

      box.record = { ...record }
    })
  }

  return { box, value }
}

describe('open at login is on by default, once per Mac (owner 2026-10-05)', () => {
  /** A Mac where macOS has never registered Atum's login item (macOS 13+ answers not-found):
   * a new install, or one upgrading that never touched the setting. */
  const fresh = (initial?: MatrixLoginStartupRecord) => {
    const m = memory(initial)
    const f = fixture({ memory: m.value })
    f.settings.status = 'not-found'

    return { ...f, memory: m }
  }

  it('turns it on at the first launch, says so once, and never asks the OS again', () => {
    const f = fresh()
    expect(f.startup.applyDefault()).toEqual({ state: 'enabled', wasOpenedAtLogin: false, announce: true, ...pane })
    expect(f.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true })
    expect(f.startup.status()).toEqual({ state: 'enabled', wasOpenedAtLogin: false, announce: true, ...pane })

    // Seen: the line is gone, the switch stays on.
    f.startup.acknowledge()
    expect(f.startup.status()).toEqual({ state: 'enabled', wasOpenedAtLogin: false, ...pane })

    // Every later launch.
    f.startup.applyDefault()
    f.startup.applyDefault()
    expect(f.app.setLoginItemSettings).toHaveBeenCalledOnce()
  })

  it('never turns it back on after the person turns it off', () => {
    const f = fresh()
    f.startup.applyDefault()
    expect(f.startup.setEnabled(false)).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
    expect(f.memory.box.record).toEqual({ decided: true, announce: false })

    // Even if macOS later forgets the record and answers not-found again.
    f.settings.status = 'not-found'
    expect(f.startup.applyDefault()).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
    expect(f.app.setLoginItemSettings.mock.calls).toEqual([[{ openAtLogin: true }], [{ openAtLogin: false }]])
  })

  it('a choice made in Settings before the default ran is the person’s, and stands', () => {
    const f = fresh()
    f.startup.setEnabled(true)
    f.startup.setEnabled(false)
    f.settings.status = 'not-found'
    f.startup.applyDefault()
    expect(f.app.setLoginItemSettings.mock.calls).toEqual([[{ openAtLogin: true }], [{ openAtLogin: false }]])
  })

  it.each([
    ['turned off before (not registered)', 'not-registered', 'disabled'],
    ['already on', 'enabled', 'enabled'],
    ['waiting for the person’s approval in macOS', 'requires-approval', 'requires_approval']
  ])('leaves a login item that is %s alone, for good', (_case, status, state) => {
    const f = fresh()
    f.settings.status = status
    f.settings.openAtLogin = status === 'enabled'
    expect(f.startup.applyDefault()).toEqual({ state, wasOpenedAtLogin: false, ...pane })
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(f.memory.box.record).toEqual({ decided: true, announce: false })
  })

  it('leaves an older macOS off: without a status it can’t tell never-set from turned off', () => {
    const f = fresh()
    f.settings.status = undefined
    expect(f.startup.applyDefault()).toEqual({ state: 'disabled', wasOpenedAtLogin: false })
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('turns nothing on when this Mac can’t remember that it did', () => {
    const unreadable = fresh()
    unreadable.memory.box.unreadable = true
    unreadable.startup.applyDefault()
    expect(unreadable.app.setLoginItemSettings).not.toHaveBeenCalled()

    const unwritable = fresh()
    unwritable.memory.box.unwritable = true
    unwritable.startup.applyDefault()
    expect(unwritable.app.setLoginItemSettings).not.toHaveBeenCalled()

    // And without any memory at all (a caller that didn't give one).
    const none = fixture()
    none.settings.status = 'not-found'
    none.startup.applyDefault()
    expect(none.app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('announces nothing when macOS asks for approval instead, or the OS write fails', () => {
    const approval = fresh()
    approval.app.setLoginItemSettings.mockImplementation(() => {
      approval.settings.status = 'requires-approval'
    })
    expect(approval.startup.applyDefault()).toEqual({ state: 'requires_approval', wasOpenedAtLogin: false, ...pane })
    expect(approval.memory.box.record).toEqual({ decided: true, announce: false })

    // Tried once, recorded first: a failed write is not retried at the next launch.
    const failing = fresh()
    failing.app.setLoginItemSettings.mockImplementation(() => {
      throw new Error('/private/fixture/OS detail')
    })
    expect(failing.startup.applyDefault()).toEqual({ state: 'disabled', wasOpenedAtLogin: false, ...pane })
    failing.startup.applyDefault()
    expect(failing.app.setLoginItemSettings).toHaveBeenCalledOnce()
  })

  it.each([
    { platform: 'win32' as const, packaged: true },
    { platform: 'darwin' as const, packaged: false }
  ])('never registers or records anything off a packaged Mac (%o)', options => {
    const m = memory()
    const f = fixture({ ...options, memory: m.value })
    f.settings.status = 'not-found'
    expect(f.startup.applyDefault().state).toBe('unavailable')
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(m.value.write).not.toHaveBeenCalled()
  })

  it('keeps the record in a file in this Mac’s app data, and reads a broken one as unreadable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'atum-login-startup-'))

    try {
      const file = path.join(dir, 'nested', 'login-startup.json')
      const kept = fileLoginStartupMemory(file)
      expect(kept.read()).toEqual({})
      kept.write({ decided: true, announce: true })
      expect(fileLoginStartupMemory(file).read()).toEqual({ decided: true, announce: true })

      writeFileSync(file, '{ not json')
      expect(() => kept.read()).toThrow()

      // A broken record turns nothing on.
      const f = fixture({ memory: kept })
      f.settings.status = 'not-found'
      f.startup.applyDefault()
      expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
