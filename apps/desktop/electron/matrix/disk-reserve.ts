import { randomBytes } from 'node:crypto'
import { closeSync, openSync, renameSync, statfsSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A little room kept on this Mac's disk for the one write that must not fail: saving a token
 * rotation ( pass 4). On 2026-10-04 the Mac mini's
 * disk filled up and the rotation the sign-in server had just made could not be saved. A
 * rotation that can't be saved is held and never ends the session (account.ts HeldRotation),
 * but the chats wait for it; this keeps the save itself working: when the vault write fails,
 * the reserve is deleted and the write is tried once more in its room.
 *
 * The reserve is a file of random bytes (never sparse, never compressible) next to the vault.
 * It is made only while the disk has room to spare (`minFreeBytes` beyond the reserve itself),
 * so it never takes the last of a nearly full disk, and it is made again at most once per
 * `retryMs` after it was used or could not be made. Nothing here throws.
 *
 * One limit (APFS): a local Time Machine snapshot taken after the reserve was made still holds
 * its blocks, so deleting it frees nothing until macOS thins that snapshot, which it does first
 * under disk pressure. The rotation is then held until the disk has room.
 */
export interface MatrixDiskReserve {
  /** Makes the reserve when it is missing and the disk has room to spare. */
  ensure(): void
  /** Deletes the reserve so a failed write can try again in its room; true when there was one. */
  release(): boolean
}

/** Room for many saves of the vault (tens of KB, written whole next to the old one). */
export const MATRIX_DISK_RESERVE_BYTES = 2 * 1024 * 1024
/** Never made unless the disk keeps at least this much free beside it. */
const MIN_FREE_BYTES = 64 * 1024 * 1024
/** After the reserve was used, or could not be made, the wait before making it again. */
const RETRY_MS = 10 * 60_000

export function matrixDiskReserve(
  file: string,
  {
    bytes = MATRIX_DISK_RESERVE_BYTES,
    minFreeBytes = MIN_FREE_BYTES,
    retryMs = RETRY_MS,
    now = Date.now,
    freeBytes = (directory: string) => {
      const stats = statfsSync(directory)

      return stats.bavail * stats.bsize
    }
  }: {
    bytes?: number
    minFreeBytes?: number
    retryMs?: number
    now?: () => number
    freeBytes?: (directory: string) => number
  } = {}
): MatrixDiskReserve {
  // Unknown until looked at: the reserve outlives restarts.
  let present: boolean | undefined
  let nextTry = Number.NEGATIVE_INFINITY

  const make = () => {
    const temporary = `${file}.tmp`
    let fd: number | undefined

    try {
      fd = openSync(temporary, 'w', 0o600)

      for (let written = 0; written < bytes; ) {
        written += writeSync(fd, randomBytes(Math.min(256 * 1024, bytes - written)))
      }

      closeSync(fd)
      fd = undefined
      renameSync(temporary, file)
      present = true
    } catch {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Already closed or gone: the file is removed below either way.
        }
      }

      try {
        unlinkSync(temporary)
      } catch {
        // Nothing was left behind.
      }
    }
  }

  return {
    ensure() {
      if (present || now() < nextTry) {
        return
      }

      nextTry = now() + retryMs

      try {
        if (statSync(file).size === bytes) {
          present = true

          return
        }
      } catch {
        // Not made yet, or deleted: made below when there is room.
      }

      try {
        if (freeBytes(dirname(file)) < minFreeBytes + bytes) {
          return
        }
      } catch {
        return
      }

      make()
    },

    release() {
      try {
        unlinkSync(file)
      } catch {
        present = false

        return false
      }

      present = false
      nextTry = now() + retryMs

      return true
    }
  }
}
