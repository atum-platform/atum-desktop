import { matrixOwnDnd, type MatrixPresenceSnapshot } from './matrix-presence'

export const MATRIX_NOTIFICATION_POLICY_ACCOUNT_DATA = 'io.atum.notifications.v1' as const
export const MATRIX_NOTIFICATION_POLICY_TARGET_PREFIX = 'io.atum.notification.v2.' as const

export type MatrixNotificationLevel = 'all' | 'mentions' | 'nothing'
export type MatrixNotificationOverride = 'inherit' | MatrixNotificationLevel

export interface MatrixQuietHours {
  enabled: boolean
  startMinute: number
  endMinute: number
  timeZone: string
}

export interface MatrixNotificationPolicyContent {
  [key: string]: unknown
  version: 1
  accountLevel: MatrixNotificationLevel
  quietHours: MatrixQuietHours
  channelOverrides: Record<string, MatrixNotificationLevel>
  threadOverrides: Record<string, Record<string, MatrixNotificationLevel>>
}

export interface MatrixNotificationPolicy extends MatrixNotificationPolicyContent {
  writable: boolean
}

export type MatrixNotificationPolicyChange =
  | { scope: 'account'; level: MatrixNotificationLevel }
  | { scope: 'quietHours'; quietHours: MatrixQuietHours }
  | { scope: 'channel'; roomId: string; level: MatrixNotificationOverride }
  | { scope: 'thread'; roomId: string; rootId: string; level: MatrixNotificationOverride }

export interface MatrixNotificationPolicyTargetContent {
  version: 2
  revision: number
  expected_revision: number
  change: MatrixNotificationPolicyChange
}

const ROOM_ID = /^!.{1,1023}$/u
const EVENT_ID = /^\$.{1,1023}$/u
const TIME_ZONE_MAX = 100
const CHANNEL_OVERRIDE_MAX = 500
const THREAD_OVERRIDE_MAX = 1_000

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function matrixSystemTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

    return validMatrixTimeZone(zone) ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
}

export function validMatrixTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > TIME_ZONE_MAX) {
    return false
  }

  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)

    return true
  } catch {
    return false
  }
}

export function defaultMatrixNotificationPolicy(
  timeZone = matrixSystemTimeZone()
): MatrixNotificationPolicyContent {
  return {
    version: 1,
    accountLevel: 'mentions',
    quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 7 * 60, timeZone },
    channelOverrides: {},
    threadOverrides: {}
  }
}

export function validMatrixNotificationLevel(value: unknown): value is MatrixNotificationLevel {
  return value === 'all' || value === 'mentions' || value === 'nothing'
}

export function validMatrixNotificationOverride(value: unknown): value is MatrixNotificationOverride {
  return value === 'inherit' || validMatrixNotificationLevel(value)
}

export function parseMatrixQuietHours(value: unknown): MatrixQuietHours | undefined {
  const row = record(value)

  if (
    !row ||
    typeof row.enabled !== 'boolean' ||
    !Number.isInteger(row.startMinute) ||
    Number(row.startMinute) < 0 ||
    Number(row.startMinute) > 1_439 ||
    !Number.isInteger(row.endMinute) ||
    Number(row.endMinute) < 0 ||
    Number(row.endMinute) > 1_439 ||
    !validMatrixTimeZone(row.timeZone)
  ) {
    return undefined
  }

  return {
    enabled: row.enabled,
    startMinute: Number(row.startMinute),
    endMinute: Number(row.endMinute),
    timeZone: row.timeZone
  }
}

function levelMap(value: unknown, key: RegExp, limit: number): Record<string, MatrixNotificationLevel> | undefined {
  const row = record(value)

  if (!row || Object.keys(row).length > limit) {
    return undefined
  }

  const entries = Object.entries(row)
  if (entries.some(([id, level]) => !key.test(id) || !validMatrixNotificationLevel(level))) {
    return undefined
  }

  const parsed: Record<string, MatrixNotificationLevel> = {}
  for (const [id, level] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    parsed[id] = level as MatrixNotificationLevel
  }

  return parsed
}

