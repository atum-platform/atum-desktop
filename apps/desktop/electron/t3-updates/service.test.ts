import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { createAtumUpdates } from './service'

const checks = vi.hoisted(() => ({ count: 0 }))

vi.mock('electron-updater', () => ({
  MacUpdater: class extends EventEmitter {
    channel = 'latest'
    setFeedURL() {}
    async checkForUpdates() {
      checks.count++
      this.emit('update-available', { version: '1.1.0', releaseNotes: 'Update notes' })
    }
    async downloadUpdate() {
      this.emit('download-progress', { percent: 99 })
      const prepare = Reflect.get(this, 'updateDownloaded') as (zip: object, event: object) => Promise<void>
      await prepare({}, { version: '1.1.0', downloadedFile: '/tmp/update.zip' })
    }
  }
}))

async function fixture(prepare: () => Promise<void>, admit = vi.fn(async () => null as string | null)) {
  const directory = await mkdtemp(path.join(tmpdir(), 'atum-updater-'))
  const install = vi.fn(async () => {})
  let channel: 'latest' | 'beta' = 'latest'
  const service = createAtumUpdates({
    version: '1.0.0', packaged: true, supported: true, feedUrl: 'https://updates.example/',
    resources: directory, userData: directory, currentChannel: 'latest',
    settings: {
      migrate: async () => ({ applied: null, channel }),
      getChannel: async () => channel,
      setChannel: async value => {channel = value}
    },
    native: { stage: { prepare }, install },
    admit, changed: () => {}, log: () => {}, platform: 'darwin'
  })
  const dispose = async () => {
    await service.stop()
    await rm(directory, { recursive: true, force: true })
  }

  return { service, install, dispose }
}

it('auto-downloads, waits for verification, and installs only the admitted version', async () => {
  let finish!: () => void
  const prepare = vi.fn(() => new Promise<void>(resolve => {finish = resolve}))
  const admit = vi.fn(async () => null as string | null)
  const { service, install, dispose } = await fixture(prepare, admit)

  try {
    expect(await service.start()).toBe(true)
    await service.checkNow()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    expect(service.state().status).toBe('downloading')
    expect(await service.restart('1.1.0')).toBe(false)
    finish()
    await vi.waitFor(() => expect(service.state().status).toBe('downloaded'))
    expect(install).not.toHaveBeenCalled()
    expect(await service.restart('1.2.0')).toBe(false)
    admit.mockResolvedValueOnce('Local work is busy.')
    expect(await service.restart('1.1.0')).toBe(false)
    expect(service.state().message).toBe('Local work is busy.')
    expect(install).not.toHaveBeenCalled()
    expect(await service.restart('1.1.0')).toBe(true)
    expect(install).toHaveBeenCalledOnce()
  } finally {
    finish?.()
    await dispose()
  }
})

it('reports verification failure without offering install or looping', async () => {
  const prepare = vi.fn(async () => {throw new Error('Signature verification failed.')})
  const { service, install, dispose } = await fixture(prepare)
  try {
    expect(await service.start()).toBe(true)
    await service.checkNow()
    await vi.waitFor(() => expect(service.state().errorContext).toBe('download'))
    expect(service.state().downloadedVersion).toBeNull()
    expect(await service.restart('1.1.0')).toBe(false)
    expect(prepare).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
  } finally {
    await dispose()
  }
})

it('checks 15 seconds after startup and again at four hours', async () => {
  const { service, install, dispose } = await fixture(async () => {})
  const before = checks.count
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    expect(await service.start()).toBe(true)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(checks.count).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    // The serialized download may refresh the offer after the startup check.
    expect(checks.count).toBeGreaterThan(before)
    await vi.advanceTimersByTimeAsync(1000)
    const afterStartup = checks.count
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 - 16_001)
    expect(checks.count).toBe(afterStartup)
    await vi.advanceTimersByTimeAsync(1)
    expect(checks.count).toBeGreaterThan(afterStartup)
    expect(install).not.toHaveBeenCalled()
  } finally {
    await dispose()
    vi.useRealTimers()
  }
})

it('restages a missing verified app without installing on the old authorization', async () => {
  const prepare = vi.fn(async () => {})
  const admit = vi.fn(async () => null as string | null)
  const { service, install, dispose } = await fixture(prepare, admit)

  try {
    expect(await service.start()).toBe(true)
    await service.checkNow()
    await vi.waitFor(() => expect(service.state().status).toBe('downloaded'))
    admit.mockResolvedValueOnce('stage-lost')
    expect(await service.restart('1.1.0')).toBe(false)
    await vi.waitFor(() => {
      expect(prepare).toHaveBeenCalledTimes(2)
      expect(service.state().status).toBe('downloaded')
    })
    expect(install).not.toHaveBeenCalled()
    expect(await service.restart('1.1.0')).toBe(true)
    expect(install).toHaveBeenCalledOnce()
  } finally {
    await dispose()
  }
})
