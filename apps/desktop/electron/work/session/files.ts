import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

function syncDirectory(path: string) {
  try {
    const fd = openSync(path, 'r')

    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Directory fsync is best effort off macOS/APFS.
  }
}

/** Write-then-rename with fsync, so a crash leaves the old file or the new one, never half. */
export function writeFileDurably(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.next`
  const fd = openSync(temporary, 'w', 0o600)

  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  renameSync(temporary, path)
  syncDirectory(dirname(path))
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

export function removeDurably(path: string): void {
  rmSync(path, { force: true })
  syncDirectory(dirname(path))
}
