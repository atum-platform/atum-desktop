import path from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'

import type { AtumUpdateChannel, AtumUpdateStatus } from '../../shared/atum-update-flow'
import * as DesktopState from '../../vendor/t3-updates/apps/desktop/src/app/DesktopState'
import { ElectronUpdater } from '../../vendor/t3-updates/apps/desktop/src/electron/ElectronUpdater'
import * as Policy from '../../vendor/t3-updates/apps/desktop/src/updates/DesktopUpdatePolicy'
import * as Updates from '../../vendor/t3-updates/apps/desktop/src/updates/DesktopUpdates'
import { createInitialDesktopUpdateState } from '../../vendor/t3-updates/apps/desktop/src/updates/updateMachine'
import type { DesktopRuntimeInfo, DesktopUpdateChannel, DesktopUpdateState } from '../../vendor/t3-updates/packages/contracts/src/desktopUpdates'

import { createMacUpdatePort } from './mac'
import { DesktopAppSettings, DesktopBackendPool, DesktopConfig, DesktopEnvironment, DesktopSshEnvironment, ElectronWindow } from './services'
import type { DesktopUpdateSettings } from './settings-contract'

const wireChannel = (channel: unknown): DesktopUpdateChannel => channel === 'beta' ? 'nightly' : 'latest'
const savedChannel = (channel: DesktopUpdateChannel): AtumUpdateChannel => channel === 'nightly' ? 'beta' : 'latest'

interface Options {
  version: string
  packaged: boolean
  supported: boolean
  feedUrl: string | null
  resources: string
  userData: string
  currentChannel: AtumUpdateChannel | null
  settings: DesktopUpdateSettings
  native: Omit<Parameters<typeof createMacUpdatePort>[0], 'checkedOffer'>
  admit: (expectedVersion: string) => Promise<string | null>
  changed: () => void
  log: (line: string) => void
}

