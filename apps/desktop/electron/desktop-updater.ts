import type { AtumUpdateChannel, AtumUpdateFailure, AtumUpdateStatus } from '../shared/atum-update-flow'

export const ATUM_UPDATE_INTERVAL_MS = 60 * 60_000
export const ATUM_UPDATE_BUSY_CHANNEL = 'atum:update:busy'
export const ATUM_UPDATE_CHECK_CHANNEL = 'atum:update:check'
export const ATUM_UPDATE_DOWNLOADED_CHANNEL = 'atum:update:downloaded'
export const ATUM_UPDATE_RELAUNCH_CHANNEL = 'atum:update:relaunch'
export const ATUM_UPDATE_STATE_CHANNEL = 'atum:update:state'
export const ATUM_UPDATE_STATUS_CHANNEL = 'atum:update:status'

interface UpdateInfo {
  files?: unknown
  version?: unknown
  releaseNotes?: unknown
}

interface ProgressInfo {
  percent?: unknown
}

export interface DesktopUpdaterLogger {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
  debug?(message?: unknown): void
}

export interface ElectronUpdaterPort {
  /** Staged lane publishes only after verification/pre-warm. Stock waits for native-ready. */
  readonly stageReady?: boolean
  /** False when the prepared updater needs no blocking handoff window after Restart. */
  readonly showRestartFeedback?: boolean
  beginRestart?(): void
  logger: DesktopUpdaterLogger | null
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  allowDowngrade: boolean
  allowPrerelease: boolean
  channel: string | null
  downloadUpdate?(): Promise<unknown>
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> } | null | undefined>
  on(event: 'checking-for-update', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'update-available' | 'update-downloaded', listener: (info: UpdateInfo) => void): void
  on(event: 'update-not-available', listener: () => void): void
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): void
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  setFeedURL(options: { provider: 'generic'; url: string }): void
}

