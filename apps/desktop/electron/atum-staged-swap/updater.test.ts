import { EventEmitter } from 'node:events'

import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ElectronUpdaterPort } from '../desktop-updater'

import { consumeFailureNotice, isStockOnly } from './store'
import { temporaryRoots } from './test-fixtures'

const fake = vi.hoisted(() => ({ prepare: vi.fn(), install: vi.fn(), begin: vi.fn(), root: '', waiterRunning: false }))

vi.mock('./stage', () => ({
  StagedSwap: class {
    prepare = fake.prepare
    install = fake.install
    beginRestart = fake.begin
    abandon = async () => {}
    get root() {return fake.root}
    get waiterRunning() {return fake.waiterRunning}
  }
}))
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')

  return {
    AppUpdater: class extends EventEmitter {
      logger = { info() {}, warn() {}, error() {} }
      channel = 'latest'
      setFeedURL() {}
      executeDownload(options: { done: (event: unknown) => Promise<unknown> }) {
        return options.done({ version: '1.0.1', downloadedFile: '/cache/pending/update.zip' }).then(() => [])
      }
      dispatchUpdateDownloaded(event: unknown) {this.emit('update-downloaded', event)}
    }
  }
})

const { matchesArchitecture, pickZipFiles, StagedMacUpdater } = await import('./updater')

const roots = temporaryRoots()

afterEach(roots.cleanup)

async function harness(options: { enabled?: () => boolean } = {}) {
  fake.root = await roots.make()
  fake.waiterRunning = false
  fake.prepare.mockReset().mockResolvedValue(undefined)
  fake.install.mockReset().mockResolvedValue(undefined)
  const fallback = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(async () => null), setFeedURL: vi.fn(), quitAndInstall: vi.fn() })
  const exit = vi.fn()
  const reportInstallFailure = vi.fn()

  const updater = new StagedMacUpdater({
    home: '/home/test', id: 'test', target: '/Applications/Test.app', version: '1.0.0', handoffDirectory: '/data/handoff',
    enabled: options.enabled ?? (() => true), log: vi.fn(), fallback: fallback as unknown as ElectronUpdaterPort, exit, reportInstallFailure
  })

  updater.setFeedURL({ provider: 'generic', url: 'https://example.test/' })
  const downloaded = vi.fn()

  updater.on('update-downloaded', downloaded)

  const download = () => (updater as unknown as { doDownloadUpdate(value: DownloadUpdateOptions): Promise<string[]> }).doDownloadUpdate({
    updateInfoAndProvider: {
      info: { version: '1.0.1' },
      provider: { resolveFiles: () => [{ url: new URL('https://example.test/update-arm64.zip'), info: { url: 'update-arm64.zip' } }] }
    },
    disableDifferentialDownload: true
  } as unknown as DownloadUpdateOptions)

  return { updater, fallback, downloaded, download, exit, reportInstallFailure }
}

describe('asset selection', () => {
  const file = (pathname: string, name = pathname) => ({ url: new URL(`https://example.test/${pathname}`), info: { url: name } })

  it('prefers arm64 assets by resolved URL or by the listed name, and never picks x64', () => {
    const arm = file('hash123', 'Atum-arm64-mac.zip')
    const universal = file('Atum-mac.zip')
    const x64 = file('Atum-x64-mac.zip')

    expect(matchesArchitecture(arm, /arm64/u)).toBe(true)
    expect(pickZipFiles([x64, universal, arm])).toEqual([arm])
    expect(pickZipFiles([x64, universal])).toEqual([universal])
  })
})

describe('staged download and stock fallback seam', () => {
  it('withholds ready until preparation completes; Restart consumes the staged app', async () => {
    const h = await harness()
    let complete!: () => void

    fake.prepare.mockImplementation(() => new Promise<void>(resolve => {complete = resolve}))
    const pending = h.download()

    expect(h.updater.stageReady).toBe(false)
    expect(h.downloaded).not.toHaveBeenCalled()
    complete()
    await pending
    expect(h.updater.stageReady).toBe(true)
    expect(h.downloaded).toHaveBeenCalledOnce()
    h.updater.quitAndInstall(false, true)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledOnce())
    expect(fake.install).toHaveBeenCalledWith({ relaunch: true })
    expect(h.exit).toHaveBeenCalledWith(false)
    expect(h.fallback.checkForUpdates).not.toHaveBeenCalled()
  })

  it.each(['disk', 'signature', 'notarization', 'unpack', 'prewarm'])('hands %s failure to stock automatically', async phase => {
    const h = await harness()

    fake.prepare.mockRejectedValue(new Error(phase))
    await h.download()
    expect(h.updater.stageReady).toBe(false)
    expect(h.downloaded).not.toHaveBeenCalled()
    expect(h.fallback.checkForUpdates).toHaveBeenCalledOnce()
    h.updater.quitAndInstall(false, true)
    expect(h.fallback.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(fake.install).not.toHaveBeenCalled()
  })
})

