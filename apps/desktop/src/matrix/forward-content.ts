import { matrixAttachmentMsgtype, matrixRoomTextTooLong } from '../../shared/matrix'
import { MATRIX_GOOGLE_PROVENANCE_KEY } from '../../shared/matrix-google-tools'

export const MATRIX_FORWARDED_KEY = 'io.atum.forwarded'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function mediaInfo(value: unknown, encrypted: boolean): Record<string, unknown> | undefined {
  const source = record(value)

  if (!source) {
    return undefined
  }

  const result: Record<string, unknown> = {}

  for (const key of ['mimetype', 'size', 'w', 'h'] as const) {
    if (typeof source[key] === (key === 'mimetype' ? 'string' : 'number')) {
      result[key] = source[key]
    }
  }

  const thumbnailInfo = record(source.thumbnail_info)
  const thumbnail = encrypted ? record(source.thumbnail_file) : source.thumbnail_url

  if (thumbnailInfo && thumbnail) {
    result.thumbnail_info = Object.fromEntries(
      Object.entries(thumbnailInfo).filter(([key, item]) =>
        ['mimetype', 'size', 'w', 'h'].includes(key) && typeof item === (key === 'mimetype' ? 'string' : 'number'))
    )
    if (encrypted) {
      result.thumbnail_file = thumbnail
    } else if (typeof thumbnail === 'string') {
      result.thumbnail_url = thumbnail
    }
  }

  return Object.keys(result).length ? result : undefined
}

/**
 * Element-style forwarding: send what the event shows now as a fresh message, retaining only
 * standard display/media fields. Relations, mentions and every Atum marker except protected
 * provenance are deliberately absent. Pattern adapted from Element Web's Apache-2.0
 * ForwardDialog/sendEvent flow; Atum's privacy projection is narrower.
 */
export function matrixForwardContent(source: Record<string, unknown>): Record<string, unknown> {
  const msgtype = source.msgtype === 'm.notice' ? 'm.text' : source.msgtype
  const body = source.body

  if (typeof msgtype !== 'string' || typeof body !== 'string' || !body.length || matrixRoomTextTooLong(body) ||
      (msgtype !== 'm.text' && !matrixAttachmentMsgtype(msgtype))) {
    throw new Error('matrix_forward_invalid')
  }

  const attachment = matrixAttachmentMsgtype(msgtype)
  const file = attachment ? record(source.file) : undefined
  const url = attachment && typeof source.url === 'string' ? source.url : undefined

  if (attachment && !file && !url) {
    throw new Error('matrix_forward_invalid')
  }

  const result: Record<string, unknown> = { msgtype, body, [MATRIX_FORWARDED_KEY]: true }

  if (source.format === 'org.matrix.custom.html' && typeof source.formatted_body === 'string') {
    result.format = source.format
    result.formatted_body = source.formatted_body
  }

  if (file) {
    result.file = file
  } else if (url) {
    result.url = url
  }

  if (attachment && typeof source.filename === 'string') {
    result.filename = source.filename
  }

  const info = attachment ? mediaInfo(source.info, Boolean(file)) : undefined
  if (info) {
    result.info = info
  }

  if (Object.prototype.hasOwnProperty.call(source, MATRIX_GOOGLE_PROVENANCE_KEY)) {
    result[MATRIX_GOOGLE_PROVENANCE_KEY] = source[MATRIX_GOOGLE_PROVENANCE_KEY]
  }

  return result
}

export async function matrixForwardTransactionId(
  sourceRoomId: string,
  eventId: string,
  targetRoomId: string,
  dialogNonce: string
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode([sourceRoomId, eventId, targetRoomId, dialogNonce].join('|'))
  ))
  const encoded = btoa(String.fromCharCode(...digest)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')

  return `atum-fw-${encoded.slice(0, 32)}`
}