function threadLevelMap(value: unknown): Record<string, Record<string, MatrixNotificationLevel>> | undefined {
  const rooms = record(value)

  if (!rooms || Object.keys(rooms).length > CHANNEL_OVERRIDE_MAX) {
    return undefined
  }

  let count = 0
  const parsed: Record<string, Record<string, MatrixNotificationLevel>> = {}

  for (const [roomId, raw] of Object.entries(rooms).sort(([left], [right]) => left.localeCompare(right))) {
    if (!ROOM_ID.test(roomId)) {
      return undefined
    }

    const threads = levelMap(raw, EVENT_ID, THREAD_OVERRIDE_MAX)
    if (!threads) {
      return undefined
    }

    count += Object.keys(threads).length
    if (count > THREAD_OVERRIDE_MAX) {
      return undefined
    }

    if (Object.keys(threads).length > 0) {
      parsed[roomId] = threads
    }
  }

  return parsed
}

/** Unknown/newer or malformed records are read-only, never partially trusted. */
export function parseMatrixNotificationPolicy(value: unknown): MatrixNotificationPolicyContent | undefined {
  const row = record(value)

  if (!row || row.version !== 1 || !validMatrixNotificationLevel(row.accountLevel)) {
    return undefined
  }

  const quietHours = parseMatrixQuietHours(row.quietHours)
  const channelOverrides = levelMap(row.channelOverrides, ROOM_ID, CHANNEL_OVERRIDE_MAX)
  const threadOverrides = threadLevelMap(row.threadOverrides)

  if (!quietHours || !channelOverrides || !threadOverrides) {
    return undefined
  }

  return {
    version: 1,
    accountLevel: row.accountLevel,
    quietHours,
    channelOverrides,
    threadOverrides
  }
}

export function matrixNotificationPolicyChange(value: unknown): MatrixNotificationPolicyChange {
  const row = record(value)

  if (!row || typeof row.scope !== 'string') {
    throw new Error('matrix_notification_policy_invalid')
  }

  if (row.scope === 'account' && validMatrixNotificationLevel(row.level)) {
    return { scope: 'account', level: row.level }
  }

  if (row.scope === 'quietHours') {
    const quietHours = parseMatrixQuietHours(row.quietHours)

    if (quietHours) {
      return { scope: 'quietHours', quietHours }
    }
  }

  if (row.scope === 'channel' && typeof row.roomId === 'string' && ROOM_ID.test(row.roomId) &&
    validMatrixNotificationOverride(row.level)) {
    return { scope: 'channel', roomId: row.roomId, level: row.level }
  }

  if (
    row.scope === 'thread' &&
    typeof row.roomId === 'string' &&
    ROOM_ID.test(row.roomId) &&
    typeof row.rootId === 'string' &&
    EVENT_ID.test(row.rootId) &&
    validMatrixNotificationOverride(row.level)
  ) {
    return { scope: 'thread', roomId: row.roomId, rootId: row.rootId, level: row.level }
  }

  throw new Error('matrix_notification_policy_invalid')
}

export function matrixNotificationPolicyTargetKey(change: MatrixNotificationPolicyChange): string {
  switch (change.scope) {
    case 'account': return 'account'
    case 'quietHours': return 'quiet-hours'
    case 'channel': return `channel\0${change.roomId}`
    case 'thread': return `thread\0${change.roomId}\0${change.rootId}`
  }
}

export function parseMatrixNotificationPolicyTarget(value: unknown): MatrixNotificationPolicyTargetContent | undefined {
  const row = record(value)
  const revision = Number(row?.revision)
  const expectedRevision = Number(row?.expected_revision)

  if (
    !row ||
    row.version !== 2 ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision !== revision - 1
  ) {
    return undefined
  }

  try {
    return {
      version: 2,
      revision,
      expected_revision: expectedRevision,
      change: matrixNotificationPolicyChange(row.change)
    }
  } catch {
    return undefined
  }
}

