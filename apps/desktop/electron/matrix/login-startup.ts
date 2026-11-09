import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { App, IpcMain, IpcMainInvokeEvent, Shell } from 'electron'

import { MATRIX_LOGIN_STARTUP as channels, type MatrixLoginStartupStatus } from '../../shared/matrix-login-startup'

/** System Settings › General › Login Items (macOS 13+), the pane SMAppService itself opens. */
export const LOGIN_ITEMS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'

/** What this Mac remembers about open at login, beside the OS's own record: `decided`, the
 * default has had its one chance (applied, or found already on, pending, turned off or not
 * applicable) or the person chose in Settings; `announce`, Atum turned it on by itself and the
 * person hasn't acknowledged the line saying so. */
export interface MatrixLoginStartupRecord {
  decided?: boolean
  announce?: boolean
}

/** Device-local memory for the default. `read` throws when the record can't be read (nothing
 * is then turned on); a missing record reads as `{}`. `write` throws when it can't be kept. */
export interface MatrixLoginStartupMemory {
  read(): MatrixLoginStartupRecord
  write(record: MatrixLoginStartupRecord): void
}

interface Options {
  app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>
  openExternal: Shell['openExternal']
  platform: NodeJS.Platform
  packaged: boolean
  memory?: MatrixLoginStartupMemory
}

/** The record in a small JSON file in this Mac's app data (never synced with the account). */
export function fileLoginStartupMemory(file: string): MatrixLoginStartupMemory {
  return {
    read() {
      let text: string

      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return {}
        }

        throw error
      }

      const value = JSON.parse(text) as unknown

      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('matrix_login_startup_record_invalid')
      }

      const record = value as Record<string, unknown>

      return { decided: record.decided === true, announce: record.announce === true }
    },
    write(record) {
      mkdirSync(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ decided: record.decided === true, announce: record.announce === true }))
      renameSync(temporary, file)
    }
  }
}

/** The part of Electron's read this projection trusts; everything else is ignored. */
export interface LoginItemReading {
  openAtLogin?: unknown
  wasOpenedAtLogin?: unknown
  status?: unknown
}

/**
 * Pure projection of one OS read into the Settings row's state.
 *
 * On macOS 13+ Electron reports `SMAppService.mainApp.status`. For a main app that has never
 * been registered, macOS reports `not-found` (there is no Background Task record yet), not
 * `not-registered` — observed on macOS 26 with an unregistered signed bundle. Both mean
 * "off, and registerable"; treating `not-found` as unavailable locked the switch forever,
 * because only a registration creates the record that would change the answer. If macOS
 * still cannot find the service after an explicit enable, the readback stays `disabled`
 * and the row reports that the change was not confirmed.
 */
export function loginStartupStatusFrom(reading: LoginItemReading): MatrixLoginStartupStatus {
  const wasOpenedAtLogin = reading.wasOpenedAtLogin === true
  // A ServiceManagement status at all means macOS 13+, where the Login Items pane exists.
  const pane = typeof reading.status === 'string' ? { loginItemsPane: true as const } : {}

  switch (reading.status) {
    case 'enabled':
      return { state: 'enabled', wasOpenedAtLogin, ...pane }

    case 'requires-approval':
      return { state: 'requires_approval', wasOpenedAtLogin, ...pane }

    case 'not-registered':

    case 'not-found':
      return { state: 'disabled', wasOpenedAtLogin, ...pane }

    default:
      // Older macOS omits ServiceManagement status, and a status a later macOS adds is not
      // ours to guess: openAtLogin, its documented truth, decides both.
      return typeof reading.openAtLogin === 'boolean' && (reading.status === undefined || pane.loginItemsPane)
        ? { state: reading.openAtLogin ? 'enabled' : 'disabled', wasOpenedAtLogin, ...pane }
        : { state: 'unavailable', reason: 'os_error' }
  }
}

/** No constructor or quit write. The OS login item changes only through the person's own
 * setEnabled, or once per Mac through applyDefault (open at login is on by default; owner
 * decision 2026-10-05). Electron's default mainAppService chooses this bundle; no
 * helper/watchdog is registered. In particular, this registration does not promise to
 * relaunch a crashed main process. */
export class MatrixLoginStartup {
  constructor(private readonly options: Options) {}

  private remembered(): MatrixLoginStartupRecord | null {
    try {
      return this.options.memory?.read() ?? null
    } catch {
      return null
    }
  }

  private remember(record: MatrixLoginStartupRecord): boolean {
    try {
      this.options.memory?.write(record)

      return Boolean(this.options.memory)
    } catch {
      return false
    }
  }

