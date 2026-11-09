import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

import type { DiagnosticError, ProductEvent, TurnObservation } from '../../shared/atum-observability'
import {
  MATRIX_DESKTOP_SERVICES as channels,
  type MatrixDesktopServicesStatus
} from '../../shared/matrix-desktop-services'
import { AtumObservability, type ReportingSink } from '../atum-observability'
import { createReportingSink } from '../atum-reporting-sinks'
import { loadOrCreateInstallationId } from '../desktop-installation'
import { type DesktopServicesConfig, readDesktopServicesConfig } from '../desktop-services-config'
import {
  createDesktopUpdateDiskPreflight,
  createDesktopUpdateSettings,
  createShipItOperationLease,
  recoverPendingShipItInstall,
  retireLegacyShipItState,
  sweepLegacyShipItQuarantines,
  sweepOrphanedShipItTemporaryDirectories,
  trustedUpdateNotes
} from '../desktop-update-settings'
import {
  createDesktopUpdater,
  type DesktopUpdateNotes,
  type DesktopUpdaterLogger,
  type DesktopUpdateSettings,
  type ElectronUpdaterPort,
  type NativeUpdaterPort
} from '../desktop-updater'

/** One instance owned by the Matrix main process, never by a room or SDK host. */
export class MatrixDesktopServices {
  private readonly reporting: AtumObservability
  private readonly updater: ReturnType<typeof createDesktopUpdater>
  private readonly started = Date.now()
  private shellReady = false
  private syncReady = false
  private restarting = false
  private previousBusy = false
  private pendingMessages = 0

  constructor(
    private readonly options: {
      configPath: string
      applicationIdentifier?: string
      home?: string
      userData: string
      version: string
      revision: string
      packaged: boolean
      supported: boolean
      busy: () => boolean
      quit: () => void
      beforeInstall?: () => void
      forceExit?: () => void
      previousRestart?: { outcome: 'updated' | 'not_updated' } | null
      restartFeedback?: { begin(toVersion: string): void; cancel(): void; fail(): void }
      bundlePath?: string
      temporaryPath?: string
      resetClosing: () => void
      changed: (status: MatrixDesktopServicesStatus) => void
      loadUpdater: () => Promise<ElectronUpdaterPort>
      nativeUpdater: NativeUpdaterPort
      locale?: () => string
      updateSettings?: DesktopUpdateSettings
      updateNotes?: DesktopUpdateNotes
      updaterLogger?: DesktopUpdaterLogger
      setInterval: (callback: () => void, delay: number) => unknown
      log: (message: string) => void
      createSink?: (options: Parameters<typeof createReportingSink>[0]) => ReportingSink
    }
  ) {
    let config: DesktopServicesConfig = {
      observability: null,
      updateFeedUrl: null
    }

    try {
      config = readDesktopServicesConfig(options.configPath)
    } catch {
      options.log('[Matrix] Desktop services configuration is invalid')
    }

    let installationId: string

    try {
      installationId = loadOrCreateInstallationId(path.join(options.userData, 'desktop-installation.json'))
    } catch {
      // An unwritable diagnostic identity must never prevent account startup.
      installationId = randomUUID()
      config.observability = null
      options.log('[Matrix] Reporting identity could not be persisted')
    }

    this.reporting = new AtumObservability({
      installationId,
      settingsPath: path.join(options.userData, 'reporting-preference.json'),
      version: options.version,
      revision: options.revision,
      config: config.observability,
      packaged: options.packaged,
      composition: 'matrix',
      createSink: (enabled, id) =>
        (options.createSink ?? createReportingSink)({
          config: config.observability!,
          enabled,
          id,
          version: options.version,
          revision: options.revision,
          composition: 'matrix',
          sessionPath: path.join(options.userData, 'reporting-session.json')
        })
    })
    const legacyShipIt = options.supported && options.applicationIdentifier && options.home
      ? {
          applicationIdentifier: options.applicationIdentifier,
          cacheDirectory: path.join(options.home, 'Library', 'Caches', `${options.applicationIdentifier}.ShipIt`)
        }
      : null
    const settings = options.updateSettings ?? createDesktopUpdateSettings({
      file: path.join(options.userData, 'updates.json'),
      legacyMarkers: [
        path.join(options.userData, 'downloaded-update.json'),
        path.join(options.userData, 'pending-update.json')
      ],
      retireLegacyNativeState: legacyShipIt
        ? complete => retireLegacyShipItState({
            ...legacyShipIt,
            complete,
            progress: step => options.log(`[Matrix] Stock updater migration ${step}`)
          })
        : undefined,
      sweepLegacyNativeState: legacyShipIt
        ? () => sweepLegacyShipItQuarantines({
            ...legacyShipIt,
            progress: step => options.log(`[Matrix] Stock updater migration ${step}`)
          })
        : undefined
    })
    let notes = options.updateNotes

    try {
      if (config.updateFeedUrl) {
        notes ??= trustedUpdateNotes(config.updateFeedUrl)
      }
    } catch {
      options.log('[Matrix] Release notes are unavailable for this feed')
    }

    this.updater = createDesktopUpdater({
      busy: () => this.pendingMessages > 0 || options.busy(),
      changed: () => this.changed(),
      currentVersion: options.version,
      feedUrl: config.updateFeedUrl,
      isPackaged: options.packaged,
      loadUpdater: options.loadUpdater,
      logger: options.updaterLogger ?? {
        info: message => options.log(`[auto-update] ${String(message)}`),
        warn: message => options.log(`[auto-update] ${String(message)}`),
        error: message => options.log(`[auto-update] ${String(message)}`)
      },
      nativeUpdater: options.nativeUpdater,
      nativeStateLease: legacyShipIt ? createShipItOperationLease(legacyShipIt) : undefined,
      recoverPendingInstall: legacyShipIt && options.bundlePath
        ? async () => {
            if (options.temporaryPath) {
              await sweepOrphanedShipItTemporaryDirectories({ ...legacyShipIt, temporaryPath: options.temporaryPath })
            }

            return recoverPendingShipItInstall({ ...legacyShipIt, bundlePath: options.bundlePath!, currentVersion: options.version })
          }
        : undefined,
      prepareDownload: legacyShipIt && options.bundlePath && options.temporaryPath
        ? async info => {
            await createDesktopUpdateDiskPreflight({
              bundlePath: options.bundlePath!, temporaryPath: options.temporaryPath!,
              cachePath: path.dirname(legacyShipIt.cacheDirectory)
            })(info)
          }
        : undefined,
      notes,
      locale: options.locale?.() ?? 'vi',
      quit: options.quit,
      beforeInstall: options.beforeInstall,
      forceExit: options.forceExit,
      previousRestart: options.previousRestart,
      restartFeedback: options.restartFeedback,
      record: event => this.capture(event),
      setInterval: options.setInterval,
      settings,
      supported: options.supported,
      notify: () => {}
    })
  }

