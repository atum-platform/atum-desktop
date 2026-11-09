/**
 * Private child-process entry for verify-plan7-electron.mjs.
 *
 * This is deliberately not the product Matrix main process.  It is the smallest
 * native Electron host which exercises the released SDK preload/entry bundle and
 * its exact main-process IPC checks against the disposable P7 Synapse fixture.
 * It is bundled into a temporary directory by the verifier and is never part of
 * the Matrix candidate build or package.
 */
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron'

import { requireMatrixCaller } from '../electron/matrix/ipc-policy'
import { MatrixSdkHost } from '../electron/matrix/sdk-host'
import { MATRIX_CHANNELS as channel, type MatrixSdkConfiguration } from '../shared/matrix'

const SDK_URL = 'atum-matrix://sdk/matrix-sdk.html'
const SCHEME = 'atum-matrix'
let phase = 'fixture'
let startupFailed = false
let preloadFailed = false

// Cleaning the last hidden window must not quit before the proof pipe flushes.
app.on('window-all-closed', () => {})

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

interface ProofFixture {
  matrix: MatrixSdkConfiguration
  ownerId: string
  agentId: string
  rooms: { main: string; earlier: string; stray: string }
  ownerDeviceId: string
  workspace: string
}

function argument(name: string): string {
  const value = process.argv.find(item => item.startsWith(`${name}=`))?.slice(name.length + 1)

  if (!value) {throw new Error('electron_proof_argument_invalid')}

  return value
}

function fixtureFrom(file: string): ProofFixture {
  const mode = statSync(file).mode & 0o777

  if ((mode & 0o077) !== 0) {throw new Error('electron_proof_fixture_permissions')}

  const value = JSON.parse(readFileSync(file, 'utf8')) as ProofFixture
  const server = new URL(value.matrix?.baseUrl ?? '')

  if (
    !['127.0.0.1', 'localhost'].includes(server.hostname) ||
    server.protocol !== 'http:' ||
    !value.matrix?.userId?.startsWith('@') ||
    !value.matrix?.deviceId ||
    !value.matrix?.accessToken ||
    !value.matrix?.storageKey ||
    !value.ownerId?.startsWith('@') ||
    !value.agentId?.startsWith('@') ||
    !value.ownerDeviceId ||
    value.matrix.userId !== value.ownerId ||
    value.matrix.deviceId !== value.ownerDeviceId ||
    ![value.rooms?.main, value.rooms?.earlier, value.rooms?.stray].every(room => typeof room === 'string' && room.startsWith('!')) ||
    !path.isAbsolute(value.workspace)
  ) {
    throw new Error('electron_proof_fixture_invalid')
  }

  return value
}

function proofFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''

  return /^electron_proof_(?:argument_invalid|fixture_permissions|fixture_invalid|origin_refused|asset_invalid|timeout)$/.test(message)
    ? message
    : `electron_proof_failed_${phase}_${preloadFailed ? 'preload' : startupFailed ? 'startup' : 'operation'}`
}

function privateDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)

  return directory
}

function expectedEarlier(error: unknown, roomId: string, main: string): boolean {
  if (!(error instanceof Error)) {return false}

  const value = error as Error & { code?: unknown; roomId?: unknown; main?: unknown }

  return (
    value.message === 'matrix_earlier_conversation' &&
    value.code === 'matrix_earlier_conversation' &&
    value.roomId === roomId &&
    value.main === main &&
    JSON.stringify(value).includes('synthetic-never-forward') === false
  )
}

