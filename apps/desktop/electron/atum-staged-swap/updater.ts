import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'

import { AppUpdater } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { findFile } from 'electron-updater/out/providers/Provider'

import type { ElectronUpdaterPort } from '../desktop-updater'

import { StagedSwap, type StagedSwapOptions } from './stage'
import { markStockOnly, writeFailureNotice } from './store'

export interface StagedMacUpdaterOptions extends StagedSwapOptions {
  /** Stock Squirrel updater: the sticky fallback for every failure before the Restart click. */
  fallback: ElectronUpdaterPort
  /** End the process. `relaunch` asks the app to reopen itself when no launcher exists to do it. */
  exit: (relaunch: boolean) => void
  /** Coarse, closed-schema report (update_failed install/failed). The reason stays in the local log. */
  reportInstallFailure?: () => void
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : 'unknown')

/** An asset matches an architecture by its resolved URL or by the name the feed lists. */
export function matchesArchitecture(file: { url: URL; info: { url: string } }, pattern: RegExp): boolean {
  return pattern.test(file.url.pathname) || pattern.test(file.info.url)
}

/** This lane is enabled only on native arm64 Matrix, whose feed includes arm64 or universal ZIPs. */
export function pickZipFiles<T extends { url: URL; info: { url: string } }>(files: T[]): T[] {
  const arm = files.filter(file => matchesArchitecture(file, /arm64/u))

  return arm.length ? arm : files.filter(file => !matchesArchitecture(file, /x64/u))
}

/**
 * The missing seam in electron-updater 6.6.2: download without submitting ShipIt.
 * Download selection and cache logic adapted from upstream MacUpdater (MIT).
 * All HTTP, SHA-512, cancellation, blockmaps and cache validation remain upstream.
 *
 * Before the Restart click every failure falls back to stock Squirrel. After the click nothing ever starts
 * a stock download: the app has no windows and holds the single-instance lock, so a failure there only
 * records "use stock next session" and exits; the launcher reopens the old app within seconds.
 */
export class StagedMacUpdater extends AppUpdater {
  // Present at runtime in pinned 6.6.2, omitted from its published declaration.
  declare protected httpExecutor: ElectronHttpExecutor | null
  /** Preparation already finished in-app; Restart needs no long-lived updater helper. */
  readonly showRestartFeedback = false
  stageReady = false
  private stock = false
  private installing = false
  private stagedVersion = ''
  private feed: { provider: 'generic'; url: string } | null = null
  private readonly stage: StagedSwap

  constructor(private readonly options: StagedMacUpdaterOptions) {
    super(undefined)
    this.stage = new StagedSwap(options)

    for (const event of ['checking-for-update', 'error', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded']) {
      options.fallback.on(event as 'error', ((value: Error) => {
        if (this.stock) {EventEmitter.prototype.emit.call(this, event, value)}
      }))
    }
  }

  override setFeedURL(feed: { provider: 'generic'; url: string }): void {
    this.feed = feed
    super.setFeedURL(feed)
  }

  beginRestart(): void {
    this.stage.beginRestart()
  }

  /** Stock Squirrel takes over the rest of this session: download only; its own quit hook installs. */
  private async fallback(): Promise<void> {
    this.stock = true
    await this.stage.abandon().catch(() => undefined)
    this.stageReady = false
    const next = this.options.fallback

    next.logger = this.logger
    next.channel = this.channel
    next.allowDowngrade = false
    next.allowPrerelease = false
    next.autoDownload = true
    next.autoInstallOnAppQuit = true
    next.autoRunAppAfterInstall = true
    next.setFeedURL(this.feed!)
    this.options.log('[updates] stage fallback=stock')
    const checked = await next.checkForUpdates()

    await checked?.downloadPromise
  }

  protected override async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    if (this.stock) {
      await this.fallback()

      return []
    }

    try {
      const provider = options.updateInfoAndProvider.provider
      const zip = findFile(pickZipFiles(provider.resolveFiles(options.updateInfoAndProvider.info)), 'zip', ['pkg', 'dmg'])

      if (!zip) {throw new Error('Update ZIP not provided')}

      return await this.executeDownload({
        fileExtension: 'zip',
        fileInfo: zip,
        downloadUpdateOptions: options,
        task: async (destination, downloadOptions) => {
          const previous = path.join(this.downloadedUpdateHelper!.cacheDir, 'update.zip')
          const cached = await fs.access(previous).then(() => true, () => false)

          const full = !cached || options.disableDifferentialDownload ||
            await this.differentialDownloadInstaller(zip, options, destination, provider, 'update.zip')

          if (full) {await this.httpExecutor!.download(zip.url, destination, downloadOptions)}
        },
        done: async event => {
          try {
            await this.stage.prepare(event.downloadedFile, event.version)
            this.stagedVersion = event.version

            // Retain upstream's differential baseline, off the restart path.
            if (!options.disableDifferentialDownload) {
              await fs.copyFile(event.downloadedFile, path.join(this.downloadedUpdateHelper!.cacheDir, 'update.zip')).catch(() => undefined)
            }

            this.stageReady = true
            this.dispatchUpdateDownloaded(event)
          } catch (error) {
            this.options.log(`[updates] stage failed reason=${reasonOf(error)}`)
            await this.fallback()
          }

          return []
        }
      })
    } catch (error) {
      if (this.stock) {throw error}
      this.options.log(`[updates] stage download failed reason=${reasonOf(error)}`)
      await this.fallback()

      return []
    }
  }

  /** `isForceRunAfter` false is an ordinary Quit: swap, but leave the app closed. */
  override quitAndInstall(_isSilent?: boolean, isForceRunAfter?: boolean): void {
    if (this.installing) {return}
    this.installing = true

    if (this.stock) {
      this.options.fallback.quitAndInstall(false, true)

      return
    }

    void this.installStaged(isForceRunAfter !== false)
  }

  private async installStaged(relaunch: boolean): Promise<void> {
    // The kill switch is read again here: switching it off between download and click must not swap. That is
    // not a failure. Nothing was touched and no launcher exists, so the installed app simply reopens itself
    // (Restart) or the app just closes (Quit): no notice, no report, no stock-only mark. The next session
    // loads the stock updater and downloads on its own.
    if (!this.options.enabled()) {
      this.options.log('[updates] stage switched off before install; keeping the installed app')
      await this.stage.abandon().catch(() => undefined)
      this.options.exit(relaunch)

      return
    }

    try {
      await this.stage.install({ relaunch })
      this.options.exit(false)
    } catch (error) {
      // The installed app is intact (or the launcher restores the backup). Never start a long windowless
      // stock download here; remember to use stock next session and let the launcher reopen the app.
      const reason = reasonOf(error)

      this.options.log(`[updates] stage install failed reason=${reason}`)
      this.options.reportInstallFailure?.()
      markStockOnly(this.stage.root, this.stagedVersion, 'install')

      if (relaunch) {writeFailureNotice(this.stage.root, this.options.version, this.stagedVersion)}
      this.options.exit(relaunch && !this.stage.waiterRunning)
    }
  }
}