  start(): Promise<boolean> { return this.updater.start() }
  status(): MatrixDesktopServicesStatus {
    return {
      reporting: this.reporting.status(),
      update: this.updater.status(),
      version: this.options.version,
      busy: this.busy()
    }
  }
  private busy() {
    return this.pendingMessages > 0 || this.options.busy()
  }
  private changed() {
    this.options.changed(this.status())
  }
  refreshBusy() {
    const busy = this.busy()

    if (busy !== this.previousBusy) {
      this.previousBusy = busy
      this.changed()
    }
  }
  setEnabled(enabled: boolean) {
    this.reporting.setEnabled(enabled)
    this.changed()

    return this.status()
  }
  feedback(message: string) {
    return this.reporting.feedback(message)
  }
  capture(event: ProductEvent) {
    try {
      this.reporting.capture(event)
    } catch {
      /* Diagnostics never own execution. */
    }
  }
  error(error: DiagnosticError) {
    try {
      this.reporting.error(error)
    } catch {
      /* Diagnostics never own execution. */
    }
  }
  turn(observation: TurnObservation) {
    try {
      this.reporting.turn(0, observation)
    } catch {
      /* Diagnostics never own execution. */
    }
  }
  active() {
    this.capture({ name: 'app_active', properties: {} })
  }
  inactive() {}
  resumed() {}
  async message<T>(send: () => Promise<T>): Promise<T> {
    this.pendingMessages += 1
    this.refreshBusy()

    try {
      const result = await send()
      this.capture({
        name: 'matrix_message_sent',
        properties: { outcome: 'completed' }
      })

      return result
    } catch (error) {
      this.capture({
        name: 'matrix_message_sent',
        properties: { outcome: 'failed' }
      })
      throw error
    } finally {
      this.pendingMessages -= 1
      this.refreshBusy()
    }
  }
  ready() {
    if (this.shellReady) {
      return
    }

    this.shellReady = true
    this.capture({
      name: 'matrix_shell_ready',
      properties: {
        duration_ms: Math.min(86_400_000, Date.now() - this.started)
      }
    })
  }
  synced() {
    if (this.syncReady) {
      return
    }

    this.syncReady = true
    this.capture({
      name: 'matrix_sync_ready',
      properties: {
        duration_ms: Math.min(86_400_000, Date.now() - this.started)
      }
    })
  }
  setUpdateChannel(channel: unknown) {
    return this.updater.setChannel(channel)
  }
  checkUpdates() {
    return this.updater.checkNow()
  }
  restart() {
    if (this.restarting) {return false}
    this.restarting = this.updater.restart()

    return this.restarting
  }
  /**
   * The quit was refused before teardown finished (the open document's checkpoint said
   * no, or timed out): nothing is installing, so take the notice down and let Update
   * work again.
   */
  closeAborted() {
    if (this.restarting) {
      this.options.log('[Matrix] Update postponed because the quit was refused; retry quitting')
    }
    this.restarting = false
    this.updater.cancelRestart()
  }
  /** Restart consumes one stock install handoff after teardown. Ordinary Quit
   * returns normally so electron-updater's install-on-quit policy owns it. */
  afterClose(success: boolean): 'quit' | 'handled' | 'retry' {
    if (!success && ['downloaded', 'restarting'].includes(this.updater.status().state)) {
      this.restarting = false
      this.updater.cancelRestart()
      this.options.resetClosing()
      this.capture({
        name: 'update_failed',
        properties: { stage: 'install', code: 'failed' }
      })
      this.options.log('[Matrix] Update postponed because shutdown did not finish; retry quitting')

      return 'retry'
    }

    this.reporting.endSession(!success)

    if (success) {
      this.restarting = false
      return this.updater.afterTeardown() ? 'handled' : 'quit'
    }

    return 'quit'
  }

