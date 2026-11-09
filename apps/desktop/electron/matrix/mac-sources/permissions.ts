import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export type FullDiskAccessStatus = 'granted' | 'not-granted' | 'unknown'

export interface FullDiskAccessPaths {
  messages: string
  safari: string
}

export interface FullDiskProbeDependencies {
  exists?: (file: string) => boolean
  open?: (file: string) => DatabaseSync
}

function openReadOnly(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true })
}

function permissionFailure(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? '')
  const message = String((error as { message?: unknown } | null)?.message ?? '')

  return (
    ['EACCES', 'EPERM', 'SQLITE_CANTOPEN'].some(value => code.includes(value)) ||
    /(?:authorization denied|not permitted|permission denied|unable to open database)/iu.test(message)
  )
}

/** Passive only: opening protected databases cannot request Full Disk Access. */
export function probeFullDiskAccess(
  paths: FullDiskAccessPaths,
  dependencies: FullDiskProbeDependencies = {}
): FullDiskAccessStatus {
  const exists = dependencies.exists ?? existsSync
  const open = dependencies.open ?? openReadOnly
  const candidates = [paths.messages, paths.safari].filter(file => {
    try {
      return exists(file)
    } catch {
      return false
    }
  })

  if (!candidates.length) {
    return 'unknown'
  }

  for (const file of candidates) {
    let database: DatabaseSync | undefined

    try {
      database = open(file)
      database.prepare('SELECT name FROM sqlite_master LIMIT 1').get()
    } catch (error) {
      return permissionFailure(error) ? 'not-granted' : 'unknown'
    } finally {
      try {
        database?.close()
      } catch {
        // A closed probe still has its result.
      }
    }
  }

  return 'granted'
}
