import type { ConsumerBrowserTab } from '@/app/atum/consumer-browser'

import type { MatrixDocumentPreview, MatrixSnapshot } from '../../shared/matrix'

export const MATRIX_WORKBENCH_RECENT_LIMIT = 20

const STORAGE_KEY = 'atum:matrix-workbench-recents:v1'

export interface MatrixWorkbenchRecentScope {
  accountId: string
  roomId: string
}

export type MatrixWorkbenchRecent =
  | {
      kind: 'browser'
      openedAt: number
      title: string
      url: string
    }
  | {
      kind: 'document'
      openedAt: number
      revision?: string
      title: string
    }

interface PersistedScope extends MatrixWorkbenchRecentScope {
  entries: MatrixWorkbenchRecent[]
}

interface PersistedRecents {
  activeAccountId?: string
  scopes: PersistedScope[]
  version: 1
}

function emptyState(): PersistedRecents {
  return { scopes: [], version: 1 }
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const text = value.replace(/\s+/gu, ' ').trim()

  return text ? text.slice(0, maximum) : null
}

/** A recent website keeps its useful path, but never credentials, a query, or a fragment. */
export function redactWorkbenchRecentUrl(value: string): string | null {
  try {
    const url = new URL(value)

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null
    }

    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''

    return url.href
  } catch {
    return null
  }
}

function validOpenedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseRecent(value: unknown): MatrixWorkbenchRecent | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const row = value as Record<string, unknown>
  const title = cleanText(row.title, 160)

  if (!title || !validOpenedAt(row.openedAt)) {
    return null
  }

  if (row.kind === 'browser' && typeof row.url === 'string') {
    const url = redactWorkbenchRecentUrl(row.url)

    return url ? { kind: 'browser', openedAt: row.openedAt, title, url } : null
  }

  if (row.kind === 'document') {
    const revision = row.revision === undefined ? undefined : cleanText(row.revision, 256)

    if (row.revision !== undefined && !revision) {
      return null
    }

    return { kind: 'document', openedAt: row.openedAt, title, ...(revision ? { revision } : {}) }
  }

  return null
}

function parseState(value: string | null): PersistedRecents {
  if (!value) {
    return emptyState()
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>

    if (parsed.version !== 1 || !Array.isArray(parsed.scopes)) {
      return emptyState()
    }

    const scopes: PersistedScope[] = []

    for (const candidate of parsed.scopes.slice(0, 100)) {
      if (!candidate || typeof candidate !== 'object') {
        continue
      }

      const row = candidate as Record<string, unknown>
      const accountId = cleanText(row.accountId, 512)
      const roomId = cleanText(row.roomId, 512)

      if (!accountId || !roomId || !Array.isArray(row.entries)) {
        continue
      }

      scopes.push({
        accountId,
        roomId,
        entries: row.entries
          .map(parseRecent)
          .filter((entry): entry is MatrixWorkbenchRecent => Boolean(entry))
          .slice(0, MATRIX_WORKBENCH_RECENT_LIMIT)
      })
    }

    const activeAccountId = cleanText(parsed.activeAccountId, 512) ?? undefined

    return { activeAccountId, scopes, version: 1 }
  } catch {
    return emptyState()
  }
}

function readState(storage: Pick<Storage, 'getItem'>): PersistedRecents {
  try {
    return parseState(storage.getItem(STORAGE_KEY))
  } catch {
    return emptyState()
  }
}

function writeState(storage: Pick<Storage, 'setItem'>, state: PersistedRecents): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Recents are a convenience. A full or unavailable store must not block a tab.
  }
}

export function matrixWorkbenchRecentStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function matrixWorkbenchRecentScope(
  snapshot: Pick<MatrixSnapshot, 'identity' | 'roomId'>
): MatrixWorkbenchRecentScope | null {
  return snapshot.identity?.userId && snapshot.roomId
    ? { accountId: snapshot.identity.userId, roomId: snapshot.roomId }
    : null
}

