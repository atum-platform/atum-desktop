import { statfsSync } from 'node:fs'

/**
 * Free space on the disk that holds Atum's data (
 * WS-E). Both 2026-10-04 incidents began with a full disk: the Mac mini's sign-in could not be
 * saved and the app ended its own session, and Atum Moon's encryption store on the MacBook was
 * wiped, so its device came back with new keys. Atum cannot make space, but it can say so
 * early, before anything breaks: below 10 GB a quiet notice, below 3 GB an urgent one.
 *
 * Gigabytes are decimal, as macOS's own Storage settings count them.
 */
export const MATRIX_DISK_LOW_BYTES = 10e9
export const MATRIX_DISK_CRITICAL_BYTES = 3e9
/** How often the space is looked at while Atum runs. */
export const MATRIX_DISK_CHECK_MS = 10 * 60 * 1000

export interface MatrixDiskHealth {
  state: 'low' | 'critical'
  /** Free space in decimal GB, one decimal place. */
  freeGb: number
}

/** Free bytes available to this user on the disk that holds `path`; undefined when unknown. */
export function matrixFreeBytes(path: string, statfs: typeof statfsSync = statfsSync): number | undefined {
  try {
    const stats = statfs(path)
    const free = Number(stats.bavail) * Number(stats.bsize)

    return Number.isFinite(free) && free >= 0 ? free : undefined
  } catch {
    return undefined
  }
}

/** What to tell the person, if anything. */
export function matrixDiskHealth(freeBytes: number | undefined): MatrixDiskHealth | undefined {
  if (freeBytes === undefined || freeBytes >= MATRIX_DISK_LOW_BYTES) {
    return undefined
  }

  return {
    state: freeBytes < MATRIX_DISK_CRITICAL_BYTES ? 'critical' : 'low',
    freeGb: decimalGb(freeBytes)
  }
}

/** Decimal GB, rounded down to one place (never more space than there is). */
function decimalGb(bytes: number): number {
  return Math.floor((bytes / 1e9) * 10 + 1e-6) / 10
}

export interface MatrixDiskWatchOptions {
  read(): number | undefined
  changed(health: MatrixDiskHealth | undefined): void
  log(line: string): void
  intervalMs?: number
}

/**
 * Looks now and every ten minutes; tells main only when what to show changes, and logs only
 * when the state changes (never every check).
 */
export function watchMatrixDisk(options: MatrixDiskWatchOptions): { check(): void; stop(): void } {
  let previous: MatrixDiskHealth | undefined
  let state: 'ok' | 'low' | 'critical' | undefined

  const check = () => {
    const free = options.read()
    const health = matrixDiskHealth(free)
    const next = health?.state ?? 'ok'

    if (free !== undefined && next !== state) {
      options.log(`[Matrix] disk free_gb=${decimalGb(free).toFixed(1)} state=${next}`)
      state = next
    }

    if (health?.state !== previous?.state || health?.freeGb !== previous?.freeGb) {
      previous = health
      options.changed(health)
    }
  }

  check()
  const timer = setInterval(check, options.intervalMs ?? MATRIX_DISK_CHECK_MS)
  timer.unref?.()

  return {
    check,
    stop: () => clearInterval(timer)
  }
}
