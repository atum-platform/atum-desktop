import * as Effect from 'effect/Effect'
import { EventEmitter } from 'node:events'
import { MacUpdater } from 'electron-updater'
import type { UpdateDownloadedEvent } from 'electron-updater'

import {
  ElectronUpdater,
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError
} from '../../vendor/t3-updates/apps/desktop/src/electron/ElectronUpdater'
import type { StagedSwap } from '../atum-staged-swap/stage'

/** Stock Mac transfer and cache handling, with the Squirrel proxy seam replaced. */
export function createMacUpdatePort(options: {
  stage: Pick<StagedSwap, 'prepare'>
  install: () => Promise<void>
  developmentConfigPath?: string
  checkedOffer: (version: string | null) => void
}) {
  // The npm package declares this implementation method private. It is invoked by
  // the stock transfer after the ZIP has passed its normal cache and digest checks.
  const updater = new MacUpdater()
  if (options.developmentConfigPath) {
    updater.forceDevUpdateConfig = true
    updater.updateConfigPath = options.developmentConfigPath
  }

  Object.defineProperty(updater, 'updateDownloaded', {
    value: async (_zipFileInfo: unknown, event: UpdateDownloadedEvent) => {
      await options.stage.prepare(event.downloadedFile, event.version)
      events.emit('update-downloaded', event)
    }
  })
  const events = updater as unknown as EventEmitter
  // Bus gets an error handler before the first Electron operation.
  events.on('error', () => undefined)

  return ElectronUpdater.of({
    setFeedURL: feed => Effect.sync(() => updater.setFeedURL(feed)),
    // The service controls auto-download through its normal serialized download
    // action. Starting it inside the native checker would bypass that reservation.
    setAutoDownload: () => Effect.sync(() => {updater.autoDownload = false}),
    setAutoInstallOnAppQuit: () => Effect.sync(() => {updater.autoInstallOnAppQuit = false}),
    setChannel: channel => Effect.sync(() => {updater.channel = channel === 'nightly' ? 'beta' : channel}),
    setAllowPrerelease: value => Effect.sync(() => {updater.allowPrerelease = value}),
    allowDowngrade: Effect.sync(() => updater.allowDowngrade),
    setAllowDowngrade: () => Effect.sync(() => {updater.allowDowngrade = false}),
    setFullChangelog: value => Effect.sync(() => {updater.fullChangelog = value}),
    setDisableDifferentialDownload: value => Effect.sync(() => {updater.disableDifferentialDownload = value}),
    checkForUpdates: Effect.suspend(() => Effect.tryPromise({
      try: () => updater.checkForUpdates(),
      catch: cause => new ElectronUpdaterCheckForUpdatesError({ channel: updater.channel, cause })
    }).pipe(Effect.asVoid)),
    downloadUpdate: Effect.suspend(() => Effect.tryPromise({
      try: () => updater.downloadUpdate(),
      catch: cause => new ElectronUpdaterDownloadUpdateError({ channel: updater.channel, cause })
    }).pipe(Effect.asVoid)),
    quitAndInstall: ({ isSilent, isForceRunAfter }) => Effect.tryPromise({
      try: options.install,
      catch: cause => new ElectronUpdaterQuitAndInstallError({
        channel: updater.channel, isSilent, isForceRunAfter, cause
      })
    }),
    on: <Args extends ReadonlyArray<unknown>>(event: string, listener: (...args: Args) => void) => {
      const forward = (...args: Args) => {
        if (event === 'update-available' && typeof (args[0] as UpdateDownloadedEvent | undefined)?.version === 'string') {
          options.checkedOffer((args[0] as UpdateDownloadedEvent).version)
        } else if (event === 'update-not-available') {
          options.checkedOffer(null)
        }
        listener(...args)
      }

      return Effect.acquireRelease(
        Effect.sync(() => {events.on(event, forward)}),
        () => Effect.sync(() => {events.off(event, forward)})
      )
    }
  })
}
