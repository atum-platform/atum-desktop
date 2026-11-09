/**
 * The minimal TUS client (`tus.ts`) against the fake object store (`stub-storage.fixture.ts`), which holds Supabase
 * Storage's rules: a signed upload token for one object path, every chunk but the last exactly the chunk size, offsets that
 * must match, and no credential of the Mac's. The wire itself (what Node's fetch really sends) is `archive-http.test.ts`.
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { STORAGE_BUCKET, StubStorage, TUS_CHUNK_BYTES } from './stub-storage.fixture'
import { encodeTusMetadata, trustedTusUrl, TUS_VERSION, tusUpload } from './tus'
import { scratchDirectory } from './world.fixture'

const ORIGIN = 'https://storage.test'
const ENDPOINT = `${ORIGIN}/storage/v1/upload/resumable`
const PATH = 'agent-home/v2.1/o/a/h/generations/2/c.x.sealed'

function rig(options: { chunk?: number } = {}) {
  const clock = { now: 1_800_000_000_000 }
  const storage = new StubStorage({ origin: () => ORIGIN, now: () => clock.now })
  const chunk = options.chunk ?? 1024
  storage.chunkBytes = chunk
  const token = storage.mintUploadToken(PATH)
  const dir = scratchDirectory('atum-tus-')
  const controller = new AbortController()
  const waits: number[] = []

  const fetcher: typeof fetch = async (input, init) => storage.handle(new Request(input as string, init))

  const file = (bytes: Buffer, name = 'sealed') => {
    writeFileSync(path.join(dir, name), bytes)

    return path.join(dir, name)
  }

  const upload = (bytes: Buffer, overrides: Partial<Parameters<typeof tusUpload>[0]> = {}, extra: Parameters<typeof tusUpload>[1] = {}) =>
    tusUpload(
      {
        endpoint: ENDPOINT,
        headers: { 'x-signature': token, 'x-upsert': 'false' },
        metadata: { bucketName: STORAGE_BUCKET, objectName: PATH, contentType: 'application/octet-stream', cacheControl: '3600' },
        file: file(bytes),
        size: bytes.length,
        chunkBytes: chunk,
        deadline: clock.now + 87_000,
        signal: controller.signal,
        ...overrides
      },
      {
        fetch: fetcher,
        now: () => clock.now,
        sleep: async ms => {
          waits.push(ms)
          clock.now += ms
        },
        ...extra
      }
    )

  return { clock, storage, token, controller, waits, upload, fetcher }
}

const methods = (storage: StubStorage) => storage.log.map(entry => entry.method)

describe('putting a file in the store, a chunk at a time', () => {
  it('sends chunks of exactly the size the store insists on, the last shorter, and the store ends up holding the file', async () => {
    const { storage, upload } = rig()
    const bytes = randomBytes(5 * 1024 + 100)

    expect(await upload(bytes)).toEqual({ ok: true, chunks: 6, requests: 7 })

    expect(storage.objects.get(PATH)?.equals(bytes)).toBe(true)
    expect(methods(storage)).toEqual(['POST', 'PATCH', 'PATCH', 'PATCH', 'PATCH', 'PATCH', 'PATCH'])
    expect(storage.log.filter(entry => entry.method === 'PATCH').map(entry => entry.bytes)).toEqual([1024, 1024, 1024, 1024, 1024, 100])
  })

  it('uses the real 6 MiB chunk size of the store: two whole chunks and a remainder', async () => {
    const { storage, upload } = rig({ chunk: TUS_CHUNK_BYTES })
    const bytes = randomBytes(2 * TUS_CHUNK_BYTES + 12_345)

    expect(await upload(bytes, { chunkBytes: TUS_CHUNK_BYTES })).toMatchObject({ ok: true, chunks: 3 })
    expect(storage.objects.get(PATH)?.equals(bytes)).toBe(true)
    expect(storage.log.filter(entry => entry.method === 'PATCH').map(entry => entry.bytes)).toEqual([TUS_CHUNK_BYTES, TUS_CHUNK_BYTES, 12_345])
  })

  it('takes a file that is a whole number of chunks, and a file of one byte', async () => {
    const whole = rig()
    const bytes = randomBytes(3 * 1024)

    expect(await whole.upload(bytes)).toMatchObject({ ok: true, chunks: 3 })
    expect(whole.storage.objects.get(PATH)?.equals(bytes)).toBe(true)

    const one = rig()
    expect(await one.upload(Buffer.from('x'))).toMatchObject({ ok: true, chunks: 1 })
    expect(one.storage.objects.get(PATH)?.toString()).toBe('x')
  })

  it('names the object for the store, and sends the Shell\'s two headers and the protocol\'s own on every request, and nothing else', async () => {
    const { storage, upload, token } = rig()
    await upload(randomBytes(2_500))

    for (const entry of storage.log) {
      expect(entry.headers['x-signature']).toBe(token)
      expect(entry.headers['x-upsert']).toBe('false')
      expect(entry.headers['tus-resumable']).toBe(TUS_VERSION)
      expect(entry.headers.authorization).toBeUndefined()
      expect(entry.headers.cookie).toBeUndefined()
    }

    const create = storage.log[0]!
    expect(create.headers['upload-length']).toBe('2500')

    const decoded = Object.fromEntries(
      create.headers['upload-metadata']!.split(',').map(pair => {
        const [key, value] = pair.split(' ')

        return [key, Buffer.from(value!, 'base64').toString('utf8')]
      })
    )

    expect(decoded).toEqual({ bucketName: STORAGE_BUCKET, objectName: PATH, contentType: 'application/octet-stream', cacheControl: '3600' })

    for (const patch of storage.log.filter(entry => entry.method === 'PATCH')) {
      expect(patch.headers['content-type']).toBe('application/offset+octet-stream')
    }

    expect(storage.leaked).toEqual([])
  })
})

describe('a store that does not take a chunk, or does not say so', () => {
  it('asks the store where it is after a dropped connection, and carries on from there', async () => {
    const { storage, upload } = rig()
    storage.patchFaults.push('drop')
    const bytes = randomBytes(3 * 1024 + 7)

    expect(await upload(bytes)).toMatchObject({ ok: true })
    expect(storage.objects.get(PATH)?.equals(bytes)).toBe(true)
    // A HEAD between the failure and the second try, and no chunk sent twice into the object.
    expect(methods(storage)).toContain('HEAD')
    expect(storage.log.filter(entry => entry.method === 'PATCH' && entry.status === 204)).toHaveLength(4)
  })

  it('does not send again a chunk the store took but never acknowledged', async () => {
    const { storage, upload } = rig()
    storage.patchFaults.push('drop-after-store')
    const bytes = randomBytes(2 * 1024 + 7)

    expect(await upload(bytes)).toMatchObject({ ok: true })
    // The first chunk landed and its answer died: the HEAD said so, so exactly one PATCH carried each part of the file.
    expect(storage.objects.get(PATH)?.equals(bytes)).toBe(true)
    expect(storage.log.filter(entry => entry.method === 'PATCH' && entry.status === 204).map(entry => entry.bytes)).toEqual([1024, 7])
  })

  it('continues from where a half-taken chunk stopped', async () => {
    const { storage, upload } = rig()
    storage.patchFaults.push({ stored: 300, status: 503 })
    const bytes = randomBytes(2 * 1024)

    expect(await upload(bytes)).toMatchObject({ ok: true })
    expect(storage.objects.get(PATH)?.equals(bytes)).toBe(true)
  })

  it('tries a chunk again after a server error, waiting the delays it was given between the tries', async () => {
    const { storage, upload, waits } = rig()
    storage.patchFaults.push(503, 503)

    expect(await upload(randomBytes(900), {}, { retryDelaysMs: [0, 250, 750] })).toMatchObject({ ok: true })
    expect(waits).toEqual([250, 750])
  })

  it('gives up on a chunk the store keeps failing, as unavailable, and not as refused', async () => {
    const { storage, upload } = rig()
    storage.patchFaults.push(503, 503, 503, 503)

    expect(await upload(randomBytes(900))).toEqual({ ok: false, kind: 'unavailable' })
    expect(storage.objects.has(PATH)).toBe(false)
  })

  it('is told, by name, when the store is down at the start, and does not try the chunks', async () => {
    const { storage, upload } = rig()
    storage.down = true

    expect(await upload(randomBytes(900))).toEqual({ ok: false, kind: 'unavailable', status: 503 })
    expect(methods(storage)).toEqual(['POST'])
  })
})

describe('what the store refuses', () => {
  it('refuses, for good, a token it did not mint or that has ended', async () => {
    const wrong = rig()
    expect(await wrong.upload(randomBytes(100), { headers: { 'x-signature': 'up.not-minted', 'x-upsert': 'false' } })).toEqual({ ok: false, kind: 'refused', status: 401 })

    const ended = rig()
    ended.clock.now += 3 * 60 * 60_000
    expect(await ended.upload(randomBytes(100), { deadline: ended.clock.now + 87_000 })).toEqual({ ok: false, kind: 'refused', status: 401 })
  })

  it('refuses an object the token was not minted for', async () => {
    const { upload } = rig()

    expect(await upload(randomBytes(100), { metadata: { bucketName: STORAGE_BUCKET, objectName: 'agent-home/v2.1/elsewhere.sealed', contentType: 'application/octet-stream' } })).toEqual({
      ok: false,
      kind: 'refused',
      status: 403
    })
  })

  it('says "too large" when the store has an object limit below the file, and uploads nothing', async () => {
    const { storage, upload } = rig()
    storage.maxObjectBytes = 500

    expect(await upload(randomBytes(900))).toEqual({ ok: false, kind: 'too_large', status: 413 })
    expect(methods(storage)).toEqual(['POST'])
  })

  it('refuses a request without the credential, and the protocol version it does not speak', async () => {
    const { upload, fetcher } = rig()

    expect(await upload(randomBytes(100), { headers: {} })).toMatchObject({ ok: false, kind: 'refused' })

    // A different protocol version is the store's to refuse; the client always sends 1.0.0.
    const response = await fetcher(ENDPOINT, { method: 'POST', headers: { 'tus-resumable': '0.2.2', 'upload-length': '5' } })
    expect(response.status).toBe(412)
  })
})

describe('time, and the caller', () => {
  it('starts nothing once the attempt\'s deadline has passed', async () => {
    const { clock, storage, upload } = rig()

    expect(await upload(randomBytes(100), { deadline: clock.now })).toEqual({ ok: false, kind: 'expired' })
    expect(storage.log).toEqual([])
  })

  it('stops between chunks when the deadline passes, however far it had got', async () => {
    const { clock, storage, upload } = rig()
    // The store is slow to answer the first chunk's failure: the delay before the retry takes the clock past the deadline.
    storage.patchFaults.push(503)

    const result = await upload(randomBytes(3 * 1024), { deadline: clock.now + 1_000 }, { retryDelaysMs: [0, 5_000, 5_000] })

    expect(result).toEqual({ ok: false, kind: 'expired' })
    expect(storage.objects.has(PATH)).toBe(false)
  })

  it('stops when the caller stops it, before a request and during one', async () => {
    const before = rig()
    before.controller.abort()
    expect(await before.upload(randomBytes(100))).toEqual({ ok: false, kind: 'aborted' })
    expect(before.storage.log).toEqual([])

    const during = rig()

    const result = await during.upload(randomBytes(3 * 1024), {}, {
      fetch: async (input, init) => {
        const request = new Request(input as string, init)

        if (request.method === 'PATCH') {
          during.controller.abort()
          throw new TypeError('fetch failed')
        }

        return during.storage.handle(request)
      }
    })

    expect(result).toEqual({ ok: false, kind: 'aborted' })
  })

  it('says the file is not what it was declared to be when it is shorter than that', async () => {
    const { storage, upload } = rig()

    expect(await upload(randomBytes(500), { size: 900 })).toEqual({ ok: false, kind: 'corrupt' })
    expect(storage.objects.has(PATH)).toBe(false)
  })
})

describe('where the credential may go', () => {
  it('goes to https, or to http on this machine, and nowhere else', () => {
    for (const good of [ENDPOINT, 'https://abc.storage.supabase.co/storage/v1/upload/resumable', 'http://127.0.0.1:8080/x', 'http://localhost:1/x', 'http://[::1]:2/x']) {
      expect(trustedTusUrl(good), good).not.toBeNull()
    }

    for (const bad of [
      'http://storage.test/storage/v1/upload/resumable',
      'http://10.0.0.5/x',
      'ftp://storage.test/x',
      'https://user:pass@storage.test/x',
      'https://storage.test/x#fragment',
      'storage.test/x',
      '',
      'javascript:alert(1)'
    ]) {
      expect(trustedTusUrl(bad), bad).toBeNull()
    }
  })

  it('does not upload to an endpoint it would not send a credential to', async () => {
    const { storage, upload } = rig()

    expect(await upload(randomBytes(100), { endpoint: 'http://storage.test/storage/v1/upload/resumable' })).toEqual({ ok: false, kind: 'refused' })
    expect(storage.log).toEqual([])
  })

  it('does not follow a Location on another origin, and never sends the token there', async () => {
    const { storage, upload, token } = rig()
    const seen: string[] = []

    const result = await upload(randomBytes(100), {}, {
      fetch: async (input, init) => {
        const request = new Request(input as string, init)
        seen.push(`${request.method} ${request.url}`)

        // The store's creation answer points at somebody else's host.
        return request.method === 'POST'
          ? new Response(null, { status: 201, headers: { location: 'https://elsewhere.test/upload/1' } })
          : storage.handle(request)
      }
    })

    expect(result).toEqual({ ok: false, kind: 'refused' })
    expect(seen).toEqual([`POST ${ENDPOINT}`])
    expect(token).toBeTruthy()
  })

  it('follows a relative Location on its own origin', async () => {
    const { storage, upload } = rig()
    let path = ''

    const result = await upload(randomBytes(100), {}, {
      fetch: async (input, init) => {
        const request = new Request(input as string, init)
        const response = await storage.handle(request)

        if (request.method === 'POST') {
          path = new URL(response.headers.get('location')!).pathname

          return new Response(null, { status: 201, headers: { location: path } })
        }

        return response
      }
    })

    expect(result).toMatchObject({ ok: true })
    expect(path).toMatch(/^\/storage\/v1\/upload\/resumable\/.+/u)
  })
})

describe('the metadata header', () => {
  it('is key and base64 value pairs, comma separated, with the value in UTF-8', () => {
    expect(encodeTusMetadata({ a: 'b', objectName: 'thư mục/ký.sealed' })).toBe(`a ${Buffer.from('b').toString('base64')},objectName ${Buffer.from('thư mục/ký.sealed', 'utf8').toString('base64')}`)
  })
})