async function run(): Promise<string[]> {
  const fixture = fixtureFrom(argument('--fixture'))
  const assets = argument('--assets')
  const assetRoot = path.resolve(assets)
  const server = new URL(fixture.matrix.baseUrl)
  const partition = `persist:atum-plan7-electron-${process.pid}`
  const checks: string[] = []
  let window: BrowserWindow | undefined
  let host: MatrixSdkHost | undefined
  let configurationSeen = false

  app.setPath('userData', privateDirectory(path.join(fixture.workspace, 'electron-user-data')))
  app.setPath('sessionData', privateDirectory(path.join(fixture.workspace, 'electron-session-data')))

  phase = 'ready'
  await app.whenReady()

  const proofSession = session.fromPartition(partition)
  proofSession.webRequest.onBeforeRequest((details, done) => {
    try {
      const target = new URL(details.url)
      const allowed = target.protocol === `${SCHEME}:` || target.origin === server.origin

      done({ cancel: !allowed })
    } catch {
      done({ cancel: true })
    }
  })

  proofSession.protocol.handle(SCHEME, request => {
    const target = new URL(request.url)
    const relative = target.pathname.replace(/^\//, '')

    if (target.host !== 'sdk' || !/^(?:matrix-sdk\.html|matrix-sdk\.js|pkg\/matrix_sdk_crypto_wasm_bg\.wasm)$/.test(relative)) {
      throw new Error('electron_proof_asset_invalid')
    }

    const file = path.resolve(assetRoot, relative)

    if (!file.startsWith(`${assetRoot}${path.sep}`)) {throw new Error('electron_proof_asset_invalid')}

    return net.fetch(pathToFileURL(file).href)
  })

  try {
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(assetRoot, 'matrix-sdk-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition,
        webSecurity: true
      }
    })

    const caller = () => {
      if (!window) {throw new Error('electron_proof_timeout')}

      return window.webContents
    }

    const requireSdkCaller = (event: Parameters<typeof requireMatrixCaller>[0]) => requireMatrixCaller(event, caller(), SDK_URL)

    ipcMain.handle(channel.sdkConfig, event => {
      requireSdkCaller(event)
      configurationSeen = true

      return fixture.matrix
    })
    ipcMain.handle(channel.sdkRefresh, event => {
      requireSdkCaller(event)

      return { ok: false, reauthenticate: false }
    })
    ipcMain.on(channel.sdkSnapshot, (event, value: unknown) => {
      requireSdkCaller(event)
      startupFailed ||= (value as { error?: unknown } | null)?.error === 'matrix_sdk_start_failed'
    })
    ipcMain.on(channel.sdkInvocation, event => requireSdkCaller(event))
    ipcMain.on(channel.sdkNotification, event => requireSdkCaller(event))
    ipcMain.on(channel.sdkGoogleFence, event => requireSdkCaller(event))
    ipcMain.on(channel.sdkUndecryptable, event => requireSdkCaller(event))

    host = new MatrixSdkHost(
      (id, value) => caller().send(channel.sdkCommand, id, value),
      () => window?.isDestroyed() || window?.destroy()
    )
    ipcMain.on(channel.sdkResult, (event, id: unknown, ok: unknown, value: unknown) => {
      requireSdkCaller(event)
      host?.result(typeof id === 'string' ? id : '', ok === true, value)
    })

    window.webContents.on('preload-error', () => { preloadFailed = true })
    phase = 'load'
    await window.loadURL(SDK_URL)
    phase = 'main'
    await host.command(
      { kind: 'readAssistantRoom', roomId: fixture.rooms.main, ownerId: fixture.ownerId, agentId: fixture.agentId, forTurn: true },
      90_000
    )

    if (!configurationSeen) {throw new Error('electron_proof_timeout')}
    checks.push('electron-sdk-preload-authenticated')
    checks.push('electron-sdk-for-turn-main-admitted')

    for (const [name, roomId] of [
      ['electron-sdk-for-turn-earlier-refused', fixture.rooms.earlier],
      ['electron-sdk-for-turn-stray-refused', fixture.rooms.stray]
    ] as const) {
      phase = name.includes('stray') ? 'stray' : 'earlier'
      try {
        await host.command(
          { kind: 'readAssistantRoom', roomId, ownerId: fixture.ownerId, agentId: fixture.agentId, forTurn: true },
          30_000
        )
        throw new Error('electron_proof_timeout')
      } catch (error) {
        if (!expectedEarlier(error, roomId, fixture.rooms.main)) {throw new Error('electron_proof_timeout')}
      }

      checks.push(name)
    }

    phase = 'display'
    await host.command(
      { kind: 'readAssistantRoom', roomId: fixture.rooms.earlier, ownerId: fixture.ownerId, agentId: fixture.agentId, forTurn: false },
      30_000
    )
    checks.push('electron-sdk-display-earlier-admitted')

    phase = 'marker'
    const marker = await host.command(
      { kind: 'readConversationMarker', roomId: fixture.rooms.earlier, ownerId: fixture.ownerId, agentId: fixture.agentId },
      30_000
    )

    if (
      !marker ||
      typeof marker !== 'object' ||
      Array.isArray(marker) ||
      Object.keys(marker).sort().join(',') !== 'at,main,role' ||
      (marker as { role?: unknown }).role !== 'earlier' ||
      (marker as { main?: unknown }).main !== fixture.rooms.main ||
      typeof (marker as { at?: unknown }).at !== 'number'
    ) {
      throw new Error('electron_proof_timeout')
    }

    checks.push('electron-sdk-marker-projection-closed')

    return checks
  } finally {
    try {
      await host?.stop()
    } catch {
      host?.close()
    }

    window?.isDestroyed() || window?.destroy()
    await proofSession.clearStorageData().catch(() => {})
  }
}

/** Quit only after the fixed proof receipt has flushed through the parent pipe. */
function report(message: { type: string; checks?: string[]; code?: string }): Promise<void> {
  return new Promise(resolve => {
    if (typeof process.send !== 'function') {
      app.exit(66)
      resolve()
      return
    }
    process.send(message, () => resolve())
  })
}

void run()
  .then(checks => report({ type: 'plan7-electron-proof', checks }))
  .catch(error => report({ type: 'plan7-electron-proof-failed', code: proofFailure(error) }))
  .finally(() => app.quit())