describe('failure after the Restart click', () => {
  async function ready() {
    const h = await harness()

    await h.download()

    return h
  }

  it('never starts a stock download: it remembers stock for that version, exits, and lets the launcher reopen the app', async () => {
    const h = await ready()

    fake.waiterRunning = true
    fake.install.mockRejectedValue(new Error('Old bundle processes still running'))
    h.updater.quitAndInstall(false, true)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledOnce())
    expect(h.exit).toHaveBeenCalledWith(false)
    expect(h.fallback.checkForUpdates).not.toHaveBeenCalled()
    expect(h.fallback.quitAndInstall).not.toHaveBeenCalled()
    expect(isStockOnly(fake.root, '1.0.1')).toBe(true)
    expect(h.reportInstallFailure).toHaveBeenCalledOnce()
    // Reported once, to the version that comes back.
    expect(consumeFailureNotice(fake.root, '1.0.0')).toBe(true)
    expect(consumeFailureNotice(fake.root, '1.0.0')).toBe(false)
  })

  it('exits at once when the launcher restores the backup (rename restore failed)', async () => {
    const h = await ready()

    fake.waiterRunning = true
    fake.install.mockRejectedValue(new AggregateError([new Error('a'), new Error('b')], 'Replacement failed'))
    h.updater.quitAndInstall(false, true)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(false))
    expect(h.fallback.checkForUpdates).not.toHaveBeenCalled()
  })

  it('asks the app to reopen itself when no launcher could be started', async () => {
    const h = await ready()

    fake.waiterRunning = false
    fake.install.mockRejectedValue(new Error('spawn /bin/sh ENOENT'))
    h.updater.quitAndInstall(false, true)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(true))
  })

  it('swaps on an ordinary Quit without reopening the app, and says nothing if that fails', async () => {
    const h = await ready()

    h.updater.quitAndInstall(false, false)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(false))
    expect(fake.install).toHaveBeenCalledWith({ relaunch: false })

    const failing = await ready()

    fake.install.mockRejectedValue(new Error('boom'))
    failing.updater.quitAndInstall(false, false)
    await vi.waitFor(() => expect(failing.exit).toHaveBeenCalledWith(false))
    expect(consumeFailureNotice(fake.root, '1.0.0')).toBe(false)
    expect(isStockOnly(fake.root, '1.0.1')).toBe(true)
  })

  it('quietly reopens the installed app when the switch was turned off between download and click: no swap, no notice, no report, no stock-only mark', async () => {
    let enabled = true
    const h = await harness({ enabled: () => enabled })

    await h.download()
    enabled = false
    h.updater.quitAndInstall(false, true)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalled())
    // No launcher exists, so the app reopens itself; nothing says the update failed.
    expect(h.exit).toHaveBeenCalledWith(true)
    expect(fake.install).not.toHaveBeenCalled()
    expect(h.fallback.checkForUpdates).not.toHaveBeenCalled()
    expect(h.reportInstallFailure).not.toHaveBeenCalled()
    expect(consumeFailureNotice(fake.root, '1.0.0')).toBe(false)
    expect(isStockOnly(fake.root, '1.0.1')).toBe(false)
  })

  it('does the same on an ordinary Quit: the app just closes, quietly', async () => {
    let enabled = true
    const h = await harness({ enabled: () => enabled })

    await h.download()
    enabled = false
    h.updater.quitAndInstall(false, false)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(false))
    expect(fake.install).not.toHaveBeenCalled()
    expect(h.reportInstallFailure).not.toHaveBeenCalled()
    expect(isStockOnly(fake.root, '1.0.1')).toBe(false)
  })

  it('installs once even if asked twice', async () => {
    const h = await ready()

    h.updater.quitAndInstall(false, true)
    h.updater.quitAndInstall(false, true)
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalled())
    expect(fake.install).toHaveBeenCalledOnce()
  })
})