/** Per-target records override the legacy aggregate during the rolling migration. */
export function mergeMatrixNotificationPolicyTargets(
  legacy: MatrixNotificationPolicyContent,
  targets: readonly MatrixNotificationPolicyTargetContent[]
): MatrixNotificationPolicyContent {
  return targets.reduce(
    (current, target) => applyMatrixNotificationPolicyChange(current, target.change),
    legacy
  )
}

export function applyMatrixNotificationPolicyChange(
  current: MatrixNotificationPolicyContent,
  input: MatrixNotificationPolicyChange
): MatrixNotificationPolicyContent {
  const next: MatrixNotificationPolicyContent = {
    ...current,
    quietHours: { ...current.quietHours },
    channelOverrides: { ...current.channelOverrides },
    threadOverrides: Object.fromEntries(
      Object.entries(current.threadOverrides).map(([roomId, threads]) => [roomId, { ...threads }])
    )
  }

  if (input.scope === 'account') {
    next.accountLevel = input.level
  } else if (input.scope === 'quietHours') {
    next.quietHours = { ...input.quietHours }
  } else if (input.scope === 'channel') {
    if (input.level === 'inherit') {
      delete next.channelOverrides[input.roomId]
    } else {
      next.channelOverrides[input.roomId] = input.level
    }
  } else {
    const threads = { ...(next.threadOverrides[input.roomId] ?? {}) }

    if (input.level === 'inherit') {
      delete threads[input.rootId]
    } else {
      threads[input.rootId] = input.level
    }

    if (Object.keys(threads).length) {
      next.threadOverrides[input.roomId] = threads
    } else {
      delete next.threadOverrides[input.roomId]
    }
  }

  return next
}

/** Notification attention is one explicit ladder: thread, channel, account. */
export function matrixResolvedNotificationLevel(
  policy: Pick<MatrixNotificationPolicyContent, 'accountLevel' | 'channelOverrides' | 'threadOverrides'>,
  roomId: string,
  rootId?: string
): MatrixNotificationLevel {
  return (rootId ? policy.threadOverrides[roomId]?.[rootId] : undefined) ??
    policy.channelOverrides[roomId] ??
    policy.accountLevel
}

function minuteInTimeZone(now: number, timeZone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      timeZone
    }).formatToParts(now)
    const hour = Number(parts.find(part => part.type === 'hour')?.value)
    const minute = Number(parts.find(part => part.type === 'minute')?.value)

    return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : undefined
  } catch {
    return undefined
  }
}

/** A daily wall-clock window in its saved IANA zone; equal endpoints mean an empty window. */
export function matrixQuietHoursActive(quietHours: MatrixQuietHours, now = Date.now()): boolean {
  if (!quietHours.enabled || quietHours.startMinute === quietHours.endMinute) {
    return false
  }

  const minute = minuteInTimeZone(now, quietHours.timeZone)
  if (minute === undefined) {
    return false
  }

  return quietHours.startMinute < quietHours.endMinute
    ? minute >= quietHours.startMinute && minute < quietHours.endMinute
    : minute >= quietHours.startMinute || minute < quietHours.endMinute
}

/** E6 status DND and E2 quiet hours are one effective attention state. */
export function matrixEffectiveDoNotDisturb(
  snapshot: {
    identity: { userId: string } | null
    presence?: MatrixPresenceSnapshot
    notificationPolicy?: Pick<MatrixNotificationPolicyContent, 'quietHours'>
  },
  now = Date.now()
): boolean {
  return matrixOwnDnd(snapshot, now) || Boolean(
    snapshot.notificationPolicy && matrixQuietHoursActive(snapshot.notificationPolicy.quietHours, now)
  )
}