export function readMatrixWorkbenchRecents(
  storage: Pick<Storage, 'getItem'> | null,
  scope: MatrixWorkbenchRecentScope | null
): MatrixWorkbenchRecent[] {
  if (!storage || !scope) {
    return []
  }

  return (
    readState(storage).scopes.find(
      candidate => candidate.accountId === scope.accountId && candidate.roomId === scope.roomId
    )?.entries ?? []
  )
}

function recentIdentity(entry: MatrixWorkbenchRecent): string {
  return entry.kind === 'browser'
    ? `browser:${entry.url}`
    : `document:${entry.revision ?? ''}:${entry.title}`
}

export function recordMatrixWorkbenchRecent(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  scope: MatrixWorkbenchRecentScope | null,
  candidate: MatrixWorkbenchRecent | null
): MatrixWorkbenchRecent[] {
  if (!storage || !scope || !candidate) {
    return readMatrixWorkbenchRecents(storage, scope)
  }

  const entry = parseRecent(candidate)

  if (!entry) {
    return readMatrixWorkbenchRecents(storage, scope)
  }

  const state = readState(storage)

  const index = state.scopes.findIndex(
    saved => saved.accountId === scope.accountId && saved.roomId === scope.roomId
  )

  const previous = index >= 0 ? state.scopes[index]!.entries : []
  const identity = recentIdentity(entry)

  const entries = [entry, ...previous.filter(saved => recentIdentity(saved) !== identity)].slice(
    0,
    MATRIX_WORKBENCH_RECENT_LIMIT
  )

  const savedScope = { ...scope, entries }

  const scopes = index >= 0
    ? state.scopes.map((saved, savedIndex) => (savedIndex === index ? savedScope : saved))
    : [...state.scopes, savedScope]

  writeState(storage, { ...state, scopes })

  return entries
}

/**
 * The first workbench opened after a real account hand-off deletes the outgoing
 * account's local recents before loading the new account. Room changes retain their
 * own fenced lists.
 */
export function activateMatrixWorkbenchRecentAccount(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  accountId: string
): void {
  if (!storage || !accountId) {
    return
  }

  const state = readState(storage)

  const scopes = state.activeAccountId && state.activeAccountId !== accountId
    ? state.scopes.filter(scope => scope.accountId !== state.activeAccountId)
    : state.scopes

  writeState(storage, { ...state, activeAccountId: accountId, scopes })
}

export function clearMatrixWorkbenchRecents(storage: Pick<Storage, 'removeItem'> | null): void {
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    // Signing out must continue even when optional renderer storage is unavailable.
  }
}

export function matrixWorkbenchRecentFromBrowser(
  tab: ConsumerBrowserTab,
  openedAt = Date.now()
): MatrixWorkbenchRecent | null {
  if (tab.status !== 'ready') {
    return null
  }

  const url = redactWorkbenchRecentUrl(tab.url)

  if (!url) {
    return null
  }

  let fallback = url

  try {
    fallback = new URL(url).hostname.replace(/^www\./u, '')
  } catch {
    // The redactor already parsed this URL; retain its safe serialized value.
  }

  let title = cleanText(tab.title, 160) ?? fallback

  try {
    const original = new URL(tab.url)

    const sensitiveParts = [original.username, original.password, original.search.slice(1), original.hash.slice(1)]
      .filter(Boolean)
      .flatMap(part => {
        try {
          return [part, decodeURIComponent(part)]
        } catch {
          return [part]
        }
      })

    if (sensitiveParts.some(part => title.includes(part))) {
      title = fallback
    }
  } catch {
    title = fallback
  }

  return parseRecent({ kind: 'browser', openedAt, title, url })
}

export function matrixWorkbenchRecentFromDocument(
  preview: MatrixDocumentPreview,
  revision?: string,
  openedAt = Date.now()
): MatrixWorkbenchRecent | null {
  return parseRecent({ kind: 'document', openedAt, revision, title: preview.name })
}