  /**
   * Open at login is on by default, once per Mac, at the first launch of an installed build
   * (a new install, or an existing one upgrading to this version). Only a login item macOS
   * has never registered for Atum (macOS 13+ reports `not-found`) is turned on: one already on
   * or waiting for approval is left alone, one the person turned off (`not-registered`, or off
   * in System Settings) is never turned back on, and an older macOS that can't tell is left
   * off. The choice is recorded before the OS is asked, so it is tried at most once; a record
   * that can't be read or kept turns nothing on. After this, only the person's own switch in
   * Settings changes it. When it did turn on, the window says so once (`announce`).
   */
  applyDefault(): MatrixLoginStartupStatus {
    const gated = this.gate()

    if (gated) {
      return gated
    }

    const remembered = this.remembered()

    if (!remembered || remembered.decided) {
      return this.status()
    }

    let reading: LoginItemReading

    try {
      reading = this.options.app.getLoginItemSettings()
    } catch {
      return { state: 'unavailable', reason: 'os_error' }
    }

    if (loginStartupStatusFrom(reading).state === 'unavailable') {
      return this.status()
    }

    if (!this.remember({ decided: true, announce: false }) || reading.status !== 'not-found') {
      return this.status()
    }

    try {
      this.options.app.setLoginItemSettings({ openAtLogin: true })
    } catch {
      return this.status()
    }

    const after = this.status()

    if (after.state === 'enabled' && this.remember({ decided: true, announce: true })) {
      return { ...after, announce: true }
    }

    return after
  }

  /** The person has seen the line saying Atum turned this on by itself. */
  acknowledge(): void {
    if (this.remembered()?.announce) {
      this.remember({ decided: true, announce: false })
    }
  }

  private gate(): MatrixLoginStartupStatus | null {
    if (this.options.platform !== 'darwin') {
      return { state: 'unavailable', reason: 'unsupported' }
    }

    // A development Electron bundle must never become the owner's login item.
    if (!this.options.packaged) {
      return { state: 'unavailable', reason: 'development' }
    }

    return null
  }

  status(): MatrixLoginStartupStatus {
    const gated = this.gate()

    if (gated) {
      return gated
    }

    let current: MatrixLoginStartupStatus

    try {
      current = loginStartupStatusFrom(this.options.app.getLoginItemSettings())
    } catch {
      return { state: 'unavailable', reason: 'os_error' }
    }

    // Said only while it is still on: turned off meanwhile, there is nothing to tell.
    return current.state === 'enabled' && this.remembered()?.announce ? { ...current, announce: true } : current
  }

  setEnabled(enabled: unknown): MatrixLoginStartupStatus {
    if (typeof enabled !== 'boolean') {
      throw new Error('matrix_login_startup_invalid')
    }

    const before = this.status()

    if (before.state === 'unavailable') {
      return before
    }

    // The person chose: the default never applies after this, and nothing is left to announce.
    this.remember({ decided: true, announce: false })

    if ((enabled && before.state === 'enabled') || (!enabled && before.state === 'disabled')) {
      return before
    }

    try {
      this.options.app.setLoginItemSettings({ openAtLogin: enabled })
    } catch {
      throw new Error('matrix_login_startup_failed')
    }

    // A void setter is not success evidence. macOS may refuse or require approval.
    return this.status()
  }

  /** Only the fixed Login Items pane, only where a login item can exist, and only on a macOS
   * that has that pane (13+, which reports a ServiceManagement status): on macOS 12 the link
   * would open System Preferences somewhere else. */
  async openSettings(): Promise<void> {
    const current = this.status()

    if (current.state === 'unavailable' || !current.loginItemsPane) {
      throw new Error('matrix_login_startup_unavailable')
    }

    await this.options.openExternal(LOGIN_ITEMS_SETTINGS_URL)
  }
}

/** Main supplies the existing exact UI/main-frame caller fence, not an SDK identity. */
export function registerMatrixLoginStartupIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  startup: MatrixLoginStartup,
  requireCaller: (event: IpcMainInvokeEvent) => void
): () => void {
  ipc.handle(channels.status, event => {
    requireCaller(event)

    return startup.status()
  })
  ipc.handle(channels.enabled, (event, enabled: unknown) => {
    requireCaller(event)

    return startup.setEnabled(enabled)
  })
  ipc.handle(channels.openSettings, async event => {
    requireCaller(event)

    await startup.openSettings()
  })
  ipc.handle(channels.acknowledge, event => {
    requireCaller(event)

    startup.acknowledge()
  })

  return () => {
    ipc.removeHandler(channels.status)
    ipc.removeHandler(channels.enabled)
    ipc.removeHandler(channels.openSettings)
    ipc.removeHandler(channels.acknowledge)
  }
}
