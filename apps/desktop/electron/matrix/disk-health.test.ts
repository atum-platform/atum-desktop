import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { matrixDiskHealth, matrixFreeBytes, watchMatrixDisk } from './disk-health'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const GB = 1e9

describe('free space on the disk that holds Atum’s data', () => {
  it('says nothing above 10 GB, a quiet notice below it and an urgent one below 3 GB', () => {
    expect(matrixDiskHealth(undefined)).toBeUndefined()
    expect(matrixDiskHealth(10 * GB)).toBeUndefined()
    expect(matrixDiskHealth(8.26 * GB)).toEqual({ state: 'low', freeGb: 8.2 })
    expect(matrixDiskHealth(3 * GB)).toEqual({ state: 'low', freeGb: 3 })
    // The MacBook on 10-04 (3.5 GiB) and the Mac mini before its panic (233 MiB).
    expect(matrixDiskHealth(2.99 * GB)).toEqual({ state: 'critical', freeGb: 2.9 })
    expect(matrixDiskHealth(233 * 2 ** 20)).toEqual({ state: 'critical', freeGb: 0.2 })
  })

  it('reads the disk with the user’s own available blocks, and never throws', () => {
    const statfs = vi.fn(() => ({ bavail: 1_000, bsize: 4_096 }))
    expect(matrixFreeBytes('/home/example/Library', statfs as never)).toBe(4_096_000)
    expect(
      matrixFreeBytes('/nowhere', (() => {
        throw new Error('ENOENT')
      }) as never)
    ).toBeUndefined()
    expect(matrixFreeBytes('/odd', (() => ({ bavail: Number.NaN, bsize: 4_096 })) as never)).toBeUndefined()
  })

  it('looks now and every ten minutes, and speaks and logs only when something changes', async () => {
    let free = 12 * GB
    const changed = vi.fn()
    const lines: string[] = []
    const watch = watchMatrixDisk({ read: () => free, changed, log: line => lines.push(line) })

    // Plenty of space: nothing to show, one line in the log.
    expect(changed).not.toHaveBeenCalled()
    expect(lines).toEqual(['[Matrix] disk free_gb=12.0 state=ok'])

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(changed).not.toHaveBeenCalled()

    free = 8.2 * GB
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(changed).toHaveBeenLastCalledWith({ state: 'low', freeGb: 8.2 })

    free = 2.5 * GB
    watch.check()
    expect(changed).toHaveBeenLastCalledWith({ state: 'critical', freeGb: 2.5 })
    expect(lines).toEqual([
      '[Matrix] disk free_gb=12.0 state=ok',
      '[Matrix] disk free_gb=8.2 state=low',
      '[Matrix] disk free_gb=2.5 state=critical'
    ])

    watch.stop()
    free = 1 * GB
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(changed).toHaveBeenLastCalledWith({ state: 'critical', freeGb: 2.5 })
  })
})