export interface NativeUpdaterPort {
  on(event: 'update-downloaded', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface DesktopUpdateSettings {
  migrate(currentVersion: string): Promise<{
    applied: { from_version: string; to_version: string } | null
    channel: AtumUpdateChannel
    deferred?: boolean
  }>
  getChannel(): Promise<unknown>
  setChannel(channel: AtumUpdateChannel): Promise<void>
}

export interface DesktopUpdateNotes {
  read(version: string, locale: string): Promise<unknown>
}

export interface DesktopUpdaterEvent {
  name: 'update_available' | 'update_downloaded' | 'update_failed' | 'update_applied'
  properties: Record<string, string | number>
}

function version(value: unknown): string | null {
  if (typeof value !== 'string') {return null}
  const result = value.trim()

  return result.length <= 64 && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(result) ? result : null
}

function channel(value: unknown): AtumUpdateChannel {
  return value === 'beta' ? 'beta' : 'latest'
}

function plainNotes(value: unknown): readonly string[] {
  const source = typeof value === 'string'
    ? value.split(/\r?\n/u)
    : Array.isArray(value)
      ? value.flatMap(item => typeof item === 'string' ? [item] : [item?.note]).filter(item => typeof item === 'string')
      : []

  return source
    .map(item => item
      .replace(/<[^>]*>/gu, ' ')
      .replace(/\[(.*?)\]\([^)]*\)/gu, '$1')
      .replace(/^[\s*#>-]+/u, '')
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim())
    .filter(Boolean)
    .map(item => Array.from(item).slice(0, 140).join(''))
    .slice(0, 3)
}

function publicFailure(error: unknown): Omit<AtumUpdateFailure, 'stage'> {
  const source = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '')

  if (/ENOSPC|no space left|insufficient (?:free )?space|disk.?full/i.test(source)) {
    return { code: 'disk_space', message: 'Not enough disk space to download the update.',
      ...(typeof (error as { requiredBytes?: unknown })?.requiredBytes === 'number'
        ? { requiredBytes: (error as { requiredBytes: number }).requiredBytes } : {}) }
  }

  if (/sha-?512|checksum|integrity|hash mismatch/i.test(source)) {
    return { code: 'hash_mismatch', message: 'The downloaded update could not be verified.' }
  }

  if (/ECONN|ENOTFOUND|ETIMEDOUT|offline|connection|network|fetch|http|transport|socket/i.test(source)) {
    return { code: 'transport', message: 'Could not reach the update server.' }
  }

  return { code: 'failed', message: 'The updater could not complete this request.' }
}

export function offersUpdateMenuItem(options: { armed: boolean; isPackaged: boolean }): 'atum' | 'hermes' | null {
  if (options.armed) {return 'atum'}

  return options.isPackaged ? null : 'hermes'
}

export function isAtumDownloadedUpdate(value: unknown): value is { state: 'downloaded'; version: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return false}
  const record = value as Record<string, unknown>

  return Object.keys(record).length === 2 && record.state === 'downloaded' && version(record.version) !== null
}

/** Thin product adapter over electron-updater. Download, cache, staging,
 * signature verification, install-on-quit, retry and cleanup stay upstream. */
export function createDesktopUpdater(options: {
  busy: () => boolean
  changed?: (status: AtumUpdateStatus) => void
  currentVersion: string
  defer?: (callback: () => void) => void
  feedUrl: null | string
  isPackaged: boolean
  loadUpdater: () => Promise<ElectronUpdaterPort>
  locale?: string
  logger: DesktopUpdaterLogger
  nativeUpdater: NativeUpdaterPort
  nativeStateLease?: () => Promise<(() => Promise<void>) | null>
  notes?: DesktopUpdateNotes
  notify?: (payload: { state: 'downloaded'; version: string }) => void
  quit: () => void
  /** Composition owns process/window shutdown; Squirrel owns replacement and relaunch. */
  beforeInstall?: () => void
  forceExit?: () => void
  prepareDownload?: (info: UpdateInfo) => Promise<void>
  recoverPendingInstall?: () => Promise<{ version: string; install(): Promise<void> } | null>
  /** What the previous launch's Restart left (update-handoff.ts): `not_updated` is said plainly. */
  previousRestart?: { outcome: 'updated' | 'not_updated' } | null
  /** Visible continuity from the Restart click until the new version's window is up. */
  restartFeedback?: { begin(toVersion: string): void; cancel(): void; fail(): void }
  record?: (event: DesktopUpdaterEvent) => void
  setInterval: (callback: () => void, delay: number) => unknown
  setInstallTimer?: (callback: () => void, delay: number) => unknown
  clearInstallTimer?: (timer: unknown) => void
  installWatchdogMs?: number
  setStagingTimer?: (callback: () => void, delay: number) => unknown
  clearStagingTimer?: (timer: unknown) => void
  stagingDeadlineMs?: number
  settings: DesktopUpdateSettings
  supported?: boolean
}) {
  const defer = options.defer ?? setImmediate
  const setInstallTimer = options.setInstallTimer ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay)
    timer.unref()

