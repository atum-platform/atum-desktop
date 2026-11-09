import {
  copyFileSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { MacBrowserHistoryEntry } from './contract'
import { safeHistoryTitle, sanitizeHistoryUrl } from './privacy'

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000
const DAY_MS = 86_400_000
const PROFILE = /^(?:Default|Profile \d+)$/u
const CHROME_COPY_PREFIX = 'atum-chrome-history-'
const STALE_CHROME_COPY_MS = 6 * 60 * 60 * 1_000

export class MacBrowserHistoryError extends Error {
  constructor(readonly code: 'permission_needed' | 'unavailable') {
    super(`matrix_mac_browser_${code}`)
  }
}

export interface BrowserHistoryReaderOptions {
  safariPath: string
  chromeRoot: string
  now?: () => number
  tmpDir?: () => string
}

interface OpenedDatabase {
  database: DatabaseSync
  close(): void
}

interface RawHistoryRow {
  url: string
  title: string | null
  visits: number
  visitMs: number
}

function sqlitePermissionFailure(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? '')
  const message = String((error as { message?: unknown } | null)?.message ?? '')

  return (
    ['EACCES', 'EPERM', 'SQLITE_CANTOPEN'].some(value => code.includes(value)) ||
    /(?:authorization denied|not permitted|permission denied|unable to open database)/iu.test(message)
  )
}

function readRows<T>(opened: OpenedDatabase, read: (db: DatabaseSync) => T, permission = false): T {
  try {
    return read(opened.database)
  } catch (error) {
    throw new MacBrowserHistoryError(permission && sqlitePermissionFailure(error) ? 'permission_needed' : 'unavailable')
  } finally {
    opened.close()
  }
}

function openReadOnly(file: string): OpenedDatabase {
  let database: DatabaseSync

  try {
    database = new DatabaseSync(file, { readOnly: true })
  } catch (error) {
    throw new MacBrowserHistoryError(sqlitePermissionFailure(error) ? 'permission_needed' : 'unavailable')
  }

  return { database, close: () => database.close() }
}

/** Chrome keeps History locked; copy its database and live SQLite sidecars before opening. */
export function openCopiedChromeHistory(
  databasePath: string,
  tmpDir: () => string = os.tmpdir
): OpenedDatabase {
  const directory = mkdtempSync(path.join(tmpDir(), CHROME_COPY_PREFIX))
  const copy = path.join(directory, 'History')
  const clean = () => rmSync(directory, { recursive: true, force: true })

  try {
    copyFileSync(databasePath, copy)

    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(databasePath + suffix)) {
        copyFileSync(databasePath + suffix, copy + suffix)
      }
    }

    // The private copy is writable so SQLite may recover a hot journal without touching Chrome.
    const database = new DatabaseSync(copy)

    return {
      database,
      close: () => {
        try {
          database.close()
        } finally {
          clean()
        }
      }
    }
  } catch {
    clean()
    throw new MacBrowserHistoryError('unavailable')
  }
}

/** Remove abandoned private Chrome copies without touching recent or unrelated temp entries. */
export function sweepStaleChromeHistoryCopies(
  directory: string = os.tmpdir(),
  now: () => number = Date.now
): void {
  let entries: Dirent[]

  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(CHROME_COPY_PREFIX)) {
      continue
    }

    const candidate = path.join(directory, entry.name)

    try {
      const metadata = lstatSync(candidate)

      if (!metadata.isSymbolicLink() && now() - metadata.mtimeMs > STALE_CHROME_COPY_MS) {
        rmSync(candidate, { recursive: true, force: true })
      }
    } catch {
      // A raced or unreadable temp entry is not a reason to stop the service.
    }
  }
}

function toEntry(browser: 'safari' | 'chrome', row: RawHistoryRow): MacBrowserHistoryEntry | null {
  const safe = sanitizeHistoryUrl(String(row.url ?? ''))

  if (!safe) {
    return null
  }

  const title = safeHistoryTitle(row.title, safe.domain)
  const visited = new Date(Number(row.visitMs))

  if (!title || !Number.isFinite(row.visitMs) || Number.isNaN(visited.valueOf())) {
    return null
  }

  return {
    browser,
    title,
    domain: safe.domain,
    path: safe.path,
    lastVisit: visited.toISOString(),
    visits: Math.max(1, Math.min(1_000_000, Number(row.visits) || 1))
  }
}

