/**
 * The archive and key client over real HTTP. The fake Shell and the fake object store (the same objects the in-memory
 * tests call directly, which hold the platform's own request rules of atum-platform PR #664: `matrix-agent-home.ts`,
 * `agent-home-archive.ts` and Supabase Storage's TUS endpoint) are each put behind a loopback socket, and the client
 * talks to them with Node's own `fetch`.
 *
 * What only a real socket shows is what actually leaves the machine: the exact `Content-Length` of a chunk (a streamed body
 * would go chunked), which headers travel to which host, whether a redirect is followed with the upload credential, and
 * how a body that is longer or shorter than it was said to be is read.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { type ServedFetch, serveFetch } from './http-fetch.fixture'
import { shellArchive } from './node.fixture'
import { STORAGE_BUCKET, TUS_CHUNK_BYTES } from './stub-storage.fixture'
import { commitGeneration, createWorld, reserveGeneration, scratchDirectory, signal } from './world.fixture'

const MANIFEST = 'b'.repeat(64)
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const servers: ServedFetch[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

async function serve(handler: (request: Request) => Promise<Response>) {
  const server = await serveFetch(handler)
  servers.push(server)

  return server
}

/** The fake Shell and the fake object store each behind a real socket, the home Mac's stores talking to them, and a reserved generation. */
async function wire() {
  const w = await createWorld()
  const shell = await serve(request => w.stub.fetch(request))
  const storage = await serve(w.stub.storage.handle)

  w.stub.storageOrigin = storage.origin

  const generation = await reserveGeneration(w)
  const mac = shellArchive(w, w.a, { overHttp: shell.origin })
  const dir = scratchDirectory('atum-archive-http-')
  const target = { agent: w.agent, ...generation }

  const file = (name: string, content: Uint8Array | string) => {
    writeFileSync(path.join(dir, name), content)

    return path.join(dir, name)
  }

  const into = (name: string) => ({ agent: w.agent, homeId: target.homeId, generation: target.generation, file: path.join(dir, name) })

  return { w, shell, storage, mac, dir, target, file, into }
}

