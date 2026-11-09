import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import type { AtumUpdateChannel } from '../shared/atum-update-flow'

import {
  ATUM_UPDATE_INTERVAL_MS,
  createDesktopUpdater,
  type DesktopUpdateSettings,
  type ElectronUpdaterPort
} from './desktop-updater'

function flush() {
  return new Promise<void>(resolve => setImmediate(resolve))
}

function harness(overrides: Partial<Parameters<typeof createDesktopUpdater>[0]> = {}) {
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
  native.on('error', error => emitter.emit('error', error))
  let assignedChannel: string | null = null
  Object.defineProperty(updater, 'channel', {
    configurable: true,
    get: () => assignedChannel,
    set: value => {
      assignedChannel = value
      updater.allowDowngrade = true
    }
  })
  let persisted: AtumUpdateChannel = 'beta'
  const settings: DesktopUpdateSettings = {
    migrate: vi.fn(async currentVersion => ({ channel: persisted, applied: null })),
    getChannel: vi.fn(async () => persisted),
    setChannel: vi.fn(async next => {persisted = next})
  }
  const deferred: Array<() => void> = []
  const changed = vi.fn()
  const record = vi.fn()
  const quit = vi.fn()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const setInterval = vi.fn()
  const installTimers: Array<() => void> = []

  const setInstallTimer = vi.fn((callback: () => void) => {installTimers.push(callback);

 return callback})

  const clearInstallTimer = vi.fn()
  const stagingTimers: Array<() => void> = []

  const setStagingTimer = vi.fn((callback: () => void) => {stagingTimers.push(callback);

 return callback})

  const clearStagingTimer = vi.fn()
  let busy = false
  const controller = createDesktopUpdater({
    busy: () => busy,
    changed,
    currentVersion: '1.0.0',
    defer: callback => deferred.push(callback),
    feedUrl: 'https://updates.example/mac/arm64/',
    isPackaged: true,
    loadUpdater: vi.fn(async () => updater),
    logger,
    nativeUpdater: native,
    notify: vi.fn(),
    quit,
    record,
    setInterval,
    setInstallTimer,
    clearInstallTimer,
    installWatchdogMs: 90_000,
    setStagingTimer,
    clearStagingTimer,
    stagingDeadlineMs: 15 * 60_000,
    settings,
    supported: true,
    ...overrides
  } as Parameters<typeof createDesktopUpdater>[0])

  return {
    changed, clearInstallTimer, clearStagingTimer, controller, deferred, installTimers, logger, native, quit, record,
    setInstallTimer, setStagingTimer, stagingTimers, setBusy: (value: boolean) => {busy = value},
    settings, setInterval, updater
  }
}