function readSafari(options: BrowserHistoryReaderOptions, days: number): MacBrowserHistoryEntry[] {
  let opened: OpenedDatabase

  try {
    opened = openReadOnly(options.safariPath)
  } catch (error) {
    if (error instanceof MacBrowserHistoryError) {
      throw error
    }
    throw new MacBrowserHistoryError('unavailable')
  }

  const now = (options.now ?? Date.now)()
  const appleSeconds = Math.max(0, (now - days * DAY_MS - APPLE_EPOCH_MS) / 1000)

  return readRows(
    opened,
    database => {
      const rows = database
        .prepare(
          `SELECT item.url AS url,
                  item.title AS title,
                  MAX(item.visit_count) AS visits,
                  CAST((MAX(visit.visit_time) * 1000) + ? AS INTEGER) AS visitMs
             FROM history_visits AS visit
             JOIN history_items AS item ON item.id = visit.history_item
            WHERE visit.visit_time >= ?
         GROUP BY item.id`
        )
        .all(APPLE_EPOCH_MS, appleSeconds) as unknown as RawHistoryRow[]

      return rows.flatMap(row => {
        const entry = toEntry('safari', row)

        return entry ? [entry] : []
      })
    },
    true
  )
}

export function discoverChromeHistoryDatabases(chromeRoot: string): string[] {
  try {
    return readdirSync(chromeRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && PROFILE.test(entry.name))
      .map(entry => path.join(chromeRoot, entry.name, 'History'))
      .filter(existsSync)
      .sort()
  } catch {
    return []
  }
}

function readChrome(options: BrowserHistoryReaderOptions, days: number): MacBrowserHistoryEntry[] {
  const now = (options.now ?? Date.now)()
  const chromiumMicros = BigInt(Math.trunc(now - days * DAY_MS + CHROMIUM_EPOCH_OFFSET_MS)) * 1000n
  const entries: MacBrowserHistoryEntry[] = []

  for (const databasePath of discoverChromeHistoryDatabases(options.chromeRoot)) {
    const opened = openCopiedChromeHistory(databasePath, options.tmpDir)
    const rows = readRows(opened, database =>
      database
        .prepare(
          `SELECT url,
                  title,
                  visit_count AS visits,
                  CAST((last_visit_time / 1000) - ? AS INTEGER) AS visitMs
             FROM urls
            WHERE last_visit_time >= ?`
        )
        .all(CHROMIUM_EPOCH_OFFSET_MS, chromiumMicros) as unknown as RawHistoryRow[]
    )

    for (const row of rows) {
      const entry = toEntry('chrome', row)

      if (entry) {
        entries.push(entry)
      }
    }
  }

  return entries
}

function aggregate(entries: MacBrowserHistoryEntry[]): MacBrowserHistoryEntry[] {
  const combined = new Map<string, MacBrowserHistoryEntry>()

  for (const entry of entries) {
    const key = `${entry.browser}\0${entry.domain}\0${entry.path}`
    const prior = combined.get(key)

    if (!prior) {
      combined.set(key, entry)
    } else {
      const newer = prior.lastVisit >= entry.lastVisit ? prior : entry
      combined.set(key, {
        ...newer,
        visits: Math.min(1_000_000, prior.visits + entry.visits)
      })
    }
  }

  return [...combined.values()]
}

export function readBrowserHistory(
  input: {
    browser: 'safari' | 'chrome' | 'all'
    days: number
    limit: number
    mode: 'recent' | 'top'
  },
  options: BrowserHistoryReaderOptions
): { history: MacBrowserHistoryEntry[]; permissionNeeded?: 'full_disk'[] } {
  if (
    !['safari', 'chrome', 'all'].includes(input.browser) ||
    !['recent', 'top'].includes(input.mode) ||
    !Number.isSafeInteger(input.days) ||
    input.days < 1 ||
    input.days > 90 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new MacBrowserHistoryError('unavailable')
  }

  const entries: MacBrowserHistoryEntry[] = []
  let safariPermissionNeeded = false

  if (input.browser !== 'chrome') {
    try {
      entries.push(...readSafari(options, input.days))
    } catch (error) {
      if (error instanceof MacBrowserHistoryError && error.code === 'permission_needed') {
        if (input.browser === 'safari') {
          throw error
        }
        safariPermissionNeeded = true
      } else {
        throw error
      }
    }
  }

  if (input.browser !== 'safari') {
    entries.push(...readChrome(options, input.days))
  }

  const history = aggregate(entries)
    .sort((left, right) =>
      input.mode === 'top'
        ? right.visits - left.visits || right.lastVisit.localeCompare(left.lastVisit)
        : right.lastVisit.localeCompare(left.lastVisit) || right.visits - left.visits
    )
    .slice(0, input.limit)

  return {
    history,
    ...(safariPermissionNeeded ? { permissionNeeded: ['full_disk' as const] } : {})
  }
}
