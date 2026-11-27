import type path from 'node:path'

import * as Context from 'effect/Context'
import type * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'

import type { DesktopRuntimeInfo, DesktopUpdateChannel, DesktopUpdateState } from '../../vendor/t3-updates/packages/contracts/src/desktopUpdates'

interface Settings {
  updateChannel: DesktopUpdateChannel
}

export namespace DesktopConfig {
  export class DesktopConfig extends Context.Service<DesktopConfig, {
    appImagePath: Option.Option<string>
    disableAutoUpdate: boolean
    mockUpdates: boolean
    mockUpdateServerPort: number
  }>()('Atum/UpdateConfig') {}
}

export namespace DesktopEnvironment {
  export class DesktopEnvironment extends Context.Service<DesktopEnvironment, {
    appVersion: string
    appUpdateYmlPath: string
    baseDir: string
    defaultDesktopSettings: Settings
    isDevelopment: boolean
    isPackaged: boolean
    path: Pick<typeof path, 'join'>
    platform: NodeJS.Platform
    resourcesPath: string
    runtimeInfo: DesktopRuntimeInfo
    releaseChannelOf(version: string): DesktopUpdateChannel
  }>()('Atum/UpdateEnvironment') {}
}

export namespace DesktopBackendPool {
  export interface DesktopBackendInstance {
    readonly id: string
    snapshot: Effect.Effect<{ desiredRunning: boolean }>
    start: Effect.Effect<void>
    stop(options: { timeout: Duration.Duration }): Effect.Effect<void>
  }

  export class DesktopBackendPool extends Context.Service<DesktopBackendPool, {
    list: Effect.Effect<ReadonlyArray<DesktopBackendInstance>>
    admit(expectedVersion: string): Effect.Effect<string | null>
  }>()('Atum/UpdateBackendPool') {}
}

export interface BackendStartupFailure { message: string }

export const DesktopBackendManager = { BACKEND_QUIT_STOP_TIMEOUT: '30 seconds' as const }

export namespace DesktopAppSettings {
  export class DesktopSettingsWriteError extends Error {}

  export class DesktopAppSettings extends Context.Service<DesktopAppSettings, {
    get: Effect.Effect<Settings>
    setUpdateChannel(channel: DesktopUpdateChannel): Effect.Effect<void, DesktopSettingsWriteError>
  }>()('Atum/UpdateSettings') {}
}

export namespace DesktopSshEnvironment {
  export class DesktopSshEnvironment extends Context.Service<DesktopSshEnvironment, {
    closeAllTunnels: Effect.Effect<void>
  }>()('Atum/UpdateTunnels') {}
}

export namespace ElectronWindow {
  export class ElectronWindow extends Context.Service<ElectronWindow, {
    sendAll(channel: string, state: DesktopUpdateState): Effect.Effect<void>
  }>()('Atum/UpdateWindow') {}
}

export const IpcChannels = { UPDATE_STATE_CHANNEL: 'atum:update:state' }

export const DesktopObservability = {
  makeComponentLogger(component: string) {
    const log = (message: string, _fields?: object) => Effect.sync(() => console.info(`[${component}] ${message}`))
    return { logInfo: log, logWarning: log, logError: log }
  }
}
