import { createHash } from 'node:crypto'

/**
 * The platform's internal daily-cap notice claim (`atum.daily-cap-notice/1`, 0270). Both the cloud
 * controller and the Mac's main process speak it; neither renders a cap, spend or remaining number.
 * The platform owns the unique claim; the runtime only delivers and acknowledges one Matrix event.
 */
export const MATRIX_DAILY_CAP_NOTICE_PROFILE = 'atum.daily-cap-notice/1' as const
export const MATRIX_DAILY_CAP_NOTICE_JOB = 'daily-cap-warning' as const
const NOTICE_KEY = /^daily-cap-notice:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[0-9]{4}-[0-9]{2}-[0-9]{2}:eighty_percent$/i
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

export type MatrixDailyCapNoticeClaim =
  | { state: 'none' }
  | { state: 'held' }
  | { state: 'claim'; noticeKey: string; kind: 'eighty_percent'; day: string }
  | { state: 'published' }

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

/** The closed claim answer, exactly; a malformed one is refused, never best-effort. */
export function parseMatrixDailyCapNotice(value: unknown): MatrixDailyCapNoticeClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('daily_cap_notice_invalid')
  const result = value as Record<string, unknown>
  if (result.profile !== MATRIX_DAILY_CAP_NOTICE_PROFILE) throw Error('daily_cap_notice_invalid')
  if (result.state === 'none' || result.state === 'held' || result.state === 'published') {
    if (!exact(result, ['profile', 'state'])) throw Error('daily_cap_notice_invalid')
    return { state: result.state }
  }
  if (result.state === 'claim') {
    if (!exact(result, ['profile', 'state', 'noticeKey', 'kind', 'day'])
      || result.kind !== 'eighty_percent'
      || typeof result.noticeKey !== 'string' || result.noticeKey.length > 200 || !NOTICE_KEY.test(result.noticeKey)
      || typeof result.day !== 'string' || !DAY.test(result.day)) {
      throw Error('daily_cap_notice_invalid')
    }
    return { state: 'claim', noticeKey: result.noticeKey, kind: result.kind, day: result.day }
  }
  throw Error('daily_cap_notice_invalid')
}

/**
 * A deterministic lowercase v4 UUID for one notice key. `publishCron` fixes its Matrix transaction
 * to the run id and `findTurn(marker=cron)` reads the same id back. Matrix scopes a transaction id
 * to the sending device, so this is one run identity, not a cross-device exactly-once proof; the
 * platform's single reservation, not this id, prevents a second device from sending. It is not a
 * secret: it names only the agent's day and kind.
 */
/** The HCM day's first instant, as the read-back's lower bound (the claim's own `day`). */
export function matrixDailyCapNoticeSince(day: string): number {
  const start = Date.parse(`${day}T00:00:00+07:00`)
  return Number.isFinite(start) ? start : 0
}

export function matrixDailyCapNoticeRunId(noticeKey: string): string {
  const hex = createHash('sha256').update(noticeKey).digest('hex')
  const variant = (8 | (Number.parseInt(hex[16]!, 16) & 3)).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