export function createAtumUpdates(options: Options) {
  const arch: DesktopRuntimeInfo['appArch'] = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : 'other'
  const runtimeInfo = { appArch: arch, hostArch: arch, runningUnderArm64Translation: false }
  const disabled = !options.supported || !options.packaged || !options.feedUrl
  let state = createInitialDesktopUpdateState(options.version, runtimeInfo, wireChannel(options.currentChannel))
  let offer: { version: string; channel: DesktopUpdateChannel } | null = null
  let lastAutoOffer: string | null = null
  let started: Promise<boolean> | undefined
  let runtime: { stop: () => Promise<void>; run: <A, E>(effect: Effect.Effect<A,E,Updates.DesktopUpdates>) => Promise<A> } | undefined

  const run = <A, E>(operation: (updates: Updates.DesktopUpdates['Service']) => Effect.Effect<A,E>) =>
    runtime?.run(Effect.flatMap(Updates.DesktopUpdates, operation))

  const publish = (next: DesktopUpdateState) => {
    state = next
    options.changed()

    const key = next.availableVersion && `${next.channel}:${next.availableVersion}`
    if (next.availableVersion === null) {lastAutoOffer = null}
    if (next.status === 'available' && next.errorContext === null && key && key !== lastAutoOffer) {
      lastAutoOffer = key
      // The normal service reservation waits for the in-flight check to finish.
      queueMicrotask(() => {
        void run(updates => updates.download)?.catch(() => options.log('[updates] automatic download failed'))
      })
    }
  }

  return {
    state: () => state,
    status(): AtumUpdateStatus {
      return {
        armed: state.enabled, packaged: options.packaged, channel: savedChannel(state.channel),
        state: state.status === 'disabled' ? 'unavailable' : state.status === 'up-to-date' || state.status === 'available' ? 'idle' : state.status,
        version: state.downloadedVersion ?? state.availableVersion,
        checkedAt: state.checkedAt ? Date.parse(state.checkedAt) : null,
        progress: state.downloadPercent,
        notes: state.releaseNotes[0]?.items ?? [],
        error: state.errorContext && state.message ? { stage: state.errorContext, code: 'failed', message: state.message } : null,
        requiredBelow: null
      }
    },
    start() {
      if (disabled) {return Promise.resolve(false)}
      started ??= (async () => {
        const { channel, deferred } = await options.settings.migrate(options.version)
        if (deferred) {return false}
        state = createInitialDesktopUpdateState(options.version, runtimeInfo, wireChannel(channel))
        const mac = createMacUpdatePort({
          ...options.native,
          checkedOffer: version => {offer = version ? { version, channel: state.channel } : null}
        })
        const settings = DesktopAppSettings.DesktopAppSettings
        const environment = DesktopEnvironment.DesktopEnvironment
        const layer = Layer.mergeAll(
          DesktopState.layer,
          NodeFileSystem.layer,
          Layer.succeed(ElectronUpdater, mac),
          Layer.succeed(DesktopConfig.DesktopConfig, {
            appImagePath: Option.none(), disableAutoUpdate: false, mockUpdates: false, mockUpdateServerPort: 0
          }),
          Layer.succeed(environment, {
            platform: process.platform, runtimeInfo, appVersion: options.version, resourcesPath: options.resources,
            appUpdateYmlPath: path.join(options.resources, 'app-update.yml'),
            baseDir: path.join(options.userData, 'desktop-update'), path,
            defaultDesktopSettings: { updateChannel: wireChannel(channel) },
            isPackaged: options.packaged, isDevelopment: !options.packaged,
            releaseChannelOf: version => version === options.version
              ? wireChannel(options.currentChannel ?? channel)
              : offer?.version === version ? offer.channel : state.channel
          }),
          Layer.succeed(settings, {
            get: Effect.promise(async () => ({ updateChannel: wireChannel(await options.settings.getChannel()) })),
            setUpdateChannel: next => Effect.tryPromise({
              try: () => options.settings.setChannel(savedChannel(next)),
              catch: () => new DesktopAppSettings.DesktopSettingsWriteError('Could not save the update channel.')
            })
          }),
          Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
            list: Effect.succeed([]),
            admit: version => Effect.tryPromise({
              try: () => options.admit(version),
              catch: () => 'Restart preparation failed. Try again.'
            }).pipe(Effect.catch(Effect.succeed))
          }),
          Layer.succeed(ElectronWindow.ElectronWindow, { sendAll: (_, status) => Effect.sync(() => publish(status)) }),
          Layer.succeed(DesktopSshEnvironment.DesktopSshEnvironment, { closeAllTunnels: Effect.void }),
          Policy.layerTest({ mode: 'auto', message: null, allowNightly: true, feedUrl: options.feedUrl ?? undefined })
        )
        const host = ManagedRuntime.make(Updates.layer.pipe(Layer.provide(layer)))
        const scope = Scope.makeUnsafe()
        runtime = {
          run: effect => host.runPromise(effect),
          stop: async () => {
            await Effect.runPromise(Scope.close(scope, Exit.void))
            await host.dispose()
          }
        }
        await host.runPromise(Effect.flatMap(Updates.DesktopUpdates, service => service.configure).pipe(
          Effect.provideService(Scope.Scope, scope)
        ))
        return state.enabled
      })().catch(() => {
        options.log('[updates] initialization failed')
        return false
      })
      return started
    },
    stop: () => runtime?.stop(),
    async setChannel(channel: unknown) {
      if (channel !== 'latest' && channel !== 'beta') {return false}
      // The selected feed supplies release classification. Never authorize a downgrade.
      return Boolean(await run(updates => updates.setChannel(wireChannel(channel), { minimumVersion: options.version }))
        ?.catch(() => undefined))
    },
    async checkNow() {
      return (await run(updates => updates.check('manual')))?.checked ?? false
    },
    async download() {
      return (await run(updates => updates.download))?.accepted ?? false
    },
    async restart(expectedVersion = state.downloadedVersion) {
      if (!expectedVersion || expectedVersion !== state.downloadedVersion) {return false}
      const result = await run(updates => updates.installPrepared(expectedVersion))

      return Boolean(result?.accepted && !result.failed)
    }
  }
}