    return timer
  })
  const clearInstallTimer = options.clearInstallTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const setStagingTimer = options.setStagingTimer ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay)
    timer.unref()

    return timer
  })
  const clearStagingTimer = options.clearStagingTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let updater: ElectronUpdaterPort | null = null
  let starting: Promise<boolean> | null = null
  let checking: Promise<void> | null = null
  let downloading: Promise<unknown> | null = null
  let recovering = false
  let recovered: { version: string; install(): Promise<void> } | null = null
  let channelChanging = false
  let terminalRecovery = false
  let timerStarted = false
  let restartRequested = false
  let restartFeedbackActive = false
  let installStarted = false
  let quitting = false
  let installTimer: unknown | null = null
  let stagingTimer: unknown | null = null
  let pendingDownloaded: UpdateInfo | null = null
  let failedNativeVersion: string | null = null
  const recorded = new Set<string>()
  const reportedErrors = new WeakSet<object>()
  let status: AtumUpdateStatus = {
    armed: false, packaged: options.isPackaged, channel: 'latest', state: 'unavailable', version: null,
    checkedAt: null, progress: null, notes: [], error: null, requiredBelow: null
  }

  const publish = (patch: Partial<AtumUpdateStatus>) => {
    status = { ...status, ...patch }
    options.changed?.({ ...status, notes: [...status.notes] })
  }
  const recordOnce = (event: DesktopUpdaterEvent) => {
    const key = JSON.stringify(event)

    if (recorded.has(key)) {return}
    recorded.add(key)
    options.record?.(event)
  }
  const applyChannel = (next: AtumUpdateChannel) => {
    if (!updater) {return}
    updater.channel = next
    updater.allowDowngrade = false
    updater.allowPrerelease = false
  }
  const clearInstallWatchdog = () => {
    if (installTimer !== null) {
      clearInstallTimer(installTimer)
      installTimer = null
    }
  }
  const clearStagingDeadline = () => {
    if (stagingTimer !== null) {
      clearStagingTimer(stagingTimer)
      stagingTimer = null
    }
  }
  const fail = (error: unknown, nativeFailure = false, recovery?: AtumUpdateFailure['recovery']) => {
    if (error && typeof error === 'object') {
      if (reportedErrors.has(error) && !installStarted) {return}
      reportedErrors.add(error)
    }
    if (nativeFailure) {failedNativeVersion = version(pendingDownloaded?.version)}
    pendingDownloaded = null
    clearStagingDeadline()
    const mapped = publicFailure(error)
    const stage = installStarted || restartRequested || status.state === 'restarting'
      ? 'install'
      : ['downloading', 'preparing'].includes(status.state)
        ? 'download'
        : 'check'
    const failure = { ...mapped, stage, ...(recovery ? { recovery } : {}) } as const
    options.logger.error(error)
    recordOnce({ name: 'update_failed', properties: { stage, code: failure.code } })

    if (installStarted) {
      if (quitting) {return}
      quitting = true
      clearInstallWatchdog()
      publish({ state: 'error', progress: null, error: failure })
      feedback('fail')
      ;(options.forceExit ?? options.quit)()

      return
    }

    // An update already proven native-ready remains authoritative.
    if (!['downloaded', 'restarting'].includes(status.state)) {
      publish({ state: 'error', progress: null, error: failure })
    }
  }
  const feedback = (action: 'begin' | 'cancel' | 'fail', toVersion = '') => {
    if (action === 'begin' && (updater?.showRestartFeedback === false || !options.restartFeedback)) {return}
    if (action !== 'begin' && !restartFeedbackActive) {return}

    try {
      if (action === 'begin') {
        options.restartFeedback!.begin(toVersion)
        restartFeedbackActive = true
      } else {
        options.restartFeedback?.[action]()
        restartFeedbackActive = false
      }
    } catch (error) {
      // Reassurance only: it never decides whether the update installs.
      options.logger.warn(error)
    }
  }
  const loadFallbackNotes = async (nextVersion: string) => {
    if (!options.notes) {return}

    for (const locale of [...new Set([options.locale ?? 'vi', 'vi'])]) {
      try {
        const notes = plainNotes(await options.notes.read(nextVersion, locale))

        if (notes.length && status.version === nextVersion && status.state !== 'unavailable') {
          publish({ notes })

          return
        }
      } catch {
        // Notes are optional and never own the update.
      }
    }
  }
  const check = (manual = false): boolean => {
    if (!updater) {
      if (options.isPackaged && options.supported !== false && options.feedUrl) {void controller.start();

 return true}

      return false
    }

    if (recovering) {return true}

    if (terminalRecovery) {return false}

    if (channelChanging || checking || ['downloading', 'preparing', 'downloaded', 'restarting'].includes(status.state)) {return true}

    if (failedNativeVersion && !manual) {return true}
    if (manual) {failedNativeVersion = null}
    publish({ state: 'checking', error: null })
    checking = Promise.resolve()
      .then(async () => {
        const release = await options.nativeStateLease?.()

        if (options.nativeStateLease && !release) {
          if (status.state === 'checking') {publish({ state: 'idle' })}

          return
        }

        try {
          const result = await updater!.checkForUpdates()
          await result?.downloadPromise?.catch(() => undefined)
          await downloading
        } finally {
          await release?.()
        }
      })
      .catch(fail)
      .then(() => undefined)
      .finally(() => {checking = null})

    return true
  }

  const controller = {
    async start(): Promise<boolean> {
      if (updater) {return true}
      if (starting) {return starting}
      if (!options.isPackaged || options.supported === false || !options.feedUrl) {return false}

      starting = (async () => {
        try {
          const [next, migrated] = await Promise.all([
            options.loadUpdater(),
            options.settings.migrate(options.currentVersion).catch(async error => {
              options.logger.warn(error)

              try {
                return { channel: channel(await options.settings.getChannel()), applied: null, deferred: false }
              } catch (readError) {
                options.logger.warn(readError)

                return { channel: 'latest' as const, applied: null, deferred: false }
              }
            })
          ])

          recovering = true
          updater = next
          updater.logger = options.logger
          updater.autoDownload = !options.prepareDownload
          updater.autoInstallOnAppQuit = true
          updater.autoRunAppAfterInstall = true
          updater.setFeedURL({ provider: 'generic', url: options.feedUrl! })
          applyChannel(migrated.channel)
          updater.on('checking-for-update', () => {
            if (channelChanging || terminalRecovery) {return}

            if (status.state !== 'checking' && !['downloading', 'preparing', 'downloaded', 'restarting'].includes(status.state)) {
              publish({ state: 'checking', error: null })
            }
          })
          updater.on('update-available', info => {
            if (channelChanging || terminalRecovery) {return}
            const nextVersion = version(info.version)

            if (!nextVersion || ['downloading', 'preparing', 'downloaded', 'restarting'].includes(status.state)) {return}
            const notes = plainNotes(info.releaseNotes)
            publish({ state: 'downloading', version: nextVersion, checkedAt: Date.now(), progress: 0, notes, error: null })
            recordOnce({ name: 'update_available', properties: { from_version: options.currentVersion, to_version: nextVersion } })
            if (!notes.length) {void loadFallbackNotes(nextVersion)}

            if (options.prepareDownload) {
              downloading = Promise.resolve().then(async () => {
                await options.prepareDownload!(info)
                await updater!.downloadUpdate!()
              }).catch(fail).finally(() => {downloading = null})
            }
          })
          updater.on('download-progress', progress => {
            if (channelChanging || terminalRecovery) {return}

            if (['downloading', 'preparing'].includes(status.state) && typeof progress.percent === 'number' && Number.isFinite(progress.percent)) {
              const percent = Math.max(0, Math.min(100, progress.percent))
              publish({ state: percent >= 100 ? 'preparing' : 'downloading', progress: percent >= 100 ? null : percent })
            }
          })
          updater.on('update-downloaded', info => {
            if (channelChanging || terminalRecovery) {return}
            const nextVersion = version(info.version)

            if (!nextVersion || pendingDownloaded || ['downloaded', 'restarting', 'error'].includes(status.state)) {
              return
            }
            const notes = plainNotes(info.releaseNotes)
            pendingDownloaded = info
            publish({ state: 'preparing', version: nextVersion, checkedAt: Date.now(), progress: null,
              notes: notes.length ? notes : status.notes, error: null })
            if (!notes.length && !status.notes.length) {void loadFallbackNotes(nextVersion)}
            clearStagingDeadline()
            if (updater?.stageReady) {
              pendingDownloaded = null
              publish({ state: 'downloaded', version: nextVersion, progress: 100, error: null })
              recordOnce({ name: 'update_downloaded', properties: { from_version: options.currentVersion, to_version: nextVersion } })
              options.notify?.({ state: 'downloaded', version: nextVersion })
              return
            }
            stagingTimer = setStagingTimer(
              () => {
                stagingTimer = null
                terminalRecovery = true
                fail(new Error('Native update staging timed out'), false, 'manual_download')
              },
              options.stagingDeadlineMs ?? 15 * 60_000
            )
          })
          updater.on('update-not-available', () => {
            if (channelChanging || terminalRecovery) {return}

            if (!['downloading', 'preparing', 'downloaded', 'restarting'].includes(status.state)) {
              publish({ state: 'idle', version: null, checkedAt: Date.now(), progress: null, notes: [], error: null })
            }
          })
          updater.on('error', error => {
            if (!channelChanging && !terminalRecovery) {fail(error, pendingDownloaded !== null)}
          })
          options.nativeUpdater.on('update-downloaded', () => {
            if (channelChanging || terminalRecovery) {return}
            const info = pendingDownloaded
            const nextVersion = version(info?.version)

            if (!info || !nextVersion || status.state !== 'preparing') {return}
            pendingDownloaded = null
            clearStagingDeadline()
            publish({ state: 'downloaded', version: nextVersion, progress: 100, error: null })
            recordOnce({ name: 'update_downloaded', properties: { from_version: options.currentVersion, to_version: nextVersion } })
            options.notify?.({ state: 'downloaded', version: nextVersion })
          })
          publish({ armed: true, channel: migrated.channel, state: 'idle' })
          if (migrated.applied) {recordOnce({ name: 'update_applied', properties: migrated.applied })}
          recovered = await options.recoverPendingInstall?.().catch(error => {options.logger.warn(error);

 return null}) ?? null
          recovering = false

          if (recovered) {
            publish({ state: 'downloaded', version: recovered.version, progress: 100, error: null })
          } else if (options.previousRestart?.outcome === 'not_updated') {
            // ShipIt kept the old version. Say so instead of silently starting over; Try again re-checks.
            const failure = { code: 'failed', stage: 'install', message: 'The update did not finish.' } as const
            recordOnce({ name: 'update_failed', properties: { stage: failure.stage, code: failure.code } })
            publish({ state: 'error', progress: null, error: failure })
          } else {check()}

          if (!timerStarted) {
            options.setInterval(() => {void check()}, ATUM_UPDATE_INTERVAL_MS)
            timerStarted = true
          }

          return true
        } catch (error) {
          updater = null
          recovering = false
          fail(error)

          return false
        } finally {
          starting = null
        }
      })()

      return starting
    },
    armed: () => updater !== null,
    status: (): AtumUpdateStatus => ({ ...status, notes: [...status.notes] }),
    checkNow: () => check(true),
    async setChannel(next: unknown): Promise<boolean> {
      if (
        (next !== 'latest' && next !== 'beta') || !updater || options.busy() || checking || channelChanging ||
        terminalRecovery || recovering || !['idle', 'error'].includes(status.state)
      ) {
        return false
      }

      channelChanging = true
      try {
        await options.settings.setChannel(next)
        const persisted = channel(await options.settings.getChannel())
        applyChannel(persisted)
        publish({ channel: persisted, state: 'idle', version: null, progress: null, notes: [], error: null })
        channelChanging = false
        check(true)

        return persisted === next
      } catch (error) {
        options.logger.error(error)

        return false
      } finally {
        channelChanging = false
      }
    },
    restart(): boolean {
      if (!updater || restartRequested || installStarted || options.busy() || status.state !== 'downloaded') {return false}
      restartRequested = true
      updater.beginRestart?.()
      publish({ state: 'restarting' })
      feedback('begin', status.version ?? '')
      options.quit()

      return true
    },
    cancelRestart(): void {
      restartRequested = false
      if (!installStarted && status.state === 'restarting') {
        feedback('cancel')
        publish({ state: 'downloaded' })
      }
    },
    /** Consume restart intent only after the composition's teardown barrier. */
    afterTeardown(): boolean {
      // A prepared staged update also installs on an ordinary Quit (Squirrel does the same), without reopening the app.
      const quitInstall = !restartRequested && !recovered && updater?.stageReady === true && status.state === 'downloaded'

      if (!updater || (!restartRequested && !recovered && !quitInstall) || installStarted || !['downloaded', 'restarting'].includes(status.state)) {return false}
      restartRequested = false
      installStarted = true
      defer(() => {
        installTimer = setInstallTimer(
          () => {
            installTimer = null
            options.logger.warn('Native install handoff exit deadline reached')
            ;(options.forceExit ?? options.quit)()
          },
          options.installWatchdogMs ?? 10_000
        )
        try {
          options.beforeInstall?.()

          if (recovered) {
            // A previous native Restart already persisted launchAfterInstallation.
            // Electron has no API to restore g_update_available across processes;
            // resume the exact native job without creating a second staging copy.
            void recovered.install().then(options.quit, error => fail(error))
          } else {updater!.quitAndInstall(false, !quitInstall)}
        } catch (error) {
          fail(error)
        }
      })

      return true
    }
  }

  return controller
}
