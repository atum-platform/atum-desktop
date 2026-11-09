// @vitest-environment node
import { Attachment, initAsync } from '@matrix-org/matrix-sdk-crypto-wasm'
import type { MatrixEvent } from 'matrix-js-sdk'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { readMatrixRoomShared, readMatrixRoomSharedThumbnail } from './room-shared'

beforeAll(() => initAsync())

const ROOM = '!dm:test'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

function message(id: string, content: Record<string, unknown>, ts = 1) {
  return { type: 'm.room.message', event_id: id, sender: '@b:test', origin_server_ts: ts, room_id: ROOM, content }
}

function encryptedEvent(id: string, ts = 1) {
  return {
    type: 'm.room.encrypted',
    event_id: id,
    sender: '@b:test',
    origin_server_ts: ts,
    room_id: ROOM,
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x', session_id: 's', sender_key: 'k' }
  }
}

/** A homeserver answering /messages from a list of pages, and a device that "decrypts" by table. */
function server(
  pages: Array<{ chunk: unknown[]; end?: string }>,
  clear: Record<string, Record<string, unknown> | null> = {}
) {
  const requests: Array<Record<string, string>> = []

  const authedRequest = vi.fn(async (_method: string, _path: string, query: Record<string, string>) => {
    requests.push(query)

    return pages[requests.length - 1] ?? { chunk: [] }
  })

  const decryptEventIfNeeded = vi.fn(async (event: MatrixEvent) => {
    const content = clear[event.getId()!]

    if (content === null) {
      // What the SDK leaves on an event it has no keys for.
      ;(
        event as unknown as { setClearDataForDecryptionFailure(reason: string): void }
      ).setClearDataForDecryptionFailure('no key')
      ;(event as unknown as { _decryptionFailureReason: string })._decryptionFailureReason =
        'MEGOLM_UNKNOWN_INBOUND_SESSION_ID'
    } else if (content) {
      ;(event as unknown as { setClearData(result: unknown): void }).setClearData({
        clearEvent: { type: 'm.room.message', content }
      })
    }
  })

  return { client: { http: { authedRequest }, decryptEventIfNeeded } as never, requests, authedRequest }
}

describe('what a room without encryption has shared: the server filters', () => {
  it('asks /messages for messages with a URL, newest first, and stops once it has enough', async () => {
    const { client, requests } = server([
      {
        chunk: [
          message('$img', { msgtype: 'm.image', body: 'a.jpg', url: 'mxc://s/a' }, 3),
          message('$doc', { msgtype: 'm.file', body: 'b.pdf', url: 'mxc://s/b' }, 2)
        ],
        end: 'page2'
      },
      { chunk: [message('$old', { msgtype: 'm.image', body: 'c.png', url: 'mxc://s/c' })] }
    ])

    const page = await readMatrixRoomShared(client, { roomId: ROOM, section: 'media', limit: 1, encrypted: false })

    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]!.filter!)).toMatchObject({ types: ['m.room.message'], contains_url: true })
    expect(requests[0]).toMatchObject({ dir: 'b', limit: '50' })
    expect(page).toMatchObject({ section: 'media', source: 'server', next: 'page2', unreadable: 0 })
    expect(page.items.map(item => item.eventId)).toEqual(['$img'])
  })

  it('continues from `from`, crosses a bounded number of pages, and ends at the room start', async () => {
    const { client, requests } = server([
      { chunk: [message('$t1', { msgtype: 'm.text', body: 'hi' })], end: 'p2' },
      { chunk: [message('$t2', { msgtype: 'm.text', body: 'see https://atum.chat' })] }
    ])

    const page = await readMatrixRoomShared(client, {
      roomId: ROOM,
      section: 'links',
      limit: 3,
      from: 'p1',
      encrypted: false
    })

    expect(requests.map(query => query.from)).toEqual(['p1', 'p2'])
    expect(JSON.parse(requests[0]!.filter!)).toMatchObject({ contains_url: false })
    expect(page.items.map(item => item.url)).toEqual(['https://atum.chat'])
    expect(page).not.toHaveProperty('next')
  })

  it('never reads more than four pages in one call', async () => {
    const pages = Array.from({ length: 9 }, (_, index) => ({
      chunk: [message(`$t${index}`, { msgtype: 'm.text', body: 'no links' })],
      end: `p${index + 1}`
    }))

    const { client, requests } = server(pages)

    const page = await readMatrixRoomShared(client, { roomId: ROOM, section: 'links', limit: 5, encrypted: false })

    expect(requests).toHaveLength(4)
    expect(page.next).toBe('p4')
  })

  it('keeps reading past filtered pages that came back empty but still carry `end`', async () => {
    const { client, requests } = server([
      { chunk: [], end: 'p2' },
      { chunk: [], end: 'p3' },
      { chunk: [message('$img', { msgtype: 'm.image', body: 'a.jpg', url: 'mxc://s/a' })], end: 'p4' }
    ])

    const page = await readMatrixRoomShared(client, { roomId: ROOM, section: 'media', limit: 1, encrypted: false })

    expect(requests.map(query => query.from)).toEqual([undefined, 'p2', 'p3'])
    expect(page.items.map(item => item.eventId)).toEqual(['$img'])
    expect(page.next).toBe('p4')
  })

  it('hands back `next` after four empty pages, and ends only when `end` is missing or does not move', async () => {
    const empty = await readMatrixRoomShared(
      server(Array.from({ length: 9 }, (_, index) => ({ chunk: [], end: `p${index + 1}` }))).client,
      { roomId: ROOM, section: 'files', limit: 3, encrypted: false }
    )

    expect(empty).toMatchObject({ items: [], next: 'p4' })

    const stuck = server([
      { chunk: [], end: 'same' },
      { chunk: [], end: 'same' }
    ])

    const page = await readMatrixRoomShared(stuck.client, {
      roomId: ROOM,
      section: 'files',
      limit: 3,
      from: 'same',
      encrypted: false
    })

    expect(stuck.requests).toHaveLength(1)
    expect(page).not.toHaveProperty('next')
  })
})

