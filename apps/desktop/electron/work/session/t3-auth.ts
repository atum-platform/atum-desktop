import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { WorkSessionError } from './redact'

/** What one `t3` invocation returned. Output is never put in an error. */
export interface CommandResult {
  code: number
  stdout: string
}

export type CommandRunner = (executable: string, args: string[], environment: Record<string, string>) => Promise<CommandResult>

export const execCommand: CommandRunner = (executable, args, environment) =>
  new Promise(resolve => {
    execFile(
      executable,
      args,
      { env: environment, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1) : 0
        resolve({ code, stdout: String(stdout ?? '') })
      }
    )
  })

/**
 * T3's own auth commands, run against one stopped home (plan §8.4 step 3):
 * `t3 auth session list/revoke`, `t3 auth pairing list/revoke`. They act on
 * the home directly when no server runs and are safe to repeat. A listing is
 * parsed down to ids; no credential, token or command output is ever kept.
 */
export interface T3AuthCli {
  sessionIds(label?: string): Promise<string[]>
  revokeSession(id: string): Promise<void>
  pairingIds(): Promise<string[]>
  /** True when a live link was revoked, false when it was already gone. */
  revokePairing(id: string): Promise<boolean>
}

function ids(stdout: string, key: 'sessionId' | 'id', label?: string): string[] {
  let rows: unknown

  try {
    rows = JSON.parse(stdout)
  } catch {
    throw new WorkSessionError('t3_auth_unparseable')
  }

  if (!Array.isArray(rows)) {
    throw new WorkSessionError('t3_auth_unparseable')
  }

  return rows.filter(row => label === undefined || row?.client?.label === label).map(row => {
    const value = (row as Record<string, unknown> | null)?.[key]

    if (typeof value !== 'string' || !value) {
      throw new WorkSessionError('t3_auth_unparseable')
    }

    return value
  })
}

export function createT3AuthCli(options: {
  executable: string
  home: string
  environment: Record<string, string>
  run?: CommandRunner
}): T3AuthCli {
  const run = options.run ?? execCommand
  const environment = { ...options.environment, T3CODE_HOME: options.home, T3CODE_TELEMETRY_ENABLED: 'false' }

  const call = async (args: string[], failure: string) => {
    const result = await run(options.executable, args, environment)

    if (result.code !== 0) {
      throw new WorkSessionError(failure)
    }

    return result.stdout
  }

  return {
    sessionIds: async label => ids(await call(['auth', 'session', 'list', '--json'], 't3_auth_session_list'), 'sessionId', label),
    revokeSession: async id => {
      await call(['auth', 'session', 'revoke', id], 't3_auth_session_revoke')
    },
    pairingIds: async () => ids(await call(['auth', 'pairing', 'list', '--json'], 't3_auth_pairing_list'), 'id'),
    revokePairing: async id => (await call(['auth', 'pairing', 'revoke', id], 't3_auth_pairing_revoke')).startsWith('Revoked')
  }
}

/**
 * T3 does not list a startup grant (it is an `administrative-bootstrap`
 * pairing link that `pairing list` skips, S0-5 G1). Its id is only in the
 * home's SQLite, so main finds it with a read-only query. The table is not a
 * T3 contract: the columns are checked on every open (U44) and an unfamiliar
 * layout is an error, never "nothing found".
 */
export interface PairingGrantLookup {
  /** The id of the row holding exactly this credential, if it is still live. */
  idForCredential(credential: string): string | undefined
  /** Every row neither consumed nor revoked: the hidden startup grants. */
  unusedIds(): string[]
}

const REQUIRED_COLUMNS = ['id', 'credential', 'consumed_at', 'revoked_at']

export function createPairingGrantLookup(database: string): PairingGrantLookup {
  const open = <T>(read: (db: DatabaseSync) => T, empty: T): T => {
    if (!existsSync(database)) {
      return empty
    }

    const db = new DatabaseSync(database, { readOnly: true })

    try {
      const columns = new Set(
        (db.prepare('PRAGMA table_info(auth_pairing_links)').all() as { name: string }[]).map(column => column.name)
      )

      if (columns.size === 0) {
        // The server has never run on this home, so there is no table to hold a grant.
        return empty
      }

      if (!REQUIRED_COLUMNS.every(column => columns.has(column))) {
        throw new WorkSessionError('t3_pairing_schema_unrecognised')
      }

      return read(db)
    } finally {
      db.close()
    }
  }

  return {
    idForCredential: credential =>
      open(db => {
        const row = db
          .prepare('SELECT id FROM auth_pairing_links WHERE credential = ? AND revoked_at IS NULL LIMIT 1')
          .all(credential)[0] as { id?: unknown } | undefined

        return typeof row?.id === 'string' ? row.id : undefined
      }, undefined),
    unusedIds: () =>
      open(
        db =>
          (db.prepare('SELECT id FROM auth_pairing_links WHERE revoked_at IS NULL AND consumed_at IS NULL').all() as { id: string }[])
            .map(row => row.id),
        []
      )
  }
}
