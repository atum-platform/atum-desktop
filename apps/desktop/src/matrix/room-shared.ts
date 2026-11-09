import { Attachment, EncryptedAttachment } from '@matrix-org/matrix-sdk-crypto-wasm'
import { EventType, type IContent, type MatrixClient, MatrixEvent, Method } from 'matrix-js-sdk'

import { MATRIX_MEDIA_TIMEOUT_MS } from '../../shared/matrix'
import {
  MATRIX_ROOM_SHARED_MAX_ITEMS,
  MATRIX_ROOM_SHARED_MAX_PAGES,
  MATRIX_ROOM_SHARED_PAGE_EVENTS,
  MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES,
  matrixRoomSharedFilter,
  matrixRoomSharedImageType,
  type MatrixRoomSharedItem,
  matrixRoomSharedItems,
  type MatrixRoomSharedPage,
  type MatrixRoomSharedSection,
  validMatrixRoomSharedToken
} from '../../shared/matrix-room-shared'

type SharedClient = Pick<MatrixClient, 'decryptEventIfNeeded'> & { http: Pick<MatrixClient['http'], 'authedRequest'> }

interface MessagesResponse {
  chunk?: unknown[]
  end?: string
}

/**
 * One bounded read of what a joined room has shared, newest first (shared/matrix-room-shared.ts).
 *
 * `encrypted`: the caller's answer to "may this room's plaintext be trusted?" (the same rule Save
 * uses). A plain room is filtered by the server (`contains_url`); an encrypted one is read as
 * ciphertext pages and decrypted here, and a plaintext event injected into it is ignored. Reads
 * stop at `limit` items, the room's start, or `MATRIX_ROOM_SHARED_MAX_PAGES` pages, whichever
 * comes first; `next` then continues from there.
 */
export async function readMatrixRoomShared(
  client: SharedClient,
  input: { roomId: string; section: MatrixRoomSharedSection; limit: number; from?: string; encrypted: boolean },
  alive: () => boolean = () => true
): Promise<MatrixRoomSharedPage> {
  const limit = Math.max(1, Math.min(input.limit, MATRIX_ROOM_SHARED_MAX_ITEMS))
  const filter = JSON.stringify(matrixRoomSharedFilter(input.section, input.encrypted))
  const items: MatrixRoomSharedItem[] = []
  let from = input.from
  let unreadable = 0

  if (from !== undefined && !validMatrixRoomSharedToken(from)) {
    throw new Error('matrix_room_shared_unavailable')
  }

  for (let page = 0; page < MATRIX_ROOM_SHARED_MAX_PAGES; page++) {
    const response = await client.http.authedRequest<MessagesResponse>(
      Method.Get,
      `/rooms/${encodeURIComponent(input.roomId)}/messages`,
      {
        dir: 'b',
        limit: String(MATRIX_ROOM_SHARED_PAGE_EVENTS),
        filter,
        ...(from ? { from } : {})
      }
    )

    if (!alive()) {
      throw new Error('matrix_room_shared_unavailable')
    }

    const chunk = Array.isArray(response?.chunk) ? response.chunk : []

    const events = chunk.flatMap(raw => {
      const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined

      return value && value.room_id === undefined ? [{ ...value, room_id: input.roomId }] : value ? [value] : []
    })

    const mapped = events.map(raw => new MatrixEvent(raw))

    if (input.encrypted) {
      await Promise.allSettled(
        mapped.filter(event => event.isEncrypted()).map(event => client.decryptEventIfNeeded(event))
      )

      if (!alive()) {
        throw new Error('matrix_room_shared_unavailable')
      }
    }

    for (const event of mapped) {
      const eventId = event.getId()
      const sender = event.getSender()
      const at = event.getTs()

      if (!eventId?.startsWith('$') || !sender?.startsWith('@') || !Number.isSafeInteger(at) || event.isRedacted()) {
        continue
      }

      // No downgrade: an encrypted room's messages count only when they arrived encrypted.
      if (input.encrypted && !event.isEncrypted()) {
        continue
      }

      if (event.isDecryptionFailure()) {
        unreadable++

        continue
      }

      if (event.getType() !== EventType.RoomMessage) {
        continue
      }

      items.push(
        ...matrixRoomSharedItems(input.section, {
          eventId,
          sender,
          at,
          content: event.getContent(),
          plain: !input.encrypted
        })
      )
    }

    const end = typeof response?.end === 'string' && validMatrixRoomSharedToken(response.end) ? response.end : undefined
    // The room's start is a missing `end` (Matrix spec, /messages). A filtered page can be empty
    // and still carry `end`: the server skipped events the filter dropped, so keep going. A token
    // that did not move would only repeat the same page.
    from = end !== from ? end : undefined

    if (!from || items.length >= limit) {
      break
    }
  }

  return {
    section: input.section,
    // Every item of the pages read (at most a few hundred small rows): a page is never cut in
    // half, so `next` loses nothing.
    items,
    ...(from ? { next: from } : {}),
    source: input.encrypted ? 'device' : 'server',
    unreadable
  }
}