describe('what an encrypted room has shared: this device decrypts', () => {
  it('pages the ciphertext stream, decrypts each event and counts what it cannot read', async () => {
    const { client, requests } = server(
      [
        {
          chunk: [
            encryptedEvent('$photo', 3),
            encryptedEvent('$lost', 2),
            // A plaintext event injected into an encrypted room is never listed (no downgrade).
            message('$injected', { msgtype: 'm.image', body: 'x.jpg', url: 'mxc://s/x' }, 1)
          ]
        }
      ],
      {
        $photo: { msgtype: 'm.image', body: 'p.jpg', file: { url: 'mxc://s/p', v: 'v2' } },
        $lost: null
      }
    )

    const page = await readMatrixRoomShared(client, { roomId: ROOM, section: 'media', limit: 6, encrypted: true })

    expect(JSON.parse(requests[0]!.filter!)).toEqual({ types: ['m.room.encrypted'], lazy_load_members: true })
    expect(page.source).toBe('device')
    expect(page.items.map(item => item.eventId)).toEqual(['$photo'])
    expect(page.unreadable).toBe(1)
  })

  it('stops when the account changes mid-read', async () => {
    const { client } = server([{ chunk: [encryptedEvent('$a')] }])

    await expect(
      readMatrixRoomShared(client, { roomId: ROOM, section: 'files', limit: 3, encrypted: true }, () => false)
    ).rejects.toThrow('matrix_room_shared_unavailable')
  })
})

describe('a shared photo’s picture', () => {
  it('asks a plain room’s server for a scaled thumbnail', async () => {
    const authedRequest = vi.fn(async () => new Blob([JPEG]))
    const client = { http: { authedRequest } } as never

    await expect(
      readMatrixRoomSharedThumbnail(client, { msgtype: 'm.image', body: 'a.jpg', url: 'mxc://s/a' }, true)
    ).resolves.toMatch(/^data:image\/jpeg;base64,/u)
    expect(authedRequest).toHaveBeenCalledWith(
      'GET',
      '/media/thumbnail/s/a',
      expect.objectContaining({ width: '320', method: 'scale' }),
      undefined,
      expect.objectContaining({ prefix: '/_matrix/client/v1' })
    )
  })

  it('decrypts an encrypted photo’s own thumbnail, and refuses a plain URL in an encrypted room', async () => {
    const encrypted = Attachment.encrypt(JPEG)
    const thumbnail = { ...JSON.parse(encrypted.mediaEncryptionInfo!), url: 'mxc://s/thumb' }
    const ciphertext = new Uint8Array(encrypted.encryptedData)
    encrypted.free()
    const authedRequest = vi.fn(async () => new Blob([ciphertext]))
    const client = { http: { authedRequest } } as never

    await expect(
      readMatrixRoomSharedThumbnail(
        client,
        { msgtype: 'm.image', body: 'a.jpg', file: { url: 'mxc://s/full' }, info: { thumbnail_file: thumbnail } },
        false
      )
    ).resolves.toBe(`data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}`)
    expect(authedRequest).toHaveBeenCalledWith(
      'GET',
      '/media/download/s/thumb',
      undefined,
      undefined,
      expect.anything()
    )
    await expect(
      readMatrixRoomSharedThumbnail(client, { msgtype: 'm.image', body: 'a.jpg', url: 'mxc://s/a' }, false)
    ).resolves.toBeNull()
  })
})
