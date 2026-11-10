import { createHash } from 'node:crypto'

import type { MacSourceScanResult } from '../../../../../packages/device-protocol/mac-sources'

/** Opaque cursors carry device provenance: another Mac's digest never suppresses local evidence. */
interface ScanCursor { deviceServiceId: string; at: number; rows: Record<string, string> }
const DAY = 86_400_000
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function scanResult(deviceServiceId: string, value: Record<string, unknown>, prior: unknown, now = Date.now()): MacSourceScanResult {
  if ('error' in value) {return { error: String(value.error) }}
  let cursor: ScanCursor | undefined

  try {
    const parsed = typeof prior === 'string' && prior.length <= 16_384 ? JSON.parse(prior) : null

    if (parsed && parsed.deviceServiceId === deviceServiceId && Number.isSafeInteger(parsed.at) &&
        parsed.at >= now - DAY && parsed.at <= now && parsed.rows && typeof parsed.rows === 'object' && !Array.isArray(parsed.rows) && Object.values(parsed.rows).every(value => typeof value === 'string')) {cursor = parsed}
  } catch { /* Foreign, expired and invalid cursors replay at most one day. */ }

  const rows: Array<{ localId: string; observedAt: number; data: unknown }> = []

  if (Array.isArray(value.conversations)) {
    for (const row of value.conversations) {rows.push({ localId: String(row.id), observedAt: Date.parse(row.lastActivity), data: row })}
  } else if (Array.isArray(value.history)) {
    for (const row of value.history) {rows.push({ localId: hash([row.browser, row.domain, row.path]), observedAt: Date.parse(row.lastVisit), data: row })}
  } else if (typeof value.timeZone === 'string') {
    rows.push({ localId: 'current-city', observedAt: now, data: value })
  }

  const bounded = rows.filter(row => Number.isFinite(row.observedAt) && row.observedAt >= now - DAY && row.observedAt <= now).slice(0, 50)
  const revisions = Object.fromEntries(bounded.map(row => [row.localId, hash(row.data)]))
  const next = JSON.stringify({ deviceServiceId, at: now, rows: revisions })

  return { status: 'ok', cursor: next, entries: bounded.filter(row => !cursor || row.observedAt > cursor.at || cursor.rows[row.localId] !== revisions[row.localId]).map(row => ({
    objectId: `${deviceServiceId}:${row.localId}`, observedAt: row.observedAt,
    provenance: { deviceServiceId }, fresh: !cursor || cursor.rows[row.localId] !== revisions[row.localId], data: row.data
  })) }
}
