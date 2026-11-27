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
  createDesktopUpdateSettings,
  retireLegacyShipItState,
  sweepLegacyShipItQuarantines
} from '../desktop-update-settings'
import { createAtumUpdates } from '../t3-updates/service'
import type { DesktopUpdateSettings } from '../t3-updates/settings-contract'

/** One instance owned by the Matrix main process, never by a room or SDK host. */
export class MatrixDesktopServices {
  private readonly reporting: AtumObservability
  private readonly updater: ReturnType<typeof createAtumUpdates>
  private readonly started = Date.now()
  private shellReady = false
  private syncReady = false
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
      resources: string
      currentChannel: 'latest' | 'beta' | null
      admit: (expectedVersion: string) => Promise<string | null>
      native: Parameters<typeof createAtumUpdates>[0]['native']
      changed: (status: MatrixDesktopServicesStatus) => void
      updateSettings?: DesktopUpdateSettings
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
    this.updater = createAtumUpdates({
      version: options.version,
      packaged: options.packaged,
      supported: options.supported,
      feedUrl: config.updateFeedUrl,
      resources: options.resources,
      userData: options.userData,
      currentChannel: options.currentChannel,
      native: options.native,
      admit: async version => this.busy() ? 'Wait for local work to finish, then try again.' : options.admit(version),
      changed: () => this.changed(),
      log: options.log,
      settings
    })
  }

  start(): Promise<boolean> { return this.updater.start() }
  status(): MatrixDesktopServicesStatus {
    return {
      reporting: this.reporting.status(),
      update: this.updater.status(),
      desktopUpdate: this.updater.state(),
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
  downloadUpdate() {
    return this.updater.download()
  }
  restart(expectedVersion?: string) {
    return this.updater.restart(expectedVersion)
  }
  endSession(success: boolean) {
    void this.updater.stop()
    this.reporting.endSession(!success)
  }
  crashed(delivery?: { delivered?: boolean }) {
    this.reporting.endSession(true, delivery)
  }
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
  handle(channels.download, () => services.downloadUpdate())
  handle(channels.restart, expectedVersion => {
    if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(expectedVersion) || expectedVersion.length > 64) {
      return false
    }

    return services.restart(expectedVersion)
  })

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