describe('stock desktop updater adapter', () => {
  it('is inert when ineligible and configures the stock updater when eligible', async () => {
    for (const options of [{ isPackaged: false }, { supported: false }, { feedUrl: null }]) {
      const test = harness(options)
      expect(await test.controller.start()).toBe(false)
      expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
    }

    const test = harness()
    expect(await test.controller.start()).toBe(true)
    expect(test.updater.logger).toBe(test.logger)
    expect(test.updater.autoDownload).toBe(true)
    expect(test.updater.autoInstallOnAppQuit).toBe(true)
    expect(test.updater.autoRunAppAfterInstall).toBe(true)
    expect(test.updater.channel).toBe('beta')
    expect(test.updater.allowDowngrade).toBe(false)
    expect(test.updater.allowPrerelease).toBe(false)
    expect(test.updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic', url: 'https://updates.example/mac/arm64/'
    })
    expect(test.updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(test.setInterval).toHaveBeenCalledWith(expect.any(Function), ATUM_UPDATE_INTERVAL_MS)
  })

  it('projects stock events, keeps plain notes, and does not hide a downloaded update after an error', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('checking-for-update')
    expect(test.controller.status().state).toBe('checking')
    test.updater.emit('update-available', {
      version: '1.1.0', releaseNotes: '<b>Faster</b>\n- [Safer](https://example.com) updates'
    })
    test.updater.emit('download-progress', { percent: 42.5 })
    expect(test.controller.status()).toMatchObject({
      state: 'downloading', version: '1.1.0', progress: 42.5, notes: ['Faster', 'Safer updates']
    })
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.status()).toMatchObject({ state: 'downloaded', version: '1.1.0', progress: 100 })
    test.updater.emit('error', new Error('connect ETIMEDOUT'))
    expect(test.controller.status()).toMatchObject({ state: 'downloaded', version: '1.1.0', error: null })
    expect(test.record.mock.calls.filter(([event]) => event.name === 'update_available')).toHaveLength(1)
    expect(test.record.mock.calls.filter(([event]) => event.name === 'update_downloaded')).toHaveLength(1)
    expect(test.record).toHaveBeenCalledWith({
      name: 'update_failed', properties: { stage: 'check', code: 'transport' }
    })
  })

  it('invokes one quitAndInstall only after a successful teardown barrier', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    test.setBusy(true)
    expect(test.controller.restart()).toBe(false)
    test.setBusy(false)
    expect(test.controller.restart()).toBe(true)
    expect(test.controller.restart()).toBe(false)
    expect(test.quit).toHaveBeenCalledOnce()
    expect(test.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(test.controller.afterTeardown()).toBe(true)
    expect(test.controller.afterTeardown()).toBe(false)
    expect(test.updater.quitAndInstall).not.toHaveBeenCalled()
    test.deferred.splice(0).forEach(callback => callback())
    expect(test.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it('cancels restart intent when teardown fails', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.restart()).toBe(true)
    test.controller.cancelRestart()
    expect(test.controller.afterTeardown()).toBe(false)
    test.deferred.splice(0).forEach(callback => callback())
    expect(test.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('persists a channel before applying authoritative readback and triggers one fresh check', async () => {
    const order: string[] = []
    let persisted: AtumUpdateChannel = 'latest'
    const settings: DesktopUpdateSettings = {
      migrate: async () => ({ channel: persisted, applied: null }),
      setChannel: async next => {order.push(`persist:${next}`); persisted = next},
      getChannel: async () => {order.push(`read:${persisted}`);

 return persisted}
    }
    const test = harness({ settings })
    let assigned = ''
    Object.defineProperty(test.updater, 'channel', {
      configurable: true,
      get: () => assigned,
      set: value => {assigned = value; order.push(`apply:${value}`)}
    })
    await test.controller.start()
    await flush()
    test.updater.emit('update-not-available')
    order.length = 0
    vi.mocked(test.updater.checkForUpdates).mockClear()
    expect(await test.controller.setChannel('beta')).toBe(true)
    await flush()
    expect(order.slice(0, 3)).toEqual(['persist:beta', 'read:beta', 'apply:beta'])
    expect(test.updater.allowDowngrade).toBe(false)
    expect(test.controller.status().channel).toBe('beta')
    expect(test.updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it.each([
    ['latest', 'beta'],
    ['beta', 'latest']
  ] as const)('reserves a %s to %s channel change against checks and overlapping requests', async (from, to) => {
    let release!: () => void
    let persisted: AtumUpdateChannel = from
    const settings: DesktopUpdateSettings = {
      migrate: async () => ({ channel: persisted, applied: null }),
      setChannel: vi.fn(async next => {
        await new Promise<void>(resolve => {release = resolve})
        persisted = next
      }),
      getChannel: vi.fn(async () => persisted)
    }
    const test = harness({ settings })
    await test.controller.start()
    await flush()
    test.updater.emit('update-not-available')
    vi.mocked(test.updater.checkForUpdates).mockClear()

    const changing = test.controller.setChannel(to)
    expect(test.controller.checkNow()).toBe(true)
    test.setInterval.mock.calls[0]![0]()
    expect(await test.controller.setChannel(from)).toBe(false)
    await flush()
    expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
    test.updater.emit('update-available', { version: '9.9.9' })
    test.updater.emit('update-downloaded', { version: '9.9.9' })
    test.native.emit('update-downloaded')
    expect(test.controller.status()).toMatchObject({ channel: from, state: 'idle', version: null })

    release()
    await expect(changing).resolves.toBe(true)
    await flush()
    expect(test.controller.status()).toMatchObject({ channel: to, state: 'checking' })
    expect(test.updater.channel).toBe(to)
    expect(test.updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('uses bounded localized notes only when the standard manifest has none', async () => {
    const notes = { read: vi.fn(async () => ['Localized note', 'x'.repeat(200), '', 'ignored fourth']) }
    const test = harness({ locale: 'en', notes })
    await test.controller.start()
    test.updater.emit('update-available', { version: '1.1.0' })
    await flush()
    expect(test.controller.status().notes).toEqual(['Localized note', 'x'.repeat(140), 'ignored fourth'])
    expect(notes.read).toHaveBeenCalledWith('1.1.0', 'en')
    expect(test.controller.status().state).toBe('downloading')
  })

  it('waits for native Squirrel readiness and surfaces a native error before Restart is offered', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-available', { version: '1.1.0' })
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    expect(test.controller.status()).toMatchObject({ state: 'preparing', progress: null })
    test.native.emit('error', new Error('SQRL staging failed'))
    expect(test.controller.status()).toMatchObject({
      state: 'error', error: { stage: 'download', code: 'failed' }
    })
    expect(test.controller.restart()).toBe(false)
  })

  it('quits if the updater errors after teardown has handed off installation', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.restart()).toBe(true)
    test.quit.mockClear()
    expect(test.controller.afterTeardown()).toBe(true)
    test.updater.emit('error', new Error('native install failed'))
    expect(test.quit).toHaveBeenCalledOnce()
  })

  it('bounds the post-teardown install handoff with a watchdog that quits', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.restart()).toBe(true)
    test.quit.mockClear()
    expect(test.controller.afterTeardown()).toBe(true)
    test.deferred.splice(0).forEach(callback => callback())
    expect(test.installTimers).toHaveLength(1)
    expect(test.setInstallTimer).toHaveBeenCalledWith(expect.any(Function), 90_000)
    test.installTimers[0]!()
    expect(test.quit).toHaveBeenCalledOnce()
  })

  it('does not check upstream while an update is downloading or downloaded', async () => {
    const test = harness()
    await test.controller.start()
    await flush()
    test.updater.emit('update-available', { version: '1.1.0' })
    vi.mocked(test.updater.checkForUpdates).mockClear()
    expect(test.controller.checkNow()).toBe(true)
    test.setInterval.mock.calls[0]![0]()
    await flush()
    expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.checkNow()).toBe(true)
    test.setInterval.mock.calls[0]![0]()
    await flush()
    expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('holds check coalescing through the stock downloadPromise', async () => {
    const test = harness()
    let finish!: () => void
    vi.mocked(test.updater.checkForUpdates).mockResolvedValueOnce({
      downloadPromise: new Promise<void>(resolve => {finish = resolve})
    })
    await test.controller.start()
    await flush()
    test.setInterval.mock.calls[0]![0]()
    await flush()
    expect(test.updater.checkForUpdates).toHaveBeenCalledOnce()
    finish()
    await flush()
    test.setInterval.mock.calls[0]![0]()
    await flush()
    expect(test.updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('holds the native identity lease through the stock downloadPromise', async () => {
    let finish!: () => void
    const release = vi.fn(async () => undefined)
    const nativeStateLease = vi.fn(async () => release)
    const test = harness({ nativeStateLease })
    vi.mocked(test.updater.checkForUpdates).mockResolvedValueOnce({
      downloadPromise: new Promise<void>(resolve => {finish = resolve})
    })

    await test.controller.start()
    await flush()
    expect(nativeStateLease).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    finish()
    await flush()
    expect(release).toHaveBeenCalledOnce()
  })

  it('still arms and schedules when settings migration cannot write', async () => {
    const test = harness({
      settings: {
        migrate: vi.fn(async () => {throw Object.assign(new Error('read-only'), { code: 'EACCES' })}),
        getChannel: vi.fn(async () => 'beta'),
        setChannel: vi.fn(async () => undefined)
      }
    })
    expect(await test.controller.start()).toBe(true)
    expect(test.controller.status()).toMatchObject({ armed: true, channel: 'beta' })
    expect(test.setInterval).toHaveBeenCalledWith(expect.any(Function), ATUM_UPDATE_INTERVAL_MS)
  })

  it('checks and schedules when native-state migration defers to the next launch', async () => {
    const test = harness({
      settings: {
        migrate: vi.fn(async () => ({ channel: 'beta' as const, applied: null, deferred: true })),
        getChannel: vi.fn(async () => 'beta'),
        setChannel: vi.fn(async () => undefined)
      }
    })

    expect(await test.controller.start()).toBe(true)
    await flush()
    expect(test.controller.status()).toMatchObject({ armed: true, channel: 'beta' })
    expect(test.updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(test.setInterval).toHaveBeenCalledWith(expect.any(Function), ATUM_UPDATE_INTERVAL_MS)
  })

  it('models electron-updater channel assignment enabling downgrade before the adapter disables it', () => {
    const test = harness()
    test.updater.allowDowngrade = false
    test.updater.channel = 'beta'
    expect(test.updater.allowDowngrade).toBe(true)
  })

  it('shows restarting immediately after Restart is accepted', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.restart()).toBe(true)
    expect(test.controller.status().state).toBe('restarting')
  })

  it('refuses a wrong-hash download before native readiness or install', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-available', { version: '1.1.0' })
    test.updater.emit('error', new Error('sha512 checksum mismatch'))
    expect(test.controller.status()).toMatchObject({
      state: 'error', error: { stage: 'download', code: 'hash_mismatch' }
    })
    expect(test.controller.restart()).toBe(false)
    expect(test.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps restarting authoritative when an error arrives during teardown', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.restart()).toBe(true)
    test.updater.emit('error', new Error('teardown-time error'))
    expect(test.controller.status().state).toBe('restarting')
  })

  it('publishes checking synchronously when a manual retry really starts', async () => {
    const test = harness()
    vi.mocked(test.updater.checkForUpdates).mockRejectedValueOnce(new Error('offline'))
    await test.controller.start()
    await flush()
    expect(test.controller.status().state).toBe('error')
    vi.mocked(test.updater.checkForUpdates).mockResolvedValueOnce(undefined)
    expect(test.controller.checkNow()).toBe(true)
    expect(test.controller.status()).toMatchObject({ state: 'checking', error: null })
  })

  it('quarantines an unresolved stock operation after the native staging deadline', async () => {
    const test = harness()
    let settle!: () => void
    vi.mocked(test.updater.checkForUpdates).mockResolvedValueOnce({
      downloadPromise: new Promise<void>(resolve => {settle = resolve})
    })
    await test.controller.start()
    await flush()
    test.updater.emit('update-available', { version: '1.1.0' })
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    expect(test.setStagingTimer).toHaveBeenCalledWith(expect.any(Function), 15 * 60_000)
    vi.mocked(test.updater.checkForUpdates).mockClear()
    test.stagingTimers[0]!()
    expect(test.controller.status()).toMatchObject({
      state: 'error', error: { stage: 'download', recovery: 'manual_download' }
    })
    expect(test.controller.checkNow()).toBe(false)
    test.setInterval.mock.calls[0]![0]()
    await flush()
    expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
    test.native.emit('update-downloaded')
    test.native.emit('error', new Error('late native failure'))
    test.updater.emit('update-available', { version: '1.2.0' })
    expect(test.controller.status()).toMatchObject({
      state: 'error', error: { stage: 'download', recovery: 'manual_download' }
    })
    settle()
    await flush()
    expect(test.controller.checkNow()).toBe(false)
    expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('skips automatic restaging after a native error but lets a manual check retry', async () => {
    const test = harness()
    await test.controller.start()
    await flush()
    test.updater.emit('update-available', { version: '1.1.0' })
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('error', new Error('SQRL staging failed'))
    vi.mocked(test.updater.checkForUpdates).mockClear()
    test.setInterval.mock.calls[0]![0]()
    await flush()
    expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(test.controller.checkNow()).toBe(true)
    await flush()
    expect(test.updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('handles one forwarded native handoff error with one failure and one quit', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.restart()).toBe(true)
    test.quit.mockClear()
    expect(test.controller.afterTeardown()).toBe(true)
    test.native.emit('error', new Error('native install failed'))
    expect(test.quit).toHaveBeenCalledOnce()
    expect(test.record.mock.calls.filter(([event]) => event.name === 'update_failed')).toHaveLength(1)
  })

  it('ignores duplicate downloaded events and clears stale native readiness after failure', async () => {
    const test = harness()
    await test.controller.start()
    test.updater.emit('update-available', { version: '1.1.0' })
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.updater.emit('error', new Error('staging failed'))
    expect(test.controller.status().state).toBe('error')
    expect(test.controller.checkNow()).toBe(true)
    test.updater.emit('update-available', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.status().state).toBe('downloading')
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')
    expect(test.controller.status().state).toBe('downloaded')
    test.updater.emit('update-downloaded', { version: '1.2.0' })
    expect(test.controller.status()).toMatchObject({ state: 'downloaded', version: '1.1.0' })
  })
})

it('refuses low disk visibly before invoking stock download', async () => {
  const release = vi.fn(async () => {})
  const prepareDownload = vi.fn(async () => {throw Object.assign(new Error('Insufficient free space'), { requiredBytes: 6e9 })})
  const test = harness({ prepareDownload, nativeStateLease: async () => release })
  test.updater.downloadUpdate = vi.fn(async () => {})
  vi.mocked(test.updater.checkForUpdates).mockImplementation(async () => {
    test.updater.emit('update-available', { version: '1.1.0', files: [{ size: 700e6 }] })

    return undefined
  })
  await test.controller.start()
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  expect(test.updater.autoDownload).toBe(false)
  expect(test.updater.downloadUpdate).not.toHaveBeenCalled()
  expect(test.controller.status()).toMatchObject({ state: 'error', error: { code: 'disk_space', requiredBytes: 6e9, stage: 'download' } })
})

it('shows preparing after transfer and waits for native verification to enable Restart', async () => {
  const test = harness()
  await test.controller.start()
  test.updater.emit('update-available', { version: '1.1.0' })
  test.updater.emit('download-progress', { percent: 100 })
  expect(test.controller.status()).toMatchObject({ state: 'preparing', progress: null })
  expect(test.controller.restart()).toBe(false)
  test.updater.emit('update-downloaded', { version: '1.1.0' })
  expect(test.controller.status().state).toBe('preparing')
  test.native.emit('update-downloaded')
  expect(test.controller.status().state).toBe('downloaded')
})

it.each(['restart', 'ordinary-quit'])('resumes aborted native Restart on %s without checking or staging again', async mode => {
  const install = vi.fn(async () => {})
  const beforeInstall = vi.fn()
  const forceExit = vi.fn()
  const test = harness({ recoverPendingInstall: async () => ({ version: '1.1.0', install }), beforeInstall, forceExit })
  await test.controller.start()
  expect(test.controller.status()).toMatchObject({ state: 'downloaded', version: '1.1.0' })
  expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
  test.controller.checkNow()

  if (mode === 'restart') {expect(test.controller.restart()).toBe(true)}
  expect(test.controller.afterTeardown()).toBe(true)
  expect(test.controller.afterTeardown()).toBe(false)
  test.deferred.splice(0).forEach(callback => callback())
  await flush()
  expect(beforeInstall).toHaveBeenCalledOnce()
  expect(install).toHaveBeenCalledOnce()
  expect(test.quit).toHaveBeenCalled()
  expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
  expect(test.updater.quitAndInstall).not.toHaveBeenCalled()
  test.installTimers[0]!()
  expect(forceExit).toHaveBeenCalledOnce()
})

it('does not start a competing check while an existing native request is being recovered', async () => {
  let complete!: (value: { version: string; install(): Promise<void> }) => void
  const pending = new Promise<{ version: string; install(): Promise<void> }>(resolve => {complete = resolve})
  const test = harness({ recoverPendingInstall: () => pending })
  const started = test.controller.start()
  await flush()
  expect(test.controller.checkNow()).toBe(true)
  expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
  complete({ version: '1.1.0', install: async () => {} })
  await started
  expect(test.controller.status().state).toBe('downloaded')
  expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
})

describe('restart continuity', () => {
  function feedback() {
    return { begin: vi.fn(), cancel: vi.fn(), fail: vi.fn() }
  }

  async function ready(overrides: Partial<Parameters<typeof createDesktopUpdater>[0]> = {}) {
    const test = harness(overrides)
    await test.controller.start()
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    test.native.emit('update-downloaded')

    return test
  }

  it('shows progress from the Restart click, and never while the update is only downloading or preparing', async () => {
    const restartFeedback = feedback()
    const test = harness({ restartFeedback })
    await test.controller.start()
    test.updater.emit('update-available', { version: '1.1.0' })
    expect(test.controller.restart()).toBe(false)
    test.updater.emit('update-downloaded', { version: '1.1.0' })
    expect(test.controller.status().state).toBe('preparing')
    expect(test.controller.restart()).toBe(false)
    expect(restartFeedback.begin).not.toHaveBeenCalled()
    test.native.emit('update-downloaded')
    expect(test.controller.restart()).toBe(true)
    expect(restartFeedback.begin).toHaveBeenCalledExactlyOnceWith('1.1.0')
    expect(test.controller.status().state).toBe('restarting')
  })

  it('takes the progress window down when the quit is refused', async () => {
    const restartFeedback = feedback()
    const test = await ready({ restartFeedback })
    test.controller.restart()
    test.controller.cancelRestart()
    expect(restartFeedback.cancel).toHaveBeenCalledOnce()
    expect(test.controller.status().state).toBe('downloaded')
    test.controller.cancelRestart()
    expect(restartFeedback.cancel).toHaveBeenCalledOnce()
  })

  it('tells the progress window when the install handoff fails, but not when the exit watchdog fires', async () => {
    const restartFeedback = feedback()
    const test = await ready({ restartFeedback })
    test.controller.restart()
    test.controller.afterTeardown()
    test.deferred.splice(0).forEach(callback => callback())
    test.installTimers[0]!()
    expect(restartFeedback.fail).not.toHaveBeenCalled()

    const failing = await ready({ restartFeedback })
    failing.controller.restart()
    failing.controller.afterTeardown()
    failing.updater.emit('error', new Error('native install failed'))
    expect(restartFeedback.fail).toHaveBeenCalledOnce()
  })

  it('never lets the progress window block Restart', async () => {
    const restartFeedback = { begin: vi.fn(() => {throw new Error('osascript missing')}), cancel: vi.fn(), fail: vi.fn() }
    const test = await ready({ restartFeedback })
    expect(test.controller.restart()).toBe(true)
    expect(test.quit).toHaveBeenCalledOnce()
    expect(test.controller.afterTeardown()).toBe(true)
    test.deferred.splice(0).forEach(callback => callback())
    expect(test.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it('says plainly when the previous Restart came back on the same version', async () => {
    const test = harness({ previousRestart: { outcome: 'not_updated' } })
    await test.controller.start()
    expect(test.controller.status()).toMatchObject({
      state: 'error', error: { code: 'failed', stage: 'install' }
    })
    expect(test.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(test.record).toHaveBeenCalledWith({ name: 'update_failed', properties: { stage: 'install', code: 'failed' } })
    expect(test.controller.checkNow()).toBe(true)
    await flush()
    expect(test.updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('checks as usual after a successful Restart, and a still-pending native install wins over the failure', async () => {
    const updated = harness({ previousRestart: { outcome: 'updated' } })
    await updated.controller.start()
    await flush()
    expect(updated.updater.checkForUpdates).toHaveBeenCalledOnce()

    const pending = harness({
      previousRestart: { outcome: 'not_updated' },
      recoverPendingInstall: async () => ({ version: '1.1.0', install: async () => {} })
    })
    await pending.controller.start()
    expect(pending.controller.status()).toMatchObject({ state: 'downloaded', version: '1.1.0', error: null })
  })
})


it('accepts staged readiness without inventing a native Squirrel event and starts the snapshot at Restart', async () => {
  const test = harness()
  const beginRestart = vi.fn()
  Object.assign(test.updater, { stageReady: true, beginRestart })
  await test.controller.start()
  test.updater.emit('update-available', { version: '1.1.0' })
  expect(test.controller.status().state).toBe('downloading')
  test.updater.emit('update-downloaded', { version: '1.1.0' })
  expect(test.controller.status().state).toBe('downloaded')
  expect(test.controller.restart()).toBe(true)
  expect(beginRestart).toHaveBeenCalledOnce()
  expect(test.quit).toHaveBeenCalledOnce()
})

describe('ordinary Quit with a prepared staged update', () => {
  it('installs it without reopening the app, but never for a stock update', async () => {
    const staged = harness()

    Object.assign(staged.updater, { stageReady: true })
    await staged.controller.start()
    staged.updater.emit('update-downloaded', { version: '1.1.0' })
    expect(staged.controller.status().state).toBe('downloaded')
    expect(staged.controller.afterTeardown()).toBe(true)
    staged.deferred.splice(0).forEach(callback => callback())
    expect(staged.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, false)

    const stock = harness()

    await stock.controller.start()
    stock.updater.emit('update-downloaded', { version: '1.1.0' })
    stock.native.emit('update-downloaded')
    expect(stock.controller.afterTeardown()).toBe(false)
    stock.deferred.splice(0).forEach(callback => callback())
    expect(stock.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps the ten-second exit backstop, which a staged swap cannot be interrupted by', async () => {
    const staged = harness({ installWatchdogMs: undefined })

    Object.assign(staged.updater, { stageReady: true })
    await staged.controller.start()
    staged.updater.emit('update-downloaded', { version: '1.1.0' })
    expect(staged.controller.restart()).toBe(true)
    expect(staged.controller.afterTeardown()).toBe(true)
    staged.deferred.splice(0).forEach(callback => callback())
    expect((staged.setInstallTimer.mock.calls[0] as unknown[])[1]).toBe(10_000)
  })
})
