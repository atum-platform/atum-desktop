import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { matrixDiskReserve } from './disk-reserve'

const directories: string[] = []

afterEach(() => {
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function folder() {
  const directory = mkdtempSync(path.join(tmpdir(), 'atum-disk-reserve-'))
  directories.push(directory)

  return directory
}

describe('the room kept on the disk for a token save ', () => {
  it('is a real file of the asked size, made only while the disk has room to spare', () => {
    const file = path.join(folder(), 'credentials.reserve')
    let free = 10_000
    const reserve = matrixDiskReserve(file, { bytes: 64 * 1024, minFreeBytes: 1024 * 1024, retryMs: 0, freeBytes: () => free })

    // Nearly full already: the reserve never takes the last of it.
    reserve.ensure()
    expect(existsSync(file)).toBe(false)

    free = 512 * 1024 * 1024
    reserve.ensure()
    const made = statSync(file)
    expect(made.size).toBe(64 * 1024)
    // Written, not sparse: deleting it gives the blocks back.
    expect(made.blocks * 512).toBeGreaterThanOrEqual(64 * 1024)
    expect(readFileSync(file).every(byte => byte === 0)).toBe(false)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('gives its room back on release, then waits before keeping it again', () => {
    const file = path.join(folder(), 'credentials.reserve')
    let now = 0
    const reserve = matrixDiskReserve(file, { bytes: 4096, minFreeBytes: 0, retryMs: 60_000, now: () => now, freeBytes: () => 1e12 })

    reserve.ensure()
    expect(existsSync(file)).toBe(true)
    expect(reserve.release()).toBe(true)
    expect(existsSync(file)).toBe(false)
    // Nothing left to give.
    expect(reserve.release()).toBe(false)

    // The disk was just full: no new reserve for a while, even with a save landing meanwhile.
    now = 59_999
    reserve.ensure()
    expect(existsSync(file)).toBe(false)

    now = 60_000
    reserve.ensure()
    expect(statSync(file).size).toBe(4096)
  })

  it('outlives a restart: a reserve kept by an earlier run counts and can be released', () => {
    const file = path.join(folder(), 'credentials.reserve')
    writeFileSync(file, Buffer.alloc(4096, 7))
    let writes = 0

    const reserve = matrixDiskReserve(file, {
      bytes: 4096,
      minFreeBytes: 0,
      retryMs: 0,
      freeBytes: () => {
        writes++

        return 1e12
      }
    })

    reserve.ensure()
    // Already there at its size: not written again.
    expect(writes).toBe(0)
    expect(readFileSync(file).every(byte => byte === 7)).toBe(true)
    expect(reserve.release()).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('never throws: an unwritable folder or a failing disk check only means no reserve', () => {
    const missing = path.join(folder(), 'gone', 'deeper', 'credentials.reserve')
    const reserve = matrixDiskReserve(missing, { bytes: 4096, minFreeBytes: 0, retryMs: 0, freeBytes: () => 1e12 })
    expect(() => reserve.ensure()).not.toThrow()
    expect(reserve.release()).toBe(false)

    const file = path.join(folder(), 'credentials.reserve')

    const failing = matrixDiskReserve(file, {
      bytes: 4096,
      minFreeBytes: 0,
      retryMs: 0,
      freeBytes: () => {
        throw new Error('statfs failed')
      }
    })

    expect(() => failing.ensure()).not.toThrow()
    expect(existsSync(file)).toBe(false)
  })
})
