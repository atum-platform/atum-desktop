// @vitest-environment node
import { Attachment, initAsync } from '@matrix-org/matrix-sdk-crypto-wasm'
import type { MatrixClient } from 'matrix-js-sdk'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { MATRIX_MAX_FILE_BYTES } from '../../shared/matrix'
import { MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES } from '../../shared/matrix-room-shared'

import { boundedMatrixFetch, downloadMatrixAttachment } from './media'

beforeAll(() => initAsync())

describe('one download path for an encrypted file and, in a room without encryption, a plain one', () => {
  const bytes = new TextEncoder().encode('Atum file fixture')

  function server(body: Uint8Array<ArrayBuffer>) {
    const request = vi.fn(async () => new Blob([body]))

    return { client: { http: { authedRequest: request } } as unknown as MatrixClient, request }
  }

  it('takes a plain file as downloaded when the caller says it came from a room without encryption', async () => {
    const { client, request } = server(bytes)
    const content = { msgtype: 'm.file', body: 'ghi-chu.txt', url: 'mxc://test/plain-id' }

    await expect(downloadMatrixAttachment(client, content, { plain: true })).resolves.toEqual({
      name: 'ghi-chu.txt',
      bytes
    })
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/media/download/test/plain-id',
      undefined,
      undefined,
      expect.objectContaining({ prefix: '/_matrix/client/v1', rawResponseBody: true })
    )
  })

  it('downloads an m.image the way it does an m.file, and still refuses video', async () => {
    const { client, request } = server(bytes)

    await expect(
      downloadMatrixAttachment(
        client,
        { msgtype: 'm.image', body: 'IMG_1.jpg', url: 'mxc://test/plain-id' },
        { plain: true }
      )
    ).resolves.toEqual({ name: 'IMG_1.jpg', bytes })

    await expect(
      downloadMatrixAttachment(
        client,
        { msgtype: 'm.video', body: 'clip.mp4', url: 'mxc://test/plain-id' },
        { plain: true }
      )
    ).rejects.toThrow('matrix_file_unavailable')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('never takes a plain URL otherwise, so an encrypted room keeps encrypted files only', async () => {
    const { client, request } = server(bytes)

    await expect(
      downloadMatrixAttachment(client, { msgtype: 'm.file', body: 'file', url: 'mxc://test/plain-id' })
    ).rejects.toThrow('matrix_file_unavailable')
    expect(request).not.toHaveBeenCalled()
  })

  it('still decrypts an encrypted file, in either kind of room', async () => {
    const encrypted = Attachment.encrypt(bytes)
    const file = { ...JSON.parse(encrypted.mediaEncryptionInfo!), url: 'mxc://test/encrypted-id' }
    const { client } = server(new Uint8Array(encrypted.encryptedData))
    encrypted.free()

    for (const plain of [false, true]) {
      await expect(
        downloadMatrixAttachment(client, { msgtype: 'm.file', body: 'secret.txt', file }, { plain })
      ).resolves.toEqual({ name: 'secret.txt', bytes })
    }
  })

  it('refuses a plain URL that is not the homeserver’s media, before any request', async () => {
    const { client, request } = server(bytes)

    await expect(
      downloadMatrixAttachment(
        client,
        { msgtype: 'm.file', body: 'file', url: 'https://elsewhere.test/x' },
        { plain: true }
      )
    ).rejects.toThrow('matrix_file_unavailable')
    expect(request).not.toHaveBeenCalled()
  })

  it('bounds a plain download like an encrypted one', async () => {
    const { client } = server(new Uint8Array(MATRIX_MAX_FILE_BYTES + 1))

    await expect(
      downloadMatrixAttachment(client, { msgtype: 'm.file', body: 'big', url: 'mxc://test/big' }, { plain: true })
    ).rejects.toThrow('matrix_file_invalid')
  })
})

describe('SDK media fetch boundary', () => {
  const url = 'https://matrix.test/_matrix/client/v1/media/download/server/id'
  it('leaves long-poll sync deadlines with the SDK', async () => {
    const signal = new AbortController().signal
    const fetcher = vi.fn(async () => new Response('{}'))
    const sync = 'https://matrix.test/_matrix/client/v3/sync?timeout=30000'
    await boundedMatrixFetch(fetcher)(sync, { signal })
    expect(fetcher).toHaveBeenCalledWith(sync, { signal, redirect: 'error' })
  })
  it.each([
    '/user/%40alice%3Atest/account_data/m.ignored_user_list',
    '/rooms/!room%3Atest/ban',
    '/rooms/!room%3Atest/unban',
    '/rooms/!room%3Atest/report/%24event'
  ])('bounds explicit moderation requests without replacing SDK cancellation: %s', async path => {
    const abort = new AbortController()

    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).not.toBe(abort.signal)
      expect(init?.signal?.aborted).toBe(false)
      abort.abort()
      expect(init?.signal?.aborted).toBe(true)

      return new Response('{}')
    })

    const timeout = vi.spyOn(AbortSignal, 'timeout')

    try {
      await boundedMatrixFetch(fetcher)(`https://matrix.test/tenant/_matrix/client/v3${path}`, { signal: abort.signal })
      expect(timeout).toHaveBeenCalledWith(10000)
    } finally {
      timeout.mockRestore()
    }
  })
  it('keeps SDK-owned headers and refuses redirects while returning identical bounded bytes', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))

    const response = await boundedMatrixFetch(fetcher)(url, {
      headers: { Authorization: 'Bearer synthetic' },
      redirect: 'follow'
    })

    expect(fetcher).toHaveBeenCalledWith(url, {
      headers: { Authorization: 'Bearer synthetic' },
      redirect: 'error',
      signal: expect.any(AbortSignal)
    })
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
  it.each([url, 'https://matrix.test/tenant/_matrix/client/v1/media/download/server/id'])(
    'rejects an advertised oversized body without buffering it: %s',
    async mediaUrl => {
      const cancel = vi.fn()

      const fetcher = vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { 'content-length': String(MATRIX_MAX_FILE_BYTES + 1) }
          })
      )

      await expect(boundedMatrixFetch(fetcher)(mediaUrl)).rejects.toThrow('matrix_file_invalid')
      expect(cancel).toHaveBeenCalledTimes(1)
    }
  )
  it('caps streamed bytes even when Content-Length is absent or misleading', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MATRIX_MAX_FILE_BYTES))
              controller.enqueue(new Uint8Array(1))
              controller.close()
            }
          }),
          { headers: { 'content-length': '1' } }
        )
    )

    const response = await boundedMatrixFetch(fetcher)(url)
    await expect(response.blob()).rejects.toThrow('matrix_file_invalid')
  })
  describe('a thumbnail is held to the 8 MB thumbnail cap while it streams', () => {
    const thumbnailUrl =
      'https://matrix.test/tenant/_matrix/client/v1/media/thumbnail/server/id?width=320&height=320&method=scale'

    function streamed(sizes: number[], headers: Record<string, string> = {}) {
      const cancel = vi.fn()
      let sent = 0

      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const size = sizes[sent++]

          if (size === undefined) {
            controller.close()
          } else {
            controller.enqueue(new Uint8Array(size))
          }
        },
        cancel
      })

      return { fetcher: vi.fn(async () => new Response(body, { headers })), cancel, pulled: () => sent }
    }

    it('stops a body with no Content-Length as soon as it passes 8 MB, without reading the rest', async () => {
      const chunk = 1024 * 1024
      const { fetcher, cancel, pulled } = streamed(Array.from({ length: 20 }, () => chunk))

      const response = await boundedMatrixFetch(fetcher)(thumbnailUrl)

      expect(response.headers.get('content-length')).toBeNull()
      await expect(response.blob()).rejects.toThrow('matrix_file_invalid')
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(pulled()).toBeLessThanOrEqual(MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES / chunk + 2)
    })

    it('refuses an advertised oversized thumbnail before reading it', async () => {
      const { fetcher, cancel, pulled } = streamed([1], {
        'content-length': String(MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES + 1)
      })

      await expect(boundedMatrixFetch(fetcher)(thumbnailUrl)).rejects.toThrow('matrix_file_invalid')
      expect(cancel).toHaveBeenCalledTimes(1)
      // A stream may pre-pull one chunk on construction; nothing past that is read.
      expect(pulled()).toBeLessThanOrEqual(1)
    })

    it('passes a thumbnail of exactly 8 MB, and leaves downloads at the larger file cap', async () => {
      const exact = streamed([MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES])
      const thumbnail = await boundedMatrixFetch(exact.fetcher)(thumbnailUrl)
      expect((await thumbnail.arrayBuffer()).byteLength).toBe(MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES)

      const download = streamed([MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES, 1])
      const file = await boundedMatrixFetch(download.fetcher)(url)
      expect((await file.arrayBuffer()).byteLength).toBe(MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES + 1)
    })
  })
  it('preserves Matrix token errors for the maintained SDK refresh handler', async () => {
    const response = new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN' }), { status: 401 })
    expect(await boundedMatrixFetch(async () => response)(url)).toBe(response)
  })
})
