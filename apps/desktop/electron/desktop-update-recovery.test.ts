import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createDesktopUpdateDiskPreflight,
  recoverPendingShipItInstall,
  sweepOrphanedShipItTemporaryDirectories
} from './desktop-update-settings'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'atum-update-recovery-')))
  directories.push(root)
  const applicationIdentifier = 'com.atum.updater-test.recovery'
  const cacheDirectory = path.join(root, `${applicationIdentifier}.ShipIt`)
  const bundlePath = path.join(root, 'Atum.app')
  const staged = path.join(cacheDirectory, 'update.abcdefg', 'Atum.app')
  await Promise.all([mkdir(bundlePath), mkdir(path.join(staged, 'Contents'), { recursive: true })])
  const state = path.join(cacheDirectory, 'ShipItState.plist')

  const request = {
    bundleIdentifier: applicationIdentifier,
    launchAfterInstallation: true,
    targetBundleURL: new URL(`file://${bundlePath}`).href,
    updateBundleURL: new URL(`file://${staged}`).href
  }

  await writeFile(state, JSON.stringify(request))
  await writeFile(
    path.join(staged, 'Contents', 'Info.plist'),
    JSON.stringify({
      CFBundleIdentifier: applicationIdentifier,
      CFBundleShortVersionString: '1.1.0'
    })
  )

  const command = vi.fn(async (file: string, args: readonly string[], _options: { timeout: number }) => {
    if (file.endsWith('/plutil')) {
      return { stdout: await readFile(args.at(-1)!, 'utf8'), stderr: '' }
    }

    if (file.endsWith('/codesign')) {
      return { stdout: 'designated => identifier "com.atum.updater-test.recovery" and anchor trusted', stderr: '' }
    }

    return { stdout: 'state = waiting', stderr: '' }
  })

  return { applicationIdentifier, cacheDirectory, bundlePath, staged, state, request, command, root }
}

describe('native staged update recovery', () => {
  it('verifies the signing requirement and resumes the native job without writing state', async () => {
    const f = await fixture()
    const recovered = await recoverPendingShipItInstall({ ...f, currentVersion: '1.0.0' })
    expect(recovered?.version).toBe('1.1.0')
    expect(f.command).toHaveBeenCalledWith(
      '/usr/bin/codesign',
      ['--verify', '--strict', '-R', 'identifier "com.atum.updater-test.recovery" and anchor trusted', f.staged],
      { timeout: 20_000 }
    )
    await recovered!.install()
    expect(f.command).toHaveBeenCalledWith(
      '/bin/launchctl',
      ['kickstart', `gui/${process.getuid?.()}/${f.applicationIdentifier}.ShipIt`],
      { timeout: 1000 }
    )
    expect(JSON.parse(await readFile(f.state, 'utf8'))).toEqual(f.request)
  })
  it('never interrupts a running installer and refuses a changed request', async () => {
    const f = await fixture()
    const recovered = await recoverPendingShipItInstall({ ...f, currentVersion: '1.0.0' })
    f.command.mockResolvedValue({ stdout: 'state = running\npid = 123', stderr: '' })
    await recovered!.install()
    expect(f.command.mock.calls.some(([, args]) => args[0] === 'kickstart')).toBe(false)
    await writeFile(f.state, '{}')
    await expect(recovered!.install()).rejects.toThrow('request changed')
  })
  it.each(['target', 'signature', 'version', 'launch'])('rejects invalid %s without deleting state', async failure => {
    const f = await fixture()

    if (failure === 'target') {
      await writeFile(f.state, JSON.stringify({ ...f.request, targetBundleURL: 'file:///tmp/Other.app' }))
    }

    if (failure === 'launch') {
      await writeFile(f.state, JSON.stringify({ ...f.request, launchAfterInstallation: false }))
    }

    if (failure === 'signature') {
      const command = f.command.getMockImplementation()!
      f.command.mockImplementation(async (...args) => {
        if (args[1][0] === '--verify') {
          throw new Error('signature invalid')
        }

        return command(...args)
      })
    }

    expect(
      await recoverPendingShipItInstall({ ...f, currentVersion: failure === 'version' ? '1.2.0' : '1.0.0' })
    ).toBeNull()
    expect(await readFile(f.state, 'utf8')).toContain('bundleIdentifier')
  })
})

it('sizes the space requirement from the bundle and ZIP and reports the numeric shortfall', async () => {
  const freeBytes = vi.fn(async (_directory: string) => 1e9)

  const preflight = createDesktopUpdateDiskPreflight({
    bundlePath: '/Applications/Atum.app',
    temporaryPath: '/tmp',
    cachePath: '/cache',
    freeBytes,
    command: async () => ({ stdout: '1700000\t/Applications/Atum.app\n', stderr: '' })
  })

  await expect(preflight({ files: [{ size: 680e6 }] })).rejects.toMatchObject({ requiredBytes: 5.4e9 })
  freeBytes.mockResolvedValue(10e9)
  await expect(preflight({ files: [{ size: 680e6 }] })).resolves.toBeUndefined()
  expect(freeBytes.mock.calls).toEqual([['/Applications'], ['/Applications'], ['/tmp'], ['/cache']])
})

it.skipIf(process.platform !== 'darwin')(
  'cleans only unused, unreferenced exact-identity copies using real lsof',
  async () => {
    const f = await fixture()
    const unused = path.join(f.root, `${f.applicationIdentifier}.ShipIt.abcdef`)
    const inUse = path.join(f.root, `${f.applicationIdentifier}.ShipIt.inuse1`)
    const referenced = path.join(f.root, `${f.applicationIdentifier}.ShipIt.ref123`)
    const other = path.join(f.root, 'com.other.ShipIt.abcdef')
    await Promise.all([unused, inUse, referenced, other].map(directory => mkdir(directory)))
    await writeFile(path.join(inUse, 'open'), 'held')
    const held = await open(path.join(inUse, 'open'))
    await writeFile(f.state, JSON.stringify({ ...f.request, backup: new URL(`file://${referenced}/Atum.app`).href }))

    const command = async (file: string, args: readonly string[], options: { timeout: number }) => {
      if (file.endsWith('/launchctl')) {
        throw { stderr: 'Could not find service', code: 113 }
      }

      try {
        return await promisify(execFile)(file, [...args], { ...options, encoding: 'utf8' })
      } catch (error) {
        throw Object.assign(error as Error, { timedOut: (error as { killed?: boolean }).killed === true })
      }
    }

    try {
      await sweepOrphanedShipItTemporaryDirectories({ ...f, temporaryPath: f.root, command })
      await expect(readFile(path.join(inUse, 'open'), 'utf8')).resolves.toBe('held')
      await expect(stat(unused)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(referenced)).resolves.toBeDefined()
      await expect(stat(other)).resolves.toBeDefined()
    } finally {
      await held.close()
    }
  }
)