describe('the archive client, over real HTTP', () => {
  it('sends each chunk with the exact length of the chunk, not chunked, to the store alone, and nothing but the Shell’s credential', async () => {
    const h = await wire()
    const bytes = randomBytes(TUS_CHUNK_BYTES + 17)

    expect(await h.mac.store.put({ ...h.target, file: h.file('sealed', bytes) }, signal())).toEqual({ ok: true, value: { bytes: bytes.length, sha256: sha(bytes) } })

    const patches = h.storage.seen.filter(each => each.method === 'PATCH')

    expect(h.storage.seen.map(each => each.method)).toEqual(['POST', 'PATCH', 'PATCH'])
    expect(patches.map(each => each.bytes)).toEqual([TUS_CHUNK_BYTES, 17])
    expect(patches.map(each => each.headers['content-length'])).toEqual([String(TUS_CHUNK_BYTES), '17'])
    expect(patches.map(each => each.headers['upload-offset'])).toEqual(['0', String(TUS_CHUNK_BYTES)])

    for (const request of h.storage.seen) {
      expect(request.headers['transfer-encoding'], request.method).toBeUndefined()
      expect(request.headers['tus-resumable'], request.method).toBe('1.0.0')
      expect(request.headers['x-signature'], request.method).toMatch(/^up[.]/u)
      expect(request.headers['x-upsert'], request.method).toBe('false')
      expect(request.headers.authorization, request.method).toBeUndefined()
      expect(request.headers.cookie, request.method).toBeUndefined()
    }

    expect(patches.every(each => each.headers['content-type'] === 'application/offset+octet-stream')).toBe(true)
    expect(h.w.stub.storage.leaked).toEqual([])
    expect([...h.w.stub.storage.objects.values()][0]!.equals(bytes)).toBe(true)
  })

  it('calls the Shell with a JSON POST, the bearer and the wire version, and no cookie, and sends the archive nowhere near it', async () => {
    const h = await wire()
    const bytes = randomBytes(200_000)

    await h.mac.store.put({ ...h.target, file: h.file('sealed', bytes) }, signal())
    await h.mac.keys.key({ agent: h.w.agent, homeId: h.target.homeId }, signal())

    const route = `/api/matrix/v1/agents/${h.w.agent}/home`

    expect(h.shell.seen.map(each => [each.method, each.url])).toEqual([
      ['POST', `${route}/checkpoints/2/archive`],
      ['POST', `${route}/checkpoints/2/archive`],
      ['POST', `${route}/key`]
    ])

    for (const request of h.shell.seen) {
      expect(request.headers.authorization).toBe(`Bearer ${h.w.stub.token}`)
      expect(request.headers['atum-agent-home-wire']).toBe('2.1')
      expect(request.headers['content-type']).toBe('application/json')
      expect(request.headers.cookie).toBeUndefined()
      // A signed call: the envelope and the fence, a few hundred bytes. The archive's bytes are not in it.
      expect(request.bytes).toBeLessThan(4096)
    }
  })

  it('asks the store again where it is after a connection that died in the middle of a chunk, and the file arrives whole', async () => {
    const h = await wire()
    const bytes = randomBytes(300_000)

    h.w.stub.storage.patchFaults.push('drop')

    expect(await h.mac.store.put({ ...h.target, file: h.file('sealed', bytes) }, signal())).toEqual({ ok: true, value: { bytes: bytes.length, sha256: sha(bytes) } })
    expect(h.storage.seen.some(each => each.method === 'HEAD')).toBe(true)
    expect([...h.w.stub.storage.objects.values()][0]!.equals(bytes)).toBe(true)
    expect(h.w.stub.storage.created).toBe(1)
  })

  it('streams a committed object back through its signed link alone, and keeps it whole', async () => {
    const h = await wire()
    const bytes = randomBytes(3 * 1024 * 1024 + 17)

    expect(await h.mac.store.put({ ...h.target, file: h.file('sealed', bytes) }, signal())).toMatchObject({ ok: true })
    await commitGeneration(h.w, h.target, MANIFEST)

    expect(await h.mac.store.get(h.into('got'), signal())).toEqual({ ok: true, value: { bytes: bytes.length, sha256: sha(bytes), manifestSha256: MANIFEST } })
    expect(readFileSync(path.join(h.dir, 'got')).equals(bytes)).toBe(true)

    const download = h.storage.seen.at(-1)!

    expect(download.method).toBe('GET')
    expect(download.url.startsWith(`/storage/v1/object/sign/${STORAGE_BUCKET}/agent-home/v2.1/`)).toBe(true)
    expect(download.url).toMatch(/[.]sealed[?]token=dl[.]/u)
    expect(download.headers.authorization).toBeUndefined()
    expect(download.headers.cookie).toBeUndefined()
  })

  it('says a platform that has not shipped the routes has no such routes, in all three calls', async () => {
    const h = await wire()

    h.w.stub.archiveRoutes = false

    expect(await h.mac.store.put({ ...h.target, file: h.file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(await h.mac.store.get(h.into('got'), signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(await h.mac.keys.key({ agent: h.w.agent, homeId: h.target.homeId }, signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(h.storage.seen).toEqual([])
  })
})

describe('an object store that is not what the Shell said, over real HTTP', () => {
  it('follows no redirect with the upload credential, and a bystander is never asked', async () => {
    const h = await wire()
    const bystander = await serve(async () => new Response('loot', { status: 200 }))
    const redirector = await serve(async () => new Response(null, { status: 307, headers: { location: `${bystander.origin}/storage/v1/upload/resumable` } }))

    // The Shell’s answer is altered to point the upload at a host that redirects (it is that host's word, not the Shell's).
    h.w.stub.alterAnswer = {
      action: 'CheckpointArchiveBegin',
      times: 3,
      change: body => ({ ...body, upload: { ...(body.upload as Record<string, unknown>), endpoint: `${redirector.origin}/storage/v1/upload/resumable` } })
    }

    expect(await h.mac.store.put({ ...h.target, file: h.file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unavailable' })
    expect(redirector.seen.length).toBeGreaterThan(0)
    expect(bystander.seen).toEqual([])
  })

  it('follows no redirect on a download either', async () => {
    const h = await wire()
    const bytes = randomBytes(10_000)

    await h.mac.store.put({ ...h.target, file: h.file('sealed', bytes) }, signal())
    await commitGeneration(h.w, h.target, MANIFEST)

    const bystander = await serve(async () => new Response(bytes, { status: 200 }))
    const redirector = await serve(async () => new Response(null, { status: 302, headers: { location: `${bystander.origin}/object` } }))

    h.w.stub.alterAnswer = { action: 'CheckpointArchiveDownload', change: body => ({ ...body, url: `${redirector.origin}/object?token=dl.x` }) }

    expect(await h.mac.store.get(h.into('got'), signal())).toEqual({ ok: false, kind: 'unavailable' })
    expect(bystander.seen).toEqual([])
    expect(existsSync(path.join(h.dir, 'got'))).toBe(false)
  })

  it('stops reading a body that runs past the length the platform declared, and keeps none of it', async () => {
    const h = await wire()
    const bytes = randomBytes(10_000)

    await h.mac.store.put({ ...h.target, file: h.file('sealed', bytes) }, signal())
    await commitGeneration(h.w, h.target, MANIFEST)

    // No Content-Length is sent, so only the count the Shell declared can say when to stop.
    const longer = await serve(async () => new Response(Buffer.concat([bytes, randomBytes(5000)])))

    h.w.stub.alterAnswer = { action: 'CheckpointArchiveDownload', change: body => ({ ...body, url: `${longer.origin}/object?token=dl.x` }) }

    expect(await h.mac.store.get(h.into('got'), signal())).toEqual({ ok: false, kind: 'corrupt' })
    expect(existsSync(path.join(h.dir, 'got'))).toBe(false)
  })

  it('does not keep a body that ends short of the length the platform declared', async () => {
    const h = await wire()
    const bytes = randomBytes(10_000)

    await h.mac.store.put({ ...h.target, file: h.file('sealed', bytes) }, signal())
    await commitGeneration(h.w, h.target, MANIFEST)

    const shorter = await serve(async () => new Response(bytes.subarray(0, 9_000)))

    h.w.stub.alterAnswer = { action: 'CheckpointArchiveDownload', change: body => ({ ...body, url: `${shorter.origin}/object?token=dl.x` }) }

    expect(await h.mac.store.get(h.into('got'), signal())).toEqual({ ok: false, kind: 'corrupt' })
    expect(existsSync(path.join(h.dir, 'got'))).toBe(false)
  })

  it('does not read an answer of the Shell’s to the end when it is far longer than any of its answers is', async () => {
    const w = await createWorld()
    const generation = await reserveGeneration(w)
    const flood = await serve(async () => new Response(JSON.stringify({ padding: 'x'.repeat(300_000) }), { headers: { 'content-type': 'application/json' } }))
    const mac = shellArchive(w, w.a, { overHttp: flood.origin })
    const dir = scratchDirectory('atum-archive-http-')

    writeFileSync(path.join(dir, 'sealed'), 'sealed bytes')

    expect(await mac.store.put({ agent: w.agent, ...generation, file: path.join(dir, 'sealed') }, signal())).toEqual({ ok: false, kind: 'unavailable' })
    expect(await mac.keys.key({ agent: w.agent, homeId: generation.homeId }, signal())).toEqual({ ok: false, kind: 'unavailable' })
  })
})
