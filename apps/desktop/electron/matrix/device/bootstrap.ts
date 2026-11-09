/**
 * The device-service bootstrap (WS-4): how Electron main starts, fences and stops the Mac device runtime.
 *
 * Two rules from the program plan (§4.2 A-2, §5 WS-4) live here so main cannot get them wrong:
 *
 * 1. **The device service starts on a hidden login launch.** Open at login is on by default, so after a
 *    reboot Atum is usually launched by macOS with no window shown. Reach-down must still work then
 *    ("reboot a Mac, log in without opening Atum's window; the device service reconnects and a pending
 *    follow-up completes", plan §8.2 Stage B). So the service starts when the *account* is ready — the
 *    same point main starts its SDK — and nothing here waits for, or is triggered by, a window.
 * 2. **The sign-out Stop fence runs before the operation lock.** Main refuses most UI requests with
 *    `matrix_operation_pending` while another operation runs. The fence must not be behind that check:
 *    a pending operation would otherwise keep a device command running after the owner pressed sign-out.
 *    `deviceFenceBeforeOperationLock` names the requests that fence first (with a local Stop); main calls
 *    it right after its caller check, before any await and before `anyOperation()`, and fences again
 *    with `sign_out` inside the sign-out itself.
 *
 * Electron-free apart from types, so it is tested whole (`bootstrap.test.ts`).
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { MATRIX_DEVICE_IPC, parseMatrixDeviceAction } from './bridge'
import type { DeviceRuntime } from './runtime'
import type { DeviceService } from './service'
import type { StopReason } from './stop'

/** How this process was launched, read once at startup from `app.getLoginItemSettings()`. */
export type DeviceLaunch = 'login_hidden' | 'interactive'

/** `wasOpenedAtLogin` is the only part of the OS read trusted here; anything else is interactive. */
export function deviceLaunchFrom(reading: { wasOpenedAtLogin?: unknown } | null | undefined): DeviceLaunch {
  return reading?.wasOpenedAtLogin === true ? 'login_hidden' : 'interactive'
}

/**
 * The UI requests that fence the device before main's operation lock is consulted. Sign-out is the
 * one the plan names (WS-3b found the fence below `anyOperation()`); WS-3b's account-switch request
 * kind joins it at assembly (A-2). The fence runs even when main then refuses the request as
 * `matrix_operation_pending`: the owner asked to leave, so no device command may keep running on their
 * behalf.
 *
 * It is a **local Stop**, not `sign_out`: the request may still be refused, and a `sign_out` fence
 * marks the live connections fenced without sending `Stop` or closing them, which would leave
 * reach-down refusing every later turn as `stale_connection` while the controller never learns why.
 * A local Stop kills, voids approvals and ends grants just as synchronously, keeps the connection and
 * tells the controller. Main fences again with `sign_out` once the sign-out is really under way.
 */
export function deviceFenceBeforeOperationLock(kind: unknown): StopReason | null {
  return kind === 'signOut' ? 'local_stop' : null
}

/** Main calls this synchronously after authenticating the UI caller. */
export function fenceDeviceBeforeOperationLock(kind: unknown, fence: ((reason: StopReason) => void) | null): void {
  const reason = deviceFenceBeforeOperationLock(kind)

  if (reason) {fence?.(reason)}
}

/** WS-3b's `DeviceConnection`, as far as the bootstrap uses it (`DeviceService` is its `DeviceFrameSink`). */
export interface DeviceConnectionPort {
  attach(sink: DeviceService): void
  start(): void
}

export interface DeviceBootstrapDeps {
  /** Builds the runtime once (`createDeviceRuntime` with main's environment). */
  createRuntime(): DeviceRuntime
  /** WS-3b's connection for the enrolled device service, or null before enrollment. */
  connection(): DeviceConnectionPort | null
  /** `registerMatrixDeviceStopFence` in main. */
  registerFence(fence: ((reason: StopReason) => void) | null): void
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  /** Main's exact UI main-frame caller check (`requireMatrixCaller`). */
  requireCaller(event: IpcMainInvokeEvent): void
  log(line: string): void
}

export class DeviceServiceBootstrap {
  private runtime?: DeviceRuntime
  private attachedTo?: DeviceConnectionPort
  private running?: Promise<void>
  private installed = false

  constructor(private readonly deps: DeviceBootstrapDeps) {}

  /**
   * Once, at the top of main's `start()`, before any window exists: the fence is callable from the
   * first sign-out or sleep, and the Settings bridge answers (status reads "not running" until ready).
   */
  install(): void {
    if (this.installed) {
      return
    }

    this.installed = true
    const runtime = this.ensureRuntime()
    this.deps.registerFence(reason => runtime.fence(reason))
    this.deps.ipc.handle(MATRIX_DEVICE_IPC, (event, input: unknown) => {
      this.deps.requireCaller(event)
      const request = parseMatrixDeviceAction(input)

      if (!request) {
        throw new Error('device_request_invalid')
      }

      return runtime.request(request)
    })
  }

  /**
   * The account is ready (main has started its SDK), in every launch mode. On a hidden login launch no
   * window is ever shown and this is still the trigger; nothing waits for the UI. Idempotent while
   * running. A connection that appears later (enrollment finished) is attached by calling this again.
   */
  accountReady(launch: DeviceLaunch): Promise<void> {
    const runtime = this.ensureRuntime()

    this.running ??= runtime.start().then(
      () => this.deps.log(`[Device] service started launch=${launch}`),
      error => {
        this.running = undefined
        this.deps.log('[Device] service start failed')
        throw error
      }
    )

    return this.running.then(() => this.attach(runtime))
  }

  /**
   * An owner approval is up: the GUI broker refuses actions until it is gone, so an agent driving this Mac cannot
   * press anything meanwhile. The device runtime's own approvals do this themselves; an approval that starts
   * elsewhere (the browser import's Touch ID) reaches the same switch here.
   */
  setPaused(paused: boolean): void {
    this.runtime?.service.setPaused(paused)
  }

  /** Main-owned subscription action; no renderer-supplied model list reaches the device service. */
  configureChatGptRelay(enabled: boolean, models?: readonly string[]): void {
    this.ensureRuntime().configureChatGptRelay(enabled, models)
  }

  /** After sign-out (the fence already ran first): stop everything; the next `accountReady` starts again. */
  async signedOut(): Promise<void> {
    const running = this.running
    this.running = undefined
    this.attachedTo = undefined
    await running?.catch(() => undefined)
    await this.runtime?.stop()
  }

  /** Quit. */
  async dispose(): Promise<void> {
    if (this.installed) {
      this.deps.ipc.removeHandler(MATRIX_DEVICE_IPC)
      this.deps.registerFence(null)
      this.installed = false
    }

    await this.signedOut()
  }

  private ensureRuntime(): DeviceRuntime {
    this.runtime ??= this.deps.createRuntime()

    return this.runtime
  }

  private attach(runtime: DeviceRuntime): void {
    const connection = this.deps.connection()

    if (!connection || connection === this.attachedTo) {
      return
    }

    // The service takes over admission before the connection dials, so no frame meets the refusing default.
    connection.attach(runtime.service)
    this.attachedTo = connection
    connection.start()
  }
}
