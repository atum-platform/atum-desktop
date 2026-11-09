/**
 * What Settings shows after the import is over and the app has restarted: how many sites went to which agent, and
 * when. Counts and a time, never a site, a cookie or a path. Device-local and kept per owner (hashed), because
 * the cloud, not this Mac, holds the sessions: this is only the memory of what the person did here.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { MatrixBrowserImportLast } from '../../../shared/matrix-browser-import'

export interface LastImportStore {
  read(ownerUserId: string): MatrixBrowserImportLast | null
  write(ownerUserId: string, last: MatrixBrowserImportLast): void
}

const key = (ownerUserId: string) => createHash('sha256').update(ownerUserId).digest('hex').slice(0, 32)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function valid(value: unknown): value is MatrixBrowserImportLast {
  const last = value as Partial<MatrixBrowserImportLast> | null

  return (
    typeof last === 'object' &&
    last !== null &&
    Number.isSafeInteger(last.siteCount) &&
    (last.siteCount as number) >= 0 &&
    Number.isSafeInteger(last.skippedSiteCount) &&
    (last.skippedSiteCount as number) >= 0 &&
    typeof last.agentPrincipal === 'string' &&
    UUID.test(last.agentPrincipal) &&
    Number.isSafeInteger(last.at) &&
    (last.at as number) > 0
  )
}

export function fileLastImportStore(file: string): LastImportStore {
  const load = (): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; owners?: unknown }

      return parsed.v === 1 && parsed.owners && typeof parsed.owners === 'object'
        ? (parsed.owners as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  return {
    read(ownerUserId) {
      const found = load()[key(ownerUserId)]

      return valid(found)
        ? {
            siteCount: found.siteCount,
            skippedSiteCount: found.skippedSiteCount,
            agentPrincipal: found.agentPrincipal,
            at: found.at
          }
        : null
    },

    write(ownerUserId, last) {
      mkdirSync(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ v: 1, owners: { ...load(), [key(ownerUserId)]: last } }), {
        mode: 0o600
      })
      chmodSync(temporary, 0o600)
      renameSync(temporary, file)
    }
  }
}
