/** Stable desktop Team space message link. The payload carries identifiers only: platform
 * remains company/access truth and Matrix remains event truth when the link is opened. */
export interface MatrixMessageLinkTarget {
  companyId: string
  roomId: string
  eventId: string
  threadRootId?: string
}

export const MATRIX_MESSAGE_LINK_SCHEME = 'atum:'
export const MATRIX_MESSAGE_LINK_HOST = 'message'
export const MATRIX_MESSAGE_LINK_VERSION = 'v1'
export const MATRIX_MESSAGE_LINK_MAX_CHARS = 4096

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const ROOM_ID = /^![!-9;-~]{1,255}:[!-~]{1,255}$/u
const EVENT_ID = /^\$[!-~]{1,511}$/u
const BASE64URL = /^[A-Za-z0-9_-]+$/u
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = ''

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    encoded += ALPHABET[first >> 2]
    encoded += ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)]

    if (second !== undefined) {
      encoded += ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)]
    }
    if (third !== undefined) {
      encoded += ALPHABET[third & 63]
    }
  }

  return encoded
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    return null
  }
  const bytes: number[] = []

  for (let index = 0; index < value.length; index += 4) {
    const first = ALPHABET.indexOf(value[index]!)
    const second = ALPHABET.indexOf(value[index + 1]!)
    const third = index + 2 < value.length ? ALPHABET.indexOf(value[index + 2]!) : -1
    const fourth = index + 3 < value.length ? ALPHABET.indexOf(value[index + 3]!) : -1

    if (first < 0 || second < 0 || (index + 2 < value.length && third < 0) || (index + 3 < value.length && fourth < 0)) {
      return null
    }

    bytes.push((first << 2) | (second >> 4))
    if (third >= 0) {bytes.push(((second & 15) << 4) | (third >> 2))}
    if (fourth >= 0) {bytes.push(((third & 3) << 6) | fourth)}
  }

  return Uint8Array.from(bytes)
}

export function validMatrixMessageLinkTarget(value: unknown): value is MatrixMessageLinkTarget {
  if (!object(value)) {return false}
  const keys = value.threadRootId === undefined
    ? ['companyId', 'roomId', 'eventId']
    : ['companyId', 'roomId', 'eventId', 'threadRootId']

  return exact(value, keys) && UUID.test(String(value.companyId)) && ROOM_ID.test(String(value.roomId)) &&
    EVENT_ID.test(String(value.eventId)) &&
    (value.threadRootId === undefined ||
      (EVENT_ID.test(String(value.threadRootId)) && value.threadRootId !== value.eventId))
}

/** Opaque-enough, deterministic identifier envelope. It is not authorization and contains no copy. */
export function matrixMessageLink(target: MatrixMessageLinkTarget): string {
  if (!validMatrixMessageLinkTarget(target)) {
    throw new Error('matrix_message_link_invalid')
  }
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(target)))

  return `atum://${MATRIX_MESSAGE_LINK_HOST}/${MATRIX_MESSAGE_LINK_VERSION}/${payload}`
}

/** Parse hostile clipboard/OS input into the closed client-side target. */
export function parseMatrixMessageLink(value: unknown): MatrixMessageLinkTarget | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MATRIX_MESSAGE_LINK_MAX_CHARS) {
    return null
  }
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== MATRIX_MESSAGE_LINK_SCHEME || url.hostname !== MATRIX_MESSAGE_LINK_HOST ||
    url.username || url.password || url.port || url.search || url.hash) {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)

  if (parts.length !== 2 || parts[0] !== MATRIX_MESSAGE_LINK_VERSION) {
    return null
  }
  const bytes = decodeBase64Url(parts[1]!)

  if (!bytes || encodeBase64Url(bytes) !== parts[1]) {return null}

  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

    return validMatrixMessageLinkTarget(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Claims only the message route, including malformed attempts that must not fall through. */
export function isMatrixMessageLinkCandidate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MATRIX_MESSAGE_LINK_MAX_CHARS) {return false}

  try {
    const url = new URL(value)

    return url.protocol === MATRIX_MESSAGE_LINK_SCHEME && url.hostname === MATRIX_MESSAGE_LINK_HOST
  } catch {
    return /^atum:\/\/message(?:[/?#]|$)/i.test(value)
  }
}

export const MATRIX_MESSAGE_LINK_IPC = {
  pending: 'matrix:message-link:pending',
  opened: 'matrix:message-link:opened'
} as const

export interface MatrixMessageLinkBridge {
  takePending(): Promise<MatrixMessageLinkTarget | null>
  subscribe(listener: (target: MatrixMessageLinkTarget) => void): () => void
}
