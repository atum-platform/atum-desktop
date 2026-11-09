/** Matrix presence is display-only. It never grants room, company or message access. */
export type MatrixPresenceState = 'online' | 'away' | 'offline'

export interface MatrixCustomStatus {
  emoji?: string
  text?: string
  dnd: boolean
  /** Milliseconds since the Unix epoch. Missing only for a status written by another client. */
  expiresAt?: number
}

export interface MatrixUserPresence {
  userId: string
  /** Missing when a local status write is staged before the homeserver emits m.presence. */
  state?: MatrixPresenceState
  displayName?: string
  avatarMxc?: string | null
  status?: MatrixCustomStatus
}

export interface MatrixPresenceSnapshot {
  users: MatrixUserPresence[]
}

export interface MatrixStatusInput {
  emoji?: string
  text?: string
  dnd: boolean
  expiresAt: number
}

export const MATRIX_STATUS_TEXT_MAX = 100
export const MATRIX_STATUS_EMOJI_MAX = 16
export const MATRIX_STATUS_MESSAGE_MAX = 512
export const MATRIX_STATUS_EXPIRY_MAX_MS = 31 * 24 * 60 * 60 * 1_000

const EXPIRY = / · until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/u
const DND_PREFIX = '⛔ DND'
const CONTROL = /\p{Cc}/gu
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u

const codePoints = (value: string) => [...value]

function oneGrapheme(value: string): boolean {
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]

  return segments.length === 1
}

export function validMatrixStatusEmoji(value: string): boolean {
  return Boolean(value && codePoints(value).length <= MATRIX_STATUS_EMOJI_MAX && oneGrapheme(value) && EMOJI.test(value))
}

export function normalizeMatrixStatusText(value: string): string {
  return value.replace(CONTROL, ' ').trim().replace(/\s+/gu, ' ')
}

export function validMatrixStatusInput(value: MatrixStatusInput, now = Date.now()): boolean {
  const text = normalizeMatrixStatusText(value.text ?? '')
  const emoji = value.emoji?.trim() ?? ''

  return (
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > now &&
    value.expiresAt <= now + MATRIX_STATUS_EXPIRY_MAX_MS &&
    codePoints(text).length <= MATRIX_STATUS_TEXT_MAX &&
    (!emoji || validMatrixStatusEmoji(emoji)) &&
    (Boolean(text) || Boolean(emoji) || value.dnd)
  )
}

/**
 * A readable Matrix `status_msg`: standard clients show the same useful line, while Atum clients
 * understand the DND prefix and exact expiry. Expiry is presentation metadata; readers hide it
 * locally and never issue an expiry-time clear that could overwrite a newer status.
 */
export function matrixStatusMessage(value: MatrixStatusInput): string {
  const body = [value.dnd ? DND_PREFIX : '', value.emoji?.trim() ?? '', normalizeMatrixStatusText(value.text ?? '')]
    .filter(Boolean)
    .join(' ')
  const output = `${body} · until ${new Date(value.expiresAt).toISOString()}`

  if (output.length > MATRIX_STATUS_MESSAGE_MAX) {
    throw new Error('matrix_status_invalid')
  }

  return output
}

function firstGrapheme(value: string): [string, string] {
  const first = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)][0]

  return first ? [first.segment, value.slice(first.index + first.segment.length).trimStart()] : ['', '']
}

/** Standard clients may write an unstructured status; Atum presents that text without inventing expiry. */
export function parseMatrixStatusMessage(value: unknown, now = Date.now()): MatrixCustomStatus | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > MATRIX_STATUS_MESSAGE_MAX) {
    return undefined
  }

  let body = value.trim()
  let expiresAt: number | undefined
  const expiry = EXPIRY.exec(body)

  if (expiry) {
    expiresAt = Date.parse(expiry[1]!)
    body = body.slice(0, expiry.index).trim()

    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return undefined
    }
  }

  const dnd = body === DND_PREFIX || body.startsWith(`${DND_PREFIX} `)
  if (dnd) {
    body = body.slice(DND_PREFIX.length).trimStart()
  }

  const [candidate, rest] = firstGrapheme(body)
  const emoji = validMatrixStatusEmoji(candidate) ? candidate : undefined
  const text = normalizeMatrixStatusText(emoji ? rest : body)

  if (!dnd && !emoji && !text) {
    return undefined
  }

  return {
    dnd,
    ...(emoji ? { emoji } : {}),
    ...(text ? { text } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt })
  }
}

/** A missing m.presence event means unknown/disabled, never a fabricated offline state. */
export function matrixPresenceState(value: unknown, observed: boolean): MatrixPresenceState | undefined {
  if (!observed) {
    return undefined
  }

  if (value === 'online') {
    return 'online'
  }

  if (value === 'unavailable') {
    return 'away'
  }

  return value === 'offline' ? 'offline' : undefined
}

export function matrixOwnDnd(
  snapshot: { identity: { userId: string } | null; presence?: MatrixPresenceSnapshot },
  now = Date.now()
): boolean {
  const status = snapshot.presence?.users.find(user => user.userId === snapshot.identity?.userId)?.status

  return Boolean(status?.dnd && (status.expiresAt === undefined || status.expiresAt > now))
}
