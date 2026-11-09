import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk'

import {
  matrixFirstPreviewLink,
  type MatrixLinkPreview,
  matrixLinkPreviewDay,
  matrixLinkPreviewFromOpenGraph,
  matrixLinkPreviewImageMxc,
  matrixLinkPreviewKey
} from '../../shared/matrix-link-preview'

import { confirmedPlainRoom } from './plain-room'
import { readMatrixPlainThumbnail } from './room-shared'

/** Previews remembered per SDK session, by link and day. */
const CACHE_LIMIT = 256
const TEXT_MSGTYPES = new Set(['m.text', 'm.notice', 'm.emote'])

type PreviewClient = Pick<MatrixClient, 'getRoom' | 'getCrypto' | 'getUrlPreview'> & {
  http: Pick<MatrixClient['http'], 'authedRequest'>
}

/**
 * Link previews for the chat on screen, from the homeserver's native URL preview (the SDK's own
 * `getUrlPreview`, authenticated media on v1.11+). The window names a joined room's message; the
 * link is read from that event here, and only in a room this SDK confirms has no encryption.
 * A page picture is the server's own thumbnail of the `mxc://` it stored, never fetched from the web.
 */
export function matrixLinkPreviews(client: PreviewClient, alive: () => boolean, now: () => number = Date.now) {
  const cache = new Map<string, Promise<MatrixLinkPreview | null>>()

  function remember(key: string, value: Promise<MatrixLinkPreview | null>) {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value

      if (oldest !== undefined) {
        cache.delete(oldest)
      }
    }

    cache.set(key, value)
  }

  async function fetchPreview(url: string, at: number): Promise<MatrixLinkPreview | null> {
    // The server keys its own cache by `ts`; asking for the day's start lets it answer from it.
    const og: unknown = await client.getUrlPreview(url, matrixLinkPreviewDay(at) * 86_400_000)
    const mxc = matrixLinkPreviewImageMxc(og)
    const image = mxc && alive() ? await readMatrixPlainThumbnail(client, mxc).catch(() => null) : null

    return alive() ? matrixLinkPreviewFromOpenGraph(url, og, image) : null
  }

  async function read(roomId: string, eventId: string): Promise<MatrixLinkPreview | null> {
    const room = client.getRoom(roomId)

    if (!room || room.getMyMembership() !== 'join') {
      return null
    }

    const event: MatrixEvent | null | undefined = room.findEventById(eventId)

    if (!event || event.isEncrypted() || event.isRedacted() || event.getType() !== 'm.room.message') {
      return null
    }

    const content = event.getContent()

    if (!TEXT_MSGTYPES.has(content.msgtype as string)) {
      return null
    }

    const url = matrixFirstPreviewLink(content.body)

    // Encrypted chats keep their links: no server is asked to fetch one (E2EE is opt-in; plain is the default).
    if (!url || !(await confirmedPlainRoom(client, room))) {
      return null
    }

    const at = now()
    const key = matrixLinkPreviewKey(url, at)
    const known = cache.get(key)

    if (known) {
      return known
    }

    const request = fetchPreview(url, at)

    remember(key, request)
    // A failed read is not remembered: the next time the message is on screen asks again.
    request.catch(() => {
      if (cache.get(key) === request) {
        cache.delete(key)
      }
    })

    return request
  }

  return { read }
}