function mxcParts(value: unknown): [string, string] | null {
  const match = typeof value === 'string' ? /^mxc:\/\/([^/\s?#]+)\/([^/\s?#]+)$/u.exec(value) : null

  return match ? [match[1]!, match[2]!] : null
}

/**
 * The SDK's fetch boundary (`boundedMatrixFetch`, media.ts) caps the body while it streams:
 * `/media/thumbnail` at the 8 MB thumbnail cap, `/media/download` at the file cap. The check here
 * holds a downloaded thumbnail or photo to the thumbnail cap as well.
 */
async function mediaBytes(client: Pick<SharedClient, 'http'>, path: string, query?: Record<string, string>): Promise<Uint8Array> {
  const blob = await client.http.authedRequest<Blob>(Method.Get, path, query, undefined, {
    prefix: '/_matrix/client/v1',
    rawResponseBody: true,
    localTimeoutMs: MATRIX_MEDIA_TIMEOUT_MS
  })

  if (blob.size > MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES) {
    throw new Error('matrix_room_shared_thumbnail_unavailable')
  }

  return new Uint8Array(await blob.arrayBuffer())
}

function decrypted(bytes: Uint8Array, file: Record<string, unknown>): Uint8Array {
  const encrypted = new EncryptedAttachment(bytes, JSON.stringify(file))

  try {
    return Attachment.decrypt(encrypted)
  } finally {
    encrypted.free()
  }
}

function dataUrl(bytes: Uint8Array): string | null {
  const type = matrixRoomSharedImageType(bytes)

  if (!type) {
    return null
  }

  let binary = ''

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }

  return `data:${type};base64,${btoa(binary)}`
}

/**
 * A shared photo's or video's picture, from its already-decrypted content: the sender's own
 * thumbnail when there is one, otherwise (a photo only) the photo itself when it is small enough.
 * Encrypted media is downloaded through authenticated media (MSC3916) and decrypted here; a plain
 * room's photo asks the server for a scaled thumbnail (`/media/thumbnail`). `plain`: the event came
 * as plaintext in a room confirmed to have no encryption. Null when there is no picture to show.
 */
export async function readMatrixRoomSharedThumbnail(
  client: SharedClient,
  content: IContent,
  plain: boolean
): Promise<string | null> {
  const msgtype = content.msgtype
  const info = content.info && typeof content.info === 'object' ? (content.info as Record<string, unknown>) : {}

  if (msgtype !== 'm.image' && msgtype !== 'm.video') {
    return null
  }

  const thumbnailFile =
    info.thumbnail_file && typeof info.thumbnail_file === 'object'
      ? (info.thumbnail_file as Record<string, unknown>)
      : undefined

  const file = content.file && typeof content.file === 'object' ? (content.file as Record<string, unknown>) : undefined

  if (thumbnailFile) {
    const parts = mxcParts(thumbnailFile.url)

    return parts
      ? dataUrl(
          decrypted(
            await mediaBytes(client, `/media/download/${parts.map(encodeURIComponent).join('/')}`),
            thumbnailFile
          )
        )
      : null
  }

  if (file) {
    const size = Number(info.size)
    const parts = mxcParts(file.url)

    if (msgtype !== 'm.image' || !parts || (Number.isFinite(size) && size > MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES)) {
      return null
    }

    return dataUrl(
      decrypted(await mediaBytes(client, `/media/download/${parts.map(encodeURIComponent).join('/')}`), file)
    )
  }

  if (!plain) {
    return null
  }

  return readMatrixPlainThumbnail(client, msgtype === 'm.image' ? content.url : info.thumbnail_url)
}

/**
 * A plain (unencrypted) `mxc://` picture as the server's scaled thumbnail, through authenticated
 * media at the thumbnail cap: a plain room's photo, or a link preview's page picture. Null when it
 * is not an `mxc://` URI or not a picture the window may paint.
 */
export async function readMatrixPlainThumbnail(client: Pick<SharedClient, 'http'>, mxc: unknown): Promise<string | null> {
  const parts = mxcParts(mxc)

  return parts
    ? dataUrl(
        await mediaBytes(client, `/media/thumbnail/${parts.map(encodeURIComponent).join('/')}`, {
          width: '320',
          height: '320',
          method: 'scale',
          animated: 'false'
        })
      )
    : null
}