  crashed(delivery?: { delivered?: boolean }) {
    this.reporting.endSession(true, delivery)
  }
}

/**
 * The quit handler's after-close step. A refused document checkpoint (`refused`) keeps
 * the app open and must also undo whatever Update started, or its notice stays up for
 * good and Update stops answering.
 */
export function matrixAfterClose(
  services: MatrixDesktopServices | null | undefined,
  success: boolean,
  refused: boolean
): 'quit' | 'handled' | 'retry' {
  if (refused) {
    services?.closeAborted()

    return 'retry'
  }

  return services?.afterClose(success) ?? 'quit'
}

/** Owned top frames only. SDK/management pages get error reporting, never settings. */
export function installMatrixDesktopServicesIpc(options: {
  services: MatrixDesktopServices
  ipc: Pick<IpcMain, 'handle' | 'on'>
  requireUi: (event: IpcMainInvokeEvent | IpcMainEvent) => void
  requireDiagnostic: (event: IpcMainEvent) => void
}) {
  const { services, ipc } = options

  const handle = (channel: string, action: (...args: any[]) => unknown) =>
    ipc.handle(channel, (event, ...args) => {
      options.requireUi(event)

      return action(...args)
    })

  handle(channels.status, () => services.status())
  handle(channels.enabled, enabled => services.setEnabled(enabled))
  handle(channels.feedback, message => services.feedback(message))
  handle(channels.channel, channel => services.setUpdateChannel(channel))
  handle(channels.check, () => services.checkUpdates())
  handle(channels.restart, () => services.restart())

  for (const [channel, action] of [
    [channels.ready, () => services.ready()],
    [channels.active, () => services.active()]
  ] as const) {
    ipc.on(channel, event => {
      try {
        options.requireUi(event)
        action()
      } catch {
        /* Drop unowned senders. */
      }
    })
  }

  ipc.on(channels.error, (event, error) => {
    try {
      options.requireDiagnostic(event)

      if (!error || typeof error !== 'object') {
        return
      }

      services.error({
        operation: 'renderer',
        kind: error.kind,
        stack: error.stack
      })
    } catch {
      /* Drop unowned senders. */
    }
  })
}
