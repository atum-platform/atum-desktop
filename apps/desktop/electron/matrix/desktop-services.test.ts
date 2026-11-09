import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_DESKTOP_SERVICES as channels } from '../../shared/matrix-desktop-services'
import type { ElectronUpdaterPort } from '../desktop-updater'

import { installMatrixDesktopServicesIpc, matrixAfterClose, MatrixDesktopServices } from './desktop-services'
import { requireMatrixCaller } from './ipc-policy'

const temporary: string[] = []
afterEach(() => temporary.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })))

function harness() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-services-'))
  temporary.push(userData)
  const configPath = path.join(userData, 'services.json')
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    observability: {
      posthogKey: 'phc_test00000000', posthogHost: 'https://us.i.posthog.com',
      sentryDsn: 'https://abc@o1.ingest.sentry.io/1', environment: 'test'
    },
    updateFeedUrl: 'https://updates.example.com/desktop/matrix/candidate/mac/arm64/'
  }))
  const sink = {
    event: vi.fn(), error: vi.fn(), feedback: vi.fn(async () => true), discard: vi.fn(), endSession: vi.fn()
  }
  const emitter = new EventEmitter()
  const native = new EventEmitter()
  const updater = Object.assign(emitter, {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: false,
    allowDowngrade: true,
    allowPrerelease: true,
    channel: null,
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn()
  }) as unknown as ElectronUpdaterPort & EventEmitter
  let channel = 'latest'
  const options = {
    configPath,
    userData,
    version: '1.0.0',
    revision: 'a'.repeat(40),
    packaged: true,
    supported: true,
    busy: vi.fn(() => false),
    quit: vi.fn(),
    resetClosing: vi.fn(),
    changed: vi.fn(),
    loadUpdater: vi.fn(async () => updater),
    nativeUpdater: native,
    locale: () => 'en',
    updateSettings: {
      migrate: vi.fn(async () => ({ channel: channel as 'latest' | 'beta', applied: null })),
      getChannel: vi.fn(async () => channel),
      setChannel: vi.fn(async next => {channel = next})
    },
    updaterLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setInterval: vi.fn(),
    log: vi.fn(),
    createSink: vi.fn(() => sink)
  }
  const services = new MatrixDesktopServices(options)

  return { emitter, native, options, services, sink, updater }
}

function downloaded(test: ReturnType<typeof harness>) {
  test.emitter.emit('update-available', { version: '1.1.0' })
  test.emitter.emit('download-progress', { percent: 55 })
  test.emitter.emit('update-downloaded', { version: '1.1.0' })
  test.native.emit('update-downloaded')
}

describe('Matrix desktop services', () => {
  it('uses the stock updater and projects its state through the existing service surface', async () => {
    const test = harness()
    expect(await test.services.start()).toBe(true)
    expect(test.updater.autoDownload).toBe(true)
    expect(test.updater.autoInstallOnAppQuit).toBe(true)
    expect(test.updater.allowDowngrade).toBe(false)
    downloaded(test)
    expect(test.services.status().update).toMatchObject({
      state: 'downloaded', version: '1.1.0', progress: 100, channel: 'latest'
    })
    expect(test.sink.event.mock.calls.filter(([name]) => name === 'update_available')).toHaveLength(1)
    expect(test.sink.event.mock.calls.filter(([name]) => name === 'update_downloaded')).toHaveLength(1)
  })

  it('blocks restart while busy and invokes one install only after successful teardown', async () => {
    const test = harness()
    await test.services.start()
    downloaded(test)
    test.options.busy.mockReturnValue(true)
    expect(test.services.restart()).toBe(false)
    test.options.busy.mockReturnValue(false)
    expect(test.services.restart()).toBe(true)
    expect(test.services.restart()).toBe(false)
    expect(test.options.quit).toHaveBeenCalledOnce()
    expect(test.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(test.services.afterClose(true)).toBe('handled')
    await vi.waitFor(() => expect(test.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true))
    expect(test.services.afterClose(true)).toBe('quit')
  })

  it('leaves ordinary Quit to stock install-on-quit without an explicit handoff', async () => {
    const test = harness()
    await test.services.start()
    downloaded(test)
    expect(test.services.afterClose(false)).toBe('retry')
    expect(test.services.afterClose(true)).toBe('quit')
    await new Promise(resolve => setImmediate(resolve))
    expect(test.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(test.updater.autoInstallOnAppQuit).toBe(true)
  })

  it('cancels restart intent when teardown is refused', async () => {
    const test = harness()
    await test.services.start()
    downloaded(test)
    expect(test.services.restart()).toBe(true)
    expect(matrixAfterClose(test.services, false, true)).toBe('retry')
    expect(test.services.afterClose(true)).toBe('quit')
    await new Promise(resolve => setImmediate(resolve))
    expect(test.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps the app usable when teardown fails after Restart was accepted', async () => {
    const test = harness()
    await test.services.start()
    downloaded(test)
    expect(test.services.restart()).toBe(true)
    expect(test.services.afterClose(false)).toBe('retry')
    expect(test.services.status().update.state).toBe('downloaded')
    expect(test.options.resetClosing).toHaveBeenCalledOnce()
    expect(test.sink.event.mock.calls.filter(([name]) => name === 'update_failed')).toHaveLength(1)
  })

  it('keeps missing or invalid optional configuration from breaking the app', async () => {
    const test = harness()

    for (const contents of [null, '{broken']) {
      if (contents === null) {fs.rmSync(test.options.configPath)} else {fs.writeFileSync(test.options.configPath, contents)}
      const services = new MatrixDesktopServices(test.options)
      expect(services.status().reporting.configured).toBe(false)
      expect(await services.start()).toBe(false)
      expect(services.restart()).toBe(false)
    }
  })

  it('includes in-flight messages in restart busy gating', async () => {
    const test = harness()
    await test.services.start()
    downloaded(test)
    let finish!: (value: string) => void
    const pending = test.services.message(() => new Promise<string>(resolve => {finish = resolve}))
    expect(test.services.status().busy).toBe(true)
    expect(test.services.restart()).toBe(false)
    finish('sent')
    await expect(pending).resolves.toBe('sent')
    expect(test.services.restart()).toBe(true)
  })

  it('accepts settings IPC only from the owned top frame', () => {
    const test = harness()
    const ui = { mainFrame: { url: 'atum-matrix://ui/matrix.html' } }
    const sdk = { mainFrame: { url: 'atum-matrix://sdk/matrix-sdk.html' } }
    const handles = new Map<string, (...args: any[]) => any>()
    installMatrixDesktopServicesIpc({
      services: test.services,
      ipc: {
        handle: (name, callback) => {handles.set(name, callback)},
        on: vi.fn()
      } as any,
      requireUi: event => requireMatrixCaller(event, ui, ui.mainFrame.url),
      requireDiagnostic: event => requireMatrixCaller(event, ui, ui.mainFrame.url)
    })
    expect(() => handles.get(channels.channel)!({ sender: sdk, senderFrame: sdk.mainFrame }, 'beta'))
      .toThrow('matrix_ipc_denied')
  })
})
