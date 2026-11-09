export const APP_HISTORY_PROFILE = 'atum.app-history/1' as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SOURCE = /^[a-z][a-z0-9_-]{0,63}$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

export interface MatrixAppHistoryEntry {
  id: string
  revision: number
  occurredAt: number
  role: 'owner' | 'app'
  source: { id: string; label: { vi: string; en: string } }
  text: string
}

export interface MatrixAppHistoryPage {
  profile: typeof APP_HISTORY_PROFILE
  appId: string
  appVersionId: string
  entries: MatrixAppHistoryEntry[]
  nextCursor: string | null
  hasMore: boolean
  freshnessMs: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function fail(): never {
  throw new Error('matrix_app_history_invalid')
}

export function parseMatrixAppHistoryPage(value: unknown, appId: string, appVersionId: string): MatrixAppHistoryPage {
  const page = record(value)
  const app = page ? record(page.app) : null
  if (
    !page ||
    !exact(page, ['profile', 'app', 'entries', 'next_cursor', 'has_more', 'freshness_ms']) ||
    page.profile !== APP_HISTORY_PROFILE ||
    !app ||
    !exact(app, ['id', 'app_version_id']) ||
    app.id !== appId ||
    app.app_version_id !== appVersionId ||
    !UUID.test(appId) ||
    !UUID.test(appVersionId) ||
    !Array.isArray(page.entries) ||
    page.entries.length > 20 ||
    typeof page.has_more !== 'boolean' ||
    !Number.isSafeInteger(page.freshness_ms) ||
    Number(page.freshness_ms) < 0 ||
    Number(page.freshness_ms) > 86_400_000 ||
    (page.next_cursor !== null && !text(page.next_cursor, 2048)) ||
    page.has_more !== (page.next_cursor !== null)
  )
    fail()

  const entries = page.entries.map(raw => {
    const entry = record(raw)
    const source = entry ? record(entry.source) : null
    const label = source ? record(source.label) : null
    const id = entry ? text(entry.id, 2048) : null
    const body = entry ? text(entry.text, 12_000) : null
    const sourceId = source ? text(source.id, 64) : null
    const vi = label ? text(label.vi, 1000) : null
    const en = label ? text(label.en, 1000) : null
    const occurred =
      entry && typeof entry.occurred_at === 'string' && UTC.test(entry.occurred_at)
        ? Date.parse(entry.occurred_at)
        : Number.NaN
    if (
      !entry ||
      !exact(entry, ['id', 'revision', 'occurred_at', 'role', 'text', 'source']) ||
      !source ||
      !exact(source, ['id', 'label']) ||
      !label ||
      !exact(label, ['vi', 'en']) ||
      !id ||
      !body ||
      !sourceId ||
      !SOURCE.test(sourceId) ||
      !vi ||
      !en ||
      !Number.isSafeInteger(entry.revision) ||
      Number(entry.revision) < 1 ||
      (entry.role !== 'owner' && entry.role !== 'app') ||
      !Number.isFinite(occurred)
    )
      fail()
    const role: MatrixAppHistoryEntry['role'] = entry.role
    return {
      id,
      revision: Number(entry.revision),
      occurredAt: occurred,
      role,
      text: body,
      source: { id: sourceId, label: { vi, en } }
    }
  })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail()
  return {
    profile: APP_HISTORY_PROFILE,
    appId,
    appVersionId,
    entries,
    nextCursor: page.next_cursor as string | null,
    hasMore: page.has_more,
    freshnessMs: Number(page.freshness_ms)
  }
}
