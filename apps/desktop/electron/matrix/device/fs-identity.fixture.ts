import { lstatSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { StatFn } from './drive-root-identity'

/**
 * Returns once the filesystem under `dir` stamps a new file later than the files made before this
 * call. Linux stamps from a coarse kernel clock (a tick is one to ten milliseconds), so a directory
 * removed and recreated straight away can get its predecessor's creation time; macOS stamps in
 * nanoseconds and returns at once. A test that replaces a Drive root calls it between the two.
 */
export function waitForFilesystemClock(dir: string): void {
  const probe = path.join(dir, `.clock-probe-${process.pid}`)

  const look = () => {
    writeFileSync(probe, '')
    const facts = statSync(probe)
    rmSync(probe)

    return Math.max(facts.mtimeMs, facts.birthtimeMs)
  }

  const since = look()
  const deadline = Date.now() + 2000

  while (look() <= since) {
    if (Date.now() > deadline) {
      throw new Error('the filesystem clock did not advance')
    }
  }
}

/** The numbers of a path that a test plays; the rest of what `lstat` returns stays real. */
export interface PlayedNumbers {
  ino?: number
  dev?: number
  birthtimeMs?: number
  mtimeMs?: number
}

/**
 * `lstat`, except that a path in `played` reports the numbers its function gives at the time of the
 * call. This is how a test plays a filesystem that hands a removed directory's inode number to the
 * next one made (ext4, overlay), or that keeps no creation time (`birthtimeMs: 0`), on any machine.
 */
export function playedStat(played: Record<string, () => PlayedNumbers>): StatFn {
  return file => {
    const real = lstatSync(file)
    const numbers = played[file]?.()

    return numbers ? Object.assign(Object.create(real) as typeof real, numbers) : real
  }
}
