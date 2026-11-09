import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createDesktopUpdateSettings,
  createShipItOperationLease,
  mergeDesktopUpdateConfig,
  retireLegacyShipItState,
  sweepLegacyShipItQuarantines
} from './desktop-update-settings'

const temporary: string[] = []
afterEach(() => temporary.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })))

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-update-settings-'))
  temporary.push(directory)

  return {
    directory,
    file: path.join(directory, 'updates.json'),
    downloaded: path.join(directory, 'downloaded-update.json'),
    pending: path.join(directory, 'pending-update.json')
  }
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('desktop update settings migration', () => {
  it('preserves the legacy channel, removes failure history and retires only Atum markers', async () => {
    const test = harness()
    fs.writeFileSync(test.file, JSON.stringify({ branch: 'main', v: 1, updates: { channel: 'beta', failureDays: [1, 2] } }))
    fs.writeFileSync(test.downloaded, JSON.stringify({ previous: '1.0.0', expected: '1.1.0', attempted: 'relaunch' }))
    fs.writeFileSync(test.pending, JSON.stringify({ previous: '1.0.0', expected: '9.9.9' }))
    const sibling = path.join(test.directory, 'ShipItState.plist')
    fs.writeFileSync(sibling, 'owned upstream')
    const settings = createDesktopUpdateSettings({ file: test.file, legacyMarkers: [test.downloaded, test.pending] })

    await expect(settings.migrate('1.1.0')).resolves.toEqual({
      channel: 'beta', applied: { from_version: '1.0.0', to_version: '1.1.0' }
    })
    expect(JSON.parse(fs.readFileSync(test.file, 'utf8'))).toEqual({
      branch: 'main', v: 1, updates: { channel: 'beta', lastVersion: '1.1.0', stockMigration: 1 }
    })
    expect(fs.existsSync(test.downloaded)).toBe(false)
    expect(fs.existsSync(test.pending)).toBe(false)
    expect(fs.readFileSync(sibling, 'utf8')).toBe('owned upstream')
  })

  it('never treats an old future marker as install intent and emits a version transition once', async () => {
    const test = harness()
    fs.writeFileSync(test.pending, JSON.stringify({ previous: '1.0.0', expected: '2.0.0' }))
    const settings = createDesktopUpdateSettings({ file: test.file, legacyMarkers: [test.pending] })
    expect((await settings.migrate('1.1.0')).applied).toBeNull()
    expect(fs.existsSync(test.pending)).toBe(false)
    expect((await settings.migrate('1.1.0')).applied).toBeNull()
    expect((await settings.migrate('1.2.0')).applied).toEqual({ from_version: '1.1.0', to_version: '1.2.0' })
    expect((await settings.migrate('1.2.0')).applied).toBeNull()
  })

  it('preserves updater channel and last-version state when classic changes its engine branch', () => {
    const test = harness()
    fs.writeFileSync(test.file, JSON.stringify({
      branch: 'main', updates: { channel: 'beta', lastVersion: '1.2.0' }
    }))
    mergeDesktopUpdateConfig(test.file, { branch: 'release' })
    expect(JSON.parse(fs.readFileSync(test.file, 'utf8'))).toEqual({
      branch: 'release', updates: { channel: 'beta', lastVersion: '1.2.0' }
    })
  })

  it('retires only its exact post-abort ShipIt cache when no request remains', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.postabort'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    const staged = path.join(cacheDirectory, 'update.cBjc8P9', 'Atum Updater Test.app')
    fs.mkdirSync(staged, { recursive: true })
    fs.writeFileSync(path.join(cacheDirectory, 'ShipIt_stderr.log'), 'Too many attempts to install, aborting update')
    const sibling = path.join(test.directory, 'com.atum.other.ShipIt')
    fs.mkdirSync(sibling)
    const clearInstallationAttempts = vi.fn(async () => true)
    const complete = vi.fn(async () => undefined)

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts,
      complete,
      isShipItActive: async () => false
    })).resolves.toBe(true)

    expect(clearInstallationAttempts).toHaveBeenCalledExactlyOnceWith(`${applicationIdentifier}.ShipIt`)
    expect(complete).toHaveBeenCalledOnce()
    expect(fs.existsSync(cacheDirectory)).toBe(false)
    expect(fs.existsSync(sibling)).toBe(true)
  })

  it('uses Node rm retries when the first quarantine removal attempt is ENOTEMPTY', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.retry'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    fs.mkdirSync(path.join(cacheDirectory, 'update.retry', 'Atum Updater Test.app'), { recursive: true })
    let attempts = 0
    const removeQuarantine = vi.fn(async (directory: string, options: {
      force: true
      maxRetries: number
      recursive: true
      retryDelay: number
    }) => {
      for (;;) {
        attempts += 1

        if (attempts === 1) {
          const error = Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' })
          if (attempts > options.maxRetries) {throw error}
          continue
        }

        await fs.promises.rm(directory, { recursive: true, force: true })
        return
      }
    })

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts: async () => true,
      complete: async () => undefined,
      isShipItActive: async () => false,
      removeQuarantine
    })).resolves.toBe(true)

    await flush()
    expect(attempts).toBe(2)
    expect(removeQuarantine).toHaveBeenCalledOnce()
    expect(removeQuarantine.mock.calls[0]?.[1]).toEqual({
      recursive: true, force: true, maxRetries: 5, retryDelay: 100
    })
    expect(fs.existsSync(cacheDirectory)).toBe(false)
  })

  it('commits migration after persistent ENOTEMPTY and sweeps the retired quarantine next launch', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.persistent'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    fs.mkdirSync(path.join(cacheDirectory, 'update.persistent', 'Atum Updater Test.app'), { recursive: true })
    const complete = vi.fn(async () => undefined)
    const steps: string[] = []
    const persistentEnotempty = vi.fn(async () => {
      throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' })
    })

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts: async () => true,
      complete,
      isShipItActive: async () => false,
      progress: step => steps.push(step),
      removeQuarantine: persistentEnotempty
    })).resolves.toBe(true)

    await flush()
    const retired = fs.readdirSync(test.directory).filter(entry => entry.endsWith('.retired'))
    expect(complete).toHaveBeenCalledOnce()
    expect(fs.existsSync(cacheDirectory)).toBe(false)
    expect(retired).toHaveLength(1)
    expect(steps).toEqual(expect.arrayContaining([
      'retirement.cleanup.start',
      'retirement.cleanup.deferred',
      'quiet.post_cleanup.start',
      'migration.complete'
    ]))

    const nextLaunch = createDesktopUpdateSettings({
      file: test.file,
      sweepLegacyNativeState: () => sweepLegacyShipItQuarantines({ applicationIdentifier, cacheDirectory })
    })
    await nextLaunch.migrate('1.0.0')
    await flush()

    expect(fs.readdirSync(test.directory).filter(entry => entry.endsWith('.retired'))).toEqual([])
  })

  it('continues migration when committed quarantine removal never settles', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.stuck-remove'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    fs.mkdirSync(path.join(cacheDirectory, 'update.stuck', 'Atum Updater Test.app'), { recursive: true })
    const complete = vi.fn(async () => undefined)
    const steps: string[] = []

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts: async () => true,
      complete,
      isShipItActive: async () => false,
      progress: step => steps.push(step),
      removeQuarantine: () => new Promise<void>(() => undefined)
    })).resolves.toBe(true)

    expect(complete).toHaveBeenCalledOnce()
    expect(steps).toContain('retirement.cleanup.start')
    expect(steps).toContain('quiet.post_cleanup.start')
    expect(steps).toContain('migration.complete')
    expect(fs.readdirSync(test.directory).filter(entry => entry.endsWith('.retired'))).toHaveLength(1)
  })

  it('defers when an external quietness probe times out', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.command-timeout'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    fs.mkdirSync(cacheDirectory)
    const complete = vi.fn(async () => undefined)
    const steps: string[] = []
    const command = vi.fn(async (_file: string, _arguments: readonly string[], options: { timeout: number }) => {
      expect(options.timeout).toBeGreaterThan(0)
      expect(options.timeout).toBeLessThanOrEqual(1_000)
      throw Object.assign(new Error('timed out'), { timedOut: true })
    })

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      command,
      complete,
      progress: step => steps.push(step)
    })).resolves.toBe(false)

    expect(command).toHaveBeenCalledOnce()
    expect(steps).toContain('quiet.launchctl.timeout')
    expect(complete).not.toHaveBeenCalled()
    expect(fs.existsSync(cacheDirectory)).toBe(true)
  })

  it('bounds the whole migration when settings completion does not settle', async () => {
    // Deterministic on a loaded runner: only Date/setTimeout are faked, so the deadline cannot expire during the real
    // filesystem steps (the clock is frozen), and the budget is spent only once complete() has actually been called.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })

    try {
      const test = harness()
      const applicationIdentifier = 'com.atum.updater-test.deadline'
      const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
      let completeStarted!: () => void
      const reachedComplete = new Promise<void>(resolve => { completeStarted = resolve })

      const complete = vi.fn(() => {
        completeStarted()

        return new Promise<void>(() => undefined)
      })

      const steps: string[] = []

      const result = retireLegacyShipItState({
        applicationIdentifier,
        cacheDirectory,
        clearInstallationAttempts: async () => true,
        complete,
        deadlineMs: 25,
        isShipItActive: async () => false,
        progress: step => steps.push(step)
      })

      await reachedComplete
      expect(steps).not.toContain('settings.complete.timeout')
      await vi.advanceTimersByTimeAsync(25)

      await expect(result).resolves.toBe(false)
      expect(complete).toHaveBeenCalledOnce()
      expect(steps).toContain('settings.complete.timeout')
      expect(fs.existsSync(path.join(test.directory, `.${applicationIdentifier}.ShipIt.stock-migration.lock`))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it.runIf(process.platform === 'darwin')('completes the real bounded launchctl/defaults sequence for a throwaway identity', async () => {
    const test = harness()
    const applicationIdentifier = `com.atum.updater-test.real-${process.pid}`
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    fs.mkdirSync(cacheDirectory)
    const steps: string[] = []

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      complete: async () => undefined,
      progress: step => steps.push(step)
    })).resolves.toBe(true)

    await flush()
    expect(steps).toEqual(expect.arrayContaining([
      'quiet.launchctl.start',
      'quiet.processes.start',
      'attempts.delete.start',
      'attempts.readback.start',
      'migration.complete'
    ]))
  })

  it('retires an unchanged stale request only after proving its ShipIt job is quiet', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.pending'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    fs.mkdirSync(cacheDirectory)
    fs.writeFileSync(path.join(cacheDirectory, 'ShipItState.plist'), '{"stale":true}')
    fs.mkdirSync(path.join(cacheDirectory, 'update.stale', 'Atum Updater Test.app'), { recursive: true })
    const clearInstallationAttempts = vi.fn(async () => true)
    const complete = vi.fn(async () => undefined)

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts,
      complete,
      isShipItActive: async () => false
    })).resolves.toBe(true)

    expect(clearInstallationAttempts).toHaveBeenCalledExactlyOnceWith(`${applicationIdentifier}.ShipIt`)
    expect(complete).toHaveBeenCalledOnce()
    expect(fs.existsSync(cacheDirectory)).toBe(false)
  })

  it('defers without touching state while the exact ShipIt job is active', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.active'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    fs.mkdirSync(cacheDirectory)
    fs.writeFileSync(path.join(cacheDirectory, 'ShipIt_stderr.log'), 'active')
    const clearInstallationAttempts = vi.fn(async () => true)
    const complete = vi.fn(async () => undefined)

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts,
      complete,
      isShipItActive: async () => true
    })).resolves.toBe(false)

    expect(clearInstallationAttempts).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(fs.existsSync(cacheDirectory)).toBe(true)
  })

  it('shares exclusive ownership with stock checks from another user-data profile', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.lease'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    const acquire = createShipItOperationLease({ applicationIdentifier, cacheDirectory })
    const release = await acquire()
    const complete = vi.fn(async () => undefined)

    expect(release).not.toBeNull()
    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts: async () => true,
      complete,
      isShipItActive: async () => false
    })).resolves.toBe(false)
    expect(complete).not.toHaveBeenCalled()

    await release!()
    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts: async () => true,
      complete,
      isShipItActive: async () => false
    })).resolves.toBe(true)
    expect(complete).toHaveBeenCalledOnce()
  })

  it('restores and defers when a ShipIt request appears before the retirement commit', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.race'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    fs.mkdirSync(cacheDirectory)
    fs.writeFileSync(path.join(cacheDirectory, 'ShipIt_stderr.log'), 'stale')
    const clearInstallationAttempts = vi.fn(async () => true)
    const complete = vi.fn(async () => undefined)

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts,
      complete,
      isShipItActive: async () => false,
      afterQuarantine: async quarantine => {
        fs.writeFileSync(path.join(quarantine, 'ShipItState.plist'), '{"new":true}')
      }
    })).resolves.toBe(false)

    expect(clearInstallationAttempts).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(cacheDirectory, 'ShipItState.plist'), 'utf8')).toBe('{"new":true}')
    expect(fs.readdirSync(test.directory).filter(entry => entry.includes('.stock-migration-'))).toEqual([])
  })

  it('restores and defers when ShipIt becomes active before the retirement commit', async () => {
    const test = harness()
    const applicationIdentifier = 'com.atum.updater-test.active-race'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    fs.mkdirSync(cacheDirectory)
    fs.writeFileSync(path.join(cacheDirectory, 'ShipIt_stderr.log'), 'stale')
    let activeChecks = 0
    const complete = vi.fn(async () => undefined)

    await expect(retireLegacyShipItState({
      applicationIdentifier,
      cacheDirectory,
      clearInstallationAttempts: async () => true,
      complete,
      isShipItActive: async () => {
        activeChecks += 1
        return activeChecks > 1
      }
    })).resolves.toBe(false)

    expect(complete).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(cacheDirectory, 'ShipIt_stderr.log'), 'utf8')).toBe('stale')
    expect(fs.readdirSync(test.directory).filter(entry => entry.includes('.stock-migration-'))).toEqual([])
  })

  it('leaves the migration incomplete when defaults readback is uncertain', async () => {
    const test = harness()
    fs.writeFileSync(test.file, JSON.stringify({ channel: 'beta', failureDays: [1], lastVersion: '1.0.0' }))
    const applicationIdentifier = 'com.atum.updater-test.uncertain'
    const cacheDirectory = path.join(test.directory, `${applicationIdentifier}.ShipIt`)
    const settings = createDesktopUpdateSettings({
      file: test.file,
      retireLegacyNativeState: complete => retireLegacyShipItState({
        applicationIdentifier,
        cacheDirectory,
        clearInstallationAttempts: async () => false,
        complete,
        isShipItActive: async () => false
      })
    })

    await expect(settings.migrate('1.1.0')).resolves.toEqual({
      applied: null, channel: 'beta', deferred: true
    })
    expect(JSON.parse(fs.readFileSync(test.file, 'utf8'))).toEqual({
      channel: 'beta', failureDays: [1], lastVersion: '1.0.0'
    })
  })

  it('runs the stock ShipIt migration once before canonicalizing legacy beta settings', async () => {
    const test = harness()
    fs.writeFileSync(test.file, JSON.stringify({ channel: 'beta', failureDays: [1, 2], lastVersion: '1.0.0' }))
    const retire = vi.fn(async complete => {await complete(); return true})
    const settings = createDesktopUpdateSettings({
      file: test.file,
      retireLegacyNativeState: retire
    })

    await expect(settings.migrate('1.1.0')).resolves.toEqual({
      channel: 'beta', applied: { from_version: '1.0.0', to_version: '1.1.0' }
    })
    expect(retire).toHaveBeenCalledOnce()
    expect(JSON.parse(fs.readFileSync(test.file, 'utf8'))).toEqual({
      updates: { channel: 'beta', lastVersion: '1.1.0', stockMigration: 1 }
    })

    await settings.migrate('1.1.0')
    expect(retire).toHaveBeenCalledOnce()
  })
})
