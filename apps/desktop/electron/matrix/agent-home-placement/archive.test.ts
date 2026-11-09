import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { agentHomeSealKeyId, newSealKey, openFile, SEAL_MAGIC, SealError, sealFile } from './archive-seal'
import { type ArchiveFailure, DirectoryArchiveStore, failureOf, FixedSealKeySource } from './archive-store'
import { shellArchive } from './node.fixture'
import { TUS_CHUNK_BYTES } from './stub-storage.fixture'
import { commitGeneration, createWorld, requestMove, reserveGeneration, scratchDirectory, signal, type World } from './world.fixture'

const scratch = () => scratchDirectory('atum-archive-')
const HOME = '00000000-0000-4000-8000-e8d95748107a'

async function sealed(plain: Buffer, generation = 2) {
  const dir = scratch()
  const key = newSealKey()
  writeFileSync(path.join(dir, 'plain'), plain)
  const result = await sealFile({ plain: path.join(dir, 'plain'), sealed: path.join(dir, 'sealed'), key, homeId: HOME, generation })

  return { dir, key, ...result, plainPath: path.join(dir, 'plain'), sealedPath: path.join(dir, 'sealed') }
}

describe('the seal on a checkpoint archive', () => {
  it('opens to exactly what was sealed, whatever its size', async () => {
    for (const size of [0, 1, 1000, 3 * 1024 * 1024 + 17]) {
      const plain = randomBytes(size)
      const s = await sealed(plain)

      expect(statSync(s.sealedPath).size).toBe(SEAL_MAGIC.length + 43 + 12 + size + 16)
      expect(s.bytes).toBe(statSync(s.sealedPath).size)
      expect(createHash('sha256').update(readFileSync(s.sealedPath)).digest('hex')).toBe(s.sha256)

      const out = path.join(s.dir, 'opened')
      await openFile({ sealed: s.sealedPath, plain: out, key: s.key, homeId: HOME, generation: 2 })
      expect(readFileSync(out).equals(plain)).toBe(true)
    }
  })

  it('writes a header the opener can read, a fresh nonce each time, and nothing of the plaintext', async () => {
    const plain = Buffer.from('lotus lotus lotus lotus lotus')
    const first = await sealed(plain)
    const second = await sealed(plain)
    const raw = readFileSync(first.sealedPath)

    expect(raw.subarray(0, SEAL_MAGIC.length).toString()).toBe(SEAL_MAGIC)
    expect(raw.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + 43).toString('ascii')).toBe(first.key.keyId)
    expect(raw.includes('lotus')).toBe(false)
    expect(readFileSync(second.sealedPath).subarray(SEAL_MAGIC.length + 43, SEAL_MAGIC.length + 55).equals(raw.subarray(SEAL_MAGIC.length + 43, SEAL_MAGIC.length + 55))).toBe(false)
  })

  it('does not open for another home, another generation, another key, or after any change', async () => {
    const s = await sealed(Buffer.from('the memory of an agent'))

    const open = (overrides: Partial<Parameters<typeof openFile>[0]> = {}) =>
      openFile({ sealed: s.sealedPath, plain: path.join(s.dir, `out-${randomUUID()}`), key: s.key, homeId: HOME, generation: 2, ...overrides })

    await expect(open({ generation: 3 })).rejects.toMatchObject({ code: 'seal_open_failed' })
    await expect(open({ homeId: '00000000-0000-4000-8000-bd7662a5eeb4' })).rejects.toMatchObject({ code: 'seal_open_failed' })
    await expect(open({ key: newSealKey() })).rejects.toMatchObject({ code: 'seal_key_mismatch' })
    await expect(open({ key: { keyId: s.key.keyId, key: randomBytes(32) } })).rejects.toMatchObject({ code: 'seal_open_failed' })

    const original = readFileSync(s.sealedPath)

    for (const [name, change] of [
      ['a ciphertext byte', (raw: Buffer) => { raw[SEAL_MAGIC.length + 43 + 12 + 2]! ^= 1 }],
      ['the tag', (raw: Buffer) => { raw[raw.length - 1]! ^= 1 }],
      ['the nonce', (raw: Buffer) => { raw[SEAL_MAGIC.length + 43 + 1]! ^= 1 }]
    ] as const) {
      const copy = Buffer.from(original)
      change(copy)
      writeFileSync(s.sealedPath, copy)
      await expect(open(), name).rejects.toMatchObject({ code: 'seal_open_failed' })
    }

    writeFileSync(s.sealedPath, Buffer.concat([original, Buffer.from('x')]))
    await expect(open()).rejects.toMatchObject({ code: 'seal_open_failed' })
    writeFileSync(s.sealedPath, original.subarray(0, original.length - 3))
    await expect(open()).rejects.toBeInstanceOf(SealError)
    writeFileSync(s.sealedPath, Buffer.concat([Buffer.from('NOT-A-SEAL\n'), original.subarray(11)]))
    await expect(open()).rejects.toMatchObject({ code: 'seal_format_invalid' })
    writeFileSync(s.sealedPath, original.subarray(0, 20))
    await expect(open()).rejects.toMatchObject({ code: 'seal_format_invalid' })
  })

  it('leaves no readable plaintext behind when it does not open', async () => {
    const s = await sealed(Buffer.from('secret memory'))
    const raw = readFileSync(s.sealedPath)
    raw[SEAL_MAGIC.length + 43 + 12]! ^= 1
    writeFileSync(s.sealedPath, raw)
    const out = path.join(s.dir, 'opened')

    await expect(openFile({ sealed: s.sealedPath, plain: out, key: s.key, homeId: HOME, generation: 2 })).rejects.toBeInstanceOf(SealError)
    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.part`)).toBe(false)
  })

  it('refuses a key that is not 32 bytes with a 43-character id, and never overwrites a sealed file', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'plain'), 'x')
    const sealedPath = path.join(dir, 'sealed')

    await expect(sealFile({ plain: path.join(dir, 'plain'), sealed: sealedPath, key: { keyId: 'short', key: randomBytes(32) }, homeId: HOME, generation: 2 })).rejects.toMatchObject({ code: 'seal_key_invalid' })
    await expect(sealFile({ plain: path.join(dir, 'plain'), sealed: sealedPath, key: { keyId: 'A'.repeat(43), key: randomBytes(16) }, homeId: HOME, generation: 2 })).rejects.toMatchObject({ code: 'seal_key_invalid' })

    writeFileSync(sealedPath, 'existing')
    await expect(sealFile({ plain: path.join(dir, 'plain'), sealed: sealedPath, key: newSealKey(), homeId: HOME, generation: 2 })).rejects.toThrow()
    expect(readFileSync(sealedPath, 'utf8')).toBe('existing')
  })
})

describe('a folder as the store', () => {
  it('puts, gets and replaces a reserved generation, and says when there is nothing', async () => {
    const store = new DirectoryArchiveStore(path.join(scratch(), 'archives'))
    const dir = scratch()
    writeFileSync(path.join(dir, 'one'), 'first bytes')
    writeFileSync(path.join(dir, 'two'), 'second bytes, after a retry')
    const target = { agent: randomUUID(), homeId: HOME, generation: 2 }

    expect(await store.get({ ...target, file: path.join(dir, 'got') }, signal())).toEqual({ ok: false, kind: 'not_found' })

    const first = await store.put({ ...target, file: path.join(dir, 'one'), manifestSha256: 'a'.repeat(64) }, signal())
    expect(first).toMatchObject({ ok: true, value: { bytes: 11, sha256: createHash('sha256').update('first bytes').digest('hex') } })

    const retry = await store.put({ ...target, file: path.join(dir, 'two') }, signal())
    expect(retry).toMatchObject({ ok: true, value: { bytes: 27 } })

    const got = await store.get({ ...target, file: path.join(dir, 'got') }, signal())
    expect(got).toMatchObject({ ok: true, value: { bytes: 27, manifestSha256: 'a'.repeat(64) } })
    expect(readFileSync(path.join(dir, 'got'), 'utf8')).toBe('second bytes, after a retry')
  })
})

// ---------------------------------------------------------------------- the Shell and the object store (atum-platform #664)

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const OTHER_HOME = '00000000-0000-4000-8000-bd7662a5eeb4'
const MANIFEST = 'b'.repeat(64)

type Answer = Record<string, unknown>
type Alteration = [name: string, change: (body: Answer) => unknown, kind: ArchiveFailure['kind']]

/** The archive and key calls the Shell was asked, in order (the placement reads and the reservation are not among them). */
const actionsOf = (w: World): string[] =>
  w.stub.requests.flatMap(each => (each.action && /^(CheckpointArchive|HomeKeyRead)/u.test(each.action) ? [each.action] : []))

const callsOf = (w: World, action: string) => w.stub.requests.filter(each => each.action === action)

/** An agent at A with its next generation reserved, and the stores of the two Macs: A is the home, B is the owner's other Mac. */
async function reserved(options: { tus?: { retryDelaysMs?: readonly number[]; requestTimeoutMs?: number } } = {}) {
  const w = await createWorld()
  const generation = await reserveGeneration(w)
  const a = shellArchive(w, w.a, options)
  const b = shellArchive(w, w.b)
  const dir = scratch()

  const file = (name: string, content: Uint8Array | string) => {
    writeFileSync(path.join(dir, name), content)

    return path.join(dir, name)
  }

  const target = { agent: w.agent, ...generation }

  /** Where a generation's bytes are asked to be put (the file must not exist). */
  const into = (name: string) => ({ agent: w.agent, homeId: target.homeId, generation: target.generation, file: path.join(dir, name) })

  return { w, a, b, dir, file, target, into }
}

/** The same, with the sealed bytes put and the generation committed: what any Mac of the owner may now read. */
async function committed() {
  const home = await reserved()
  const bytes = randomBytes(40_000)

  expect(await home.a.store.put({ ...home.target, file: home.file('sealed', bytes) }, signal())).toMatchObject({ ok: true })
  await commitGeneration(home.w, home.target, MANIFEST)

  return { ...home, bytes }
}

describe('putting the bytes of a reserved generation (begin, the object store, finalize)', () => {
  it('takes them in three steps, the bytes straight to the object store, and the platform ends up with those bytes and their digest', async () => {
    const { w, a, file, target } = await reserved()
    const bytes = randomBytes(300_000)

    expect(await a.store.put({ ...target, file: file('sealed', bytes) }, signal())).toEqual({ ok: true, value: { bytes: bytes.length, sha256: sha(bytes) } })

    // The Shell is asked twice, with small signed calls (it reads no more than 16 KiB of body); the bytes went to the store.
    expect(actionsOf(w)).toEqual(['CheckpointArchiveBegin', 'CheckpointArchiveFinalize'])
    expect(w.stub.storage.log.map(each => [each.method, each.status])).toEqual([['POST', 201], ['PATCH', 204]])
    expect(w.stub.storage.objects.size).toBe(1)

    const [objectPath, object] = [...w.stub.storage.objects.entries()][0]!

    expect(object.equals(bytes)).toBe(true)
    // The path is the platform's, built from this very home, generation and checkpoint.
    expect(objectPath.startsWith('agent-home/v2.1/')).toBe(true)
    expect(objectPath.includes(`/${w.agent}/${target.homeId}/generations/2/${target.checkpointId}.`)).toBe(true)
    expect(objectPath.endsWith('.sealed')).toBe(true)
    expect(w.stub.archiveReceipts.get(target.checkpointId)).toMatchObject({ bytes: bytes.length, sha256: sha(bytes) })
  })

  it('calls the Shell the way the platform insists on, and gives the object store only the credential the Shell minted', async () => {
    const { w, a, file, target } = await reserved()

    await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())

    expect(w.stub.lastHeaders).toMatchObject({
      authorization: `Bearer ${w.stub.token}`,
      'atum-agent-home-wire': '2.1',
      'content-type': 'application/json'
    })
    expect(w.stub.lastHeaders).not.toHaveProperty('cookie')

    expect(w.stub.storage.leaked).toEqual([])

    for (const request of w.stub.storage.log) {
      expect(request.headers['x-signature'], request.method).toMatch(/^up[.]/u)
      expect(request.headers['x-upsert'], request.method).toBe('false')
      expect(request.headers).not.toHaveProperty('authorization')
      expect(request.headers).not.toHaveProperty('cookie')
    }
  })

  it('sends every chunk but the last at the size the object store insists on', async () => {
    const { w, a, file, target } = await reserved()
    const bytes = randomBytes(TUS_CHUNK_BYTES + 17)

    expect(await a.store.put({ ...target, file: file('sealed', bytes) }, signal())).toEqual({ ok: true, value: { bytes: bytes.length, sha256: sha(bytes) } })
    expect(w.stub.storage.log.filter(each => each.method === 'PATCH').map(each => each.bytes)).toEqual([TUS_CHUNK_BYTES, 17])
    expect([...w.stub.storage.objects.values()][0]!.equals(bytes)).toBe(true)
  })

  it('is answered from the platform’s own record when the same bytes are put again, and uploads nothing twice', async () => {
    const { w, a, file, target } = await reserved()
    const bytes = randomBytes(5000)
    const first = await a.store.put({ ...target, file: file('one', bytes) }, signal())

    expect(first).toMatchObject({ ok: true })
    expect(await a.store.put({ ...target, file: file('two', bytes) }, signal())).toEqual(first)

    expect(actionsOf(w)).toEqual(['CheckpointArchiveBegin', 'CheckpointArchiveFinalize', 'CheckpointArchiveBegin'])
    expect(w.stub.storage.created).toBe(1)
  })

  it('is told, for good, that the generation holds other bytes already (a retry seals with a fresh nonce)', async () => {
    const { w, a, file, target } = await reserved()
    const bytes = randomBytes(5000)

    expect(await a.store.put({ ...target, file: file('one', bytes) }, signal())).toMatchObject({ ok: true })

    // The same size with other bytes: the platform answers "stored" with the digest it holds, and that is not this file's.
    expect(await a.store.put({ ...target, file: file('same-size', randomBytes(5000)) }, signal())).toEqual({ ok: false, kind: 'conflict' })
    // Another size: the platform refuses outright.
    expect(await a.store.put({ ...target, file: file('other-size', randomBytes(5001)) }, signal())).toEqual({ ok: false, kind: 'conflict' })

    // Neither touched the object that is held, and nothing more was uploaded.
    expect(w.stub.storage.created).toBe(1)
    expect([...w.stub.storage.objects.values()][0]!.equals(bytes)).toBe(true)
  })

  describe('while another upload of the generation is live', () => {
    it('waits as long as the platform says, then begins, signing a new frame (a frame is never sent twice)', async () => {
      const { w, a, file, target } = await reserved()
      const before = w.clock.now()

      w.stub.failAction = { action: 'CheckpointArchiveBegin', status: 409, reason: 'agent_home_archive_upload_busy', headers: { 'retry-after': '7' } }

      expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toMatchObject({ ok: true })
      expect(w.clock.now() - before).toBe(7000)
      expect(callsOf(w, 'CheckpointArchiveBegin').map(each => each.status)).toEqual([409, 200])
    })

    it('takes a Retry-After it can read, two minutes at most, and a short wait of its own for one it cannot', async () => {
      for (const [header, waited] of [['3', 3000], ['0', 1000], ['99999', 120_000], ['soon', 5000], ['-4', 5000]] as const) {
        const { w, a, file, target } = await reserved()
        const before = w.clock.now()

        w.stub.failAction = { action: 'CheckpointArchiveBegin', status: 409, reason: 'agent_home_archive_upload_busy', headers: { 'retry-after': header } }

        expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal()), header).toMatchObject({ ok: true })
        expect(w.clock.now() - before, header).toBe(waited)
      }
    })

    it('gives up after three tries on an upload that stays busy, waiting between the tries and not after the last, and says "busy"', async () => {
      const { w, a, file, target } = await reserved()
      const before = w.clock.now()

      w.stub.archiveUploadBusy = true

      expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'busy' })
      expect(callsOf(w, 'CheckpointArchiveBegin')).toHaveLength(3)
      expect(w.clock.now() - before).toBe(2 * 2000)
      expect(w.stub.storage.log).toEqual([])
    })

    it('begins again when its 90 seconds ran out under a store that kept failing, and the new attempt lands', async () => {
      // The one chunk fails once, and the wait before the second try (100 s) is longer than the attempt lives.
      const { w, a, file, target } = await reserved({ tus: { retryDelaysMs: [0, 100_000] } })
      const bytes = randomBytes(5000)

      w.stub.storage.patchFaults.push(503)

      expect(await a.store.put({ ...target, file: file('sealed', bytes) }, signal())).toEqual({ ok: true, value: { bytes: bytes.length, sha256: sha(bytes) } })
      expect(callsOf(w, 'CheckpointArchiveBegin')).toHaveLength(2)
      expect(w.stub.storage.created).toBe(2)
      // The first attempt's upload never completed, so the one object is the second attempt's.
      expect(w.stub.storage.objects.size).toBe(1)
      expect(callsOf(w, 'CheckpointArchiveFinalize')).toHaveLength(1)
    })
  })

  describe('when the object store is not where the bytes can go', () => {
    it('says "too large" when its limit is below the archive, and tries nothing else', async () => {
      const { w, a, file, target } = await reserved()

      w.stub.storage.maxObjectBytes = 1000

      expect(await a.store.put({ ...target, file: file('sealed', randomBytes(5000)) }, signal())).toEqual({ ok: false, kind: 'too_large' })
      expect(actionsOf(w)).toEqual(['CheckpointArchiveBegin'])
      expect(w.stub.storage.log.map(each => each.status)).toEqual([413])
    })

    it('reports a store that is down as unavailable, after at most three attempts at an upload, and finalizes nothing', async () => {
      const { w, a, file, target } = await reserved()
      const before = w.clock.now()

      w.stub.storage.down = true

      expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unavailable' })
      expect(callsOf(w, 'CheckpointArchiveBegin')).toHaveLength(3)
      expect(callsOf(w, 'CheckpointArchiveFinalize')).toHaveLength(0)
      // The second try had to wait for the first attempt to end (90 s); the whole is bounded.
      expect(w.clock.now() - before).toBeLessThan(2 * 60_000)
    })

    it('carries on from where the store is after a connection that died in the middle of the upload', async () => {
      const { w, a, file, target } = await reserved()
      const bytes = randomBytes(5000)

      // The chunk was taken, but the answer never came: it is not sent again.
      w.stub.storage.patchFaults.push('drop-after-store')

      expect(await a.store.put({ ...target, file: file('sealed', bytes) }, signal())).toEqual({ ok: true, value: { bytes: bytes.length, sha256: sha(bytes) } })
      expect(w.stub.storage.created).toBe(1)
      expect(w.stub.storage.log.filter(each => each.method === 'PATCH')).toHaveLength(1)
      expect(callsOf(w, 'CheckpointArchiveBegin')).toHaveLength(1)
    })
  })

  describe('at finalize', () => {
    it('looks again shortly when the store does not yet show the object', async () => {
      const { w, a, file, target } = await reserved()
      const before = w.clock.now()

      w.stub.failAction = { action: 'CheckpointArchiveFinalize', status: 409, reason: 'agent_home_archive_upload_incomplete', headers: { 'retry-after': '2' }, times: 2 }

      expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toMatchObject({ ok: true })
      expect(callsOf(w, 'CheckpointArchiveFinalize')).toHaveLength(3)
      expect(w.clock.now() - before).toBe(2 * 2000)
      expect(w.stub.storage.created).toBe(1)
    })

    it('gives up on an object that never shows: it looks while the attempt lives, begins again once it has ended, and says it could not', async () => {
      const { w, a, file, target } = await reserved()

      // The store is asked to wait a minute between the looks, and an attempt lives 90 seconds (the Mac stops using it at 87).
      w.stub.failAction = { action: 'CheckpointArchiveFinalize', status: 409, reason: 'agent_home_archive_upload_incomplete', headers: { 'retry-after': '60' }, times: 99 }

      expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unavailable' })

      // Three attempts, each looked at three times: at the start, a minute in, and two minutes in, which is after its end,
      // so the third look is the last one of that attempt (it does not go on looking at an attempt that cannot be finalized).
      expect(callsOf(w, 'CheckpointArchiveBegin')).toHaveLength(3)
      expect(callsOf(w, 'CheckpointArchiveFinalize')).toHaveLength(9)
    })

    it('reads "the store shows another size than was declared" as bytes that did not arrive whole, and stops there', async () => {
      const { w, a, file, target } = await reserved()

      w.stub.failAction = { action: 'CheckpointArchiveFinalize', status: 409, reason: 'agent_home_archive_size_mismatch', headers: { 'retry-after': '2' } }

      expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'corrupt' })
      expect(callsOf(w, 'CheckpointArchiveFinalize')).toHaveLength(1)
      expect(callsOf(w, 'CheckpointArchiveBegin')).toHaveLength(1)
    })

    it('begins again when the platform says its attempt ended under it, and the new attempt lands', async () => {
      const { w, a, file, target } = await reserved()
      const bytes = randomBytes(5000)

      w.stub.failAction = { action: 'CheckpointArchiveFinalize', status: 409, reason: 'agent_home_archive_conflict', headers: { 'retry-after': '1' } }

      expect(await a.store.put({ ...target, file: file('sealed', bytes) }, signal())).toEqual({ ok: true, value: { bytes: bytes.length, sha256: sha(bytes) } })
      // The attempt that ended left an unreferenced object behind; the one the platform recorded is the second.
      expect(w.stub.storage.created).toBe(2)
      expect(w.stub.archiveReceipts.get(target.checkpointId)).toMatchObject({ bytes: bytes.length, sha256: sha(bytes) })
    })

    it('does not begin again for a generation that is not open for writing', async () => {
      const { w, a, file, target } = await reserved()

      w.stub.failAction = { action: 'CheckpointArchiveBegin', status: 409, reason: 'agent_home_archive_conflict', headers: { 'retry-after': '1' } }

      expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'conflict' })
      expect(actionsOf(w)).toEqual(['CheckpointArchiveBegin'])
    })
  })

  describe('an answer that is not what the contract writes is not trusted', () => {
    const upload = (body: Answer) => body.upload as Answer
    const withUpload = (body: Answer, change: Answer) => ({ ...body, upload: { ...upload(body), ...change } })
    const without = (body: Answer, name: string) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== name))

    it('to begin: no byte and no token goes anywhere the Shell’s word does not justify', async () => {
      const probe = await reserved()

      const alterations: Alteration[] = [
        ['an upload for another checkpoint', body => ({ ...body, checkpointId: randomUUID() }), 'unavailable'],
        ['an upload for another generation', body => ({ ...body, generation: 3 }), 'unavailable'],
        ['another root version', body => ({ ...body, rootVersion: 2 }), 'unavailable'],
        ['a field the contract does not write', body => ({ ...body, extra: true }), 'unavailable'],
        ['no upload at all', body => without(body, 'upload'), 'unavailable'],
        ['an object path in another home', body => withUpload(body, { path: String(upload(body).path).replace(probe.target.homeId, OTHER_HOME) }), 'unavailable'],
        ['an object path that climbs out of its folder', body => withUpload(body, { path: String(upload(body).path).replace('/generations/', '/../generations/') }), 'unavailable'],
        ['an object that is not a sealed archive', body => withUpload(body, { path: String(upload(body).path).replace(/[.]sealed$/u, '.txt') }), 'unavailable'],
        ['another bucket', body => withUpload(body, { bucket: 'public' }), 'unavailable'],
        ['an endpoint in plain http', body => withUpload(body, { endpoint: 'http://storage.example/storage/v1/upload/resumable' }), 'unavailable'],
        ['an endpoint with a login in it', body => withUpload(body, { endpoint: 'https://user:secret@storage.test/storage/v1/upload/resumable' }), 'unavailable'],
        ['a token that is not the header it came with', body => withUpload(body, { headers: { 'x-signature': 'some-other-token', 'x-upsert': 'false' } }), 'unavailable'],
        ['a header that lets the store overwrite', body => withUpload(body, { headers: { ...(upload(body).headers as Answer), 'x-upsert': 'true' } }), 'unavailable'],
        ['a header the contract does not write', body => withUpload(body, { headers: { ...(upload(body).headers as Answer), authorization: 'Bearer x' } }), 'unavailable'],
        ['chunks below a megabyte', body => withUpload(body, { chunkBytes: 1000 }), 'unavailable'],
        ['chunks above sixty-four megabytes', body => withUpload(body, { chunkBytes: 65 * 1024 * 1024 }), 'unavailable'],
        ['a field of the upload the contract does not write', body => withUpload(body, { extra: true }), 'unavailable'],
        ['a stored object of other bytes', body => ({ outcome: 'stored', checkpointId: body.checkpointId, generation: body.generation, bytes: 5000, sha256: 'f'.repeat(64), rootVersion: 1 }), 'conflict']
      ]

      for (const [name, change, kind] of alterations) {
        const { w, a, file, target } = await reserved()
        const before = w.stub.requests.length

        w.stub.alterAnswer = { action: 'CheckpointArchiveBegin', change }

        expect(await a.store.put({ ...target, file: file('sealed', randomBytes(5000)) }, signal()), name).toEqual({ ok: false, kind })
        expect(w.stub.storage.log, name).toEqual([])
        expect(callsOf(w, 'CheckpointArchiveFinalize'), name).toHaveLength(0)
        // Two requests in all: the placement read and the begin. Nothing went to the endpoint the answer named (the fake Shell logs a stray one).
        expect(w.stub.requests.length - before, name).toBe(2)
      }
    })

    it('to finalize: what the platform says it holds must be what this Mac sealed, to the byte and to the digest', async () => {
      const alterations: Alteration[] = [
        ['one byte more than were sent', body => ({ ...body, bytes: Number(body.bytes) + 1 }), 'conflict'],
        ['the digest of other bytes', body => ({ ...body, sha256: 'f'.repeat(64) }), 'conflict'],
        ['another root version', body => ({ ...body, rootVersion: 2 }), 'unavailable'],
        ['a field the contract does not write', body => ({ ...body, extra: true }), 'unavailable'],
        ['an upload where a stored object is meant', body => ({ ...body, outcome: 'upload' }), 'unavailable'],
        ['a digest in capitals', body => ({ ...body, sha256: String(body.sha256).toUpperCase() }), 'unavailable']
      ]

      for (const [name, change, kind] of alterations) {
        const { w, a, file, target } = await reserved()

        w.stub.alterAnswer = { action: 'CheckpointArchiveFinalize', change }

        expect(await a.store.put({ ...target, file: file('sealed', randomBytes(5000)) }, signal()), name).toEqual({ ok: false, kind })
      }
    })
  })
})

describe('getting a committed generation back', () => {
  it('hands it to the home Mac and, from the moment a move is asked for, to the Mac it moves to, with the manifest digest', async () => {
    const { w, a, b, dir, into, bytes } = await committed()

    // B is neither the home nor the target of a move.
    expect(await b.store.get(into('early'), signal())).toEqual({ ok: false, kind: 'forbidden' })
    expect(existsSync(path.join(dir, 'early'))).toBe(false)

    const home = await a.store.get(into('home'), signal())

    expect(home).toEqual({ ok: true, value: { bytes: bytes.length, sha256: sha(bytes), manifestSha256: MANIFEST } })
    expect(readFileSync(path.join(dir, 'home')).equals(bytes)).toBe(true)
    expect(statSync(path.join(dir, 'home')).mode % 0o1000).toBe(0o600)

    await requestMove(w)

    expect(await b.store.get(into('target'), signal())).toEqual(home)
    expect(readFileSync(path.join(dir, 'target')).equals(bytes)).toBe(true)
  })

  it('takes the key and the archive the same way, so that what one Mac sealed the other opens', async () => {
    const { w, a, b, dir, target, file } = await reserved()
    const plain = file('plain', 'the memory of an agent')
    const key = await a.keys.key({ agent: w.agent, homeId: target.homeId }, signal())

    expect(key.ok).toBe(true)

    if (!key.ok) {
      return
    }

    const sealed = await sealFile({ plain, sealed: path.join(dir, 'sealed'), key: key.value, homeId: target.homeId, generation: target.generation })

    expect(await a.store.put({ ...target, file: path.join(dir, 'sealed') }, signal())).toEqual({ ok: true, value: { bytes: sealed.bytes, sha256: sealed.sha256 } })
    await commitGeneration(w, target, MANIFEST)
    await requestMove(w)

    const received = path.join(dir, 'received')
    const keyOfB = await b.keys.key({ agent: w.agent, homeId: target.homeId }, signal())

    expect(keyOfB).toEqual(key)
    expect(await b.store.get({ agent: w.agent, homeId: target.homeId, generation: target.generation, file: received }, signal())).toMatchObject({ ok: true, value: { sha256: sealed.sha256 } })

    if (keyOfB.ok) {
      await openFile({ sealed: received, plain: path.join(dir, 'opened'), key: keyOfB.value, homeId: target.homeId, generation: target.generation })
    }

    expect(readFileSync(path.join(dir, 'opened'), 'utf8')).toBe('the memory of an agent')
  })

  it('hands back nothing of a generation that is not committed, as nothing there', async () => {
    const { w, a, file, dir, target, into } = await reserved()

    await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())

    // Reserved and uploaded is not enough: there is nothing to read until the commit binds the manifest to it.
    expect(await a.store.get(into('early'), signal())).toEqual({ ok: false, kind: 'not_found' })
    expect(await a.store.get({ ...into('never'), generation: 9 }, signal())).toEqual({ ok: false, kind: 'not_found' })
    expect(existsSync(path.join(dir, 'early'))).toBe(false)
    expect(existsSync(path.join(dir, 'never'))).toBe(false)
    expect(callsOf(w, 'CheckpointArchiveDownload').map(each => each.status)).toEqual([404, 404])
  })

  it('follows the link as it is, with nothing of this Mac’s, and keeps nothing else in the object store’s log', async () => {
    const { w, a, into } = await committed()
    const before = w.stub.storage.log.length

    expect(await a.store.get(into('got'), signal())).toMatchObject({ ok: true })

    const requests = w.stub.storage.log.slice(before)

    expect(requests.map(each => [each.method, each.status])).toEqual([['GET', 200]])
    expect(requests[0]!.path.startsWith('/storage/v1/object/sign/')).toBe(true)
    expect(requests[0]!.headers).not.toHaveProperty('authorization')
    expect(requests[0]!.headers).not.toHaveProperty('cookie')
    expect(w.stub.storage.leaked).toEqual([])
  })

  it('does not keep bytes that are not the bytes the platform recorded: other bytes, fewer, more', async () => {
    const { w, a, dir, target, bytes, into } = await committed()
    const held = `${target.homeId}:${target.generation}`

    const damaged: Array<[string, Buffer]> = [
      ['other bytes of the same length', Buffer.alloc(bytes.length, 1)],
      ['one byte fewer', bytes.subarray(0, bytes.length - 1)],
      ['one byte more', Buffer.concat([bytes, Buffer.from('x')])]
    ]

    for (const [name, served] of damaged) {
      w.stub.archives.set(held, served)

      expect(await a.store.get(into(name.replaceAll(' ', '-')), signal()), name).toEqual({ ok: false, kind: 'corrupt' })
      expect(existsSync(path.join(dir, name.replaceAll(' ', '-'))), name).toBe(false)
    }
  })

  it('writes only a file of its own: one that is already there is left as it is, and so is a file that cannot be written', async () => {
    const { a, dir, into, bytes } = await committed()

    writeFileSync(path.join(dir, 'taken'), 'not the archive')

    expect(await a.store.get(into('taken'), signal())).toEqual({ ok: false, kind: 'unavailable' })
    expect(readFileSync(path.join(dir, 'taken'), 'utf8')).toBe('not the archive')

    // Nowhere to write: no folder.
    expect(await a.store.get(into('no-such-folder/got'), signal())).toEqual({ ok: false, kind: 'unavailable' })

    // And a free name works after all that.
    expect(await a.store.get(into('free'), signal())).toMatchObject({ ok: true })
    expect(readFileSync(path.join(dir, 'free')).equals(bytes)).toBe(true)
  })

  it('reads a link that ended as "not now" and an object that is gone as "not there", and neither as damaged bytes', async () => {
    const { w, a, dir, target, into } = await committed()

    // The token is not one the store minted, or has ended: the store answers 400.
    w.stub.alterAnswer = { action: 'CheckpointArchiveDownload', change: body => ({ ...body, url: String(body.url).replace(/token=.*$/u, 'token=dl.ended') }) }
    expect(await a.store.get(into('ended'), signal())).toEqual({ ok: false, kind: 'unavailable' })

    // The object is gone from the store.
    w.stub.archives.delete(`${target.homeId}:${target.generation}`)
    w.stub.storage.objects.clear()
    expect(await a.store.get(into('gone'), signal())).toEqual({ ok: false, kind: 'not_found' })

    expect(existsSync(path.join(dir, 'ended'))).toBe(false)
    expect(existsSync(path.join(dir, 'gone'))).toBe(false)
  })

  it('does not trust an answer that is not what the contract writes, and does not go to a link it would not send a request to', async () => {
    const { w, a, into } = await committed()
    const without = (body: Answer, name: string) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== name))

    const alterations: Alteration[] = [
      ['a link that is not https', body => ({ ...body, url: 'http://storage.example/object' }), 'unavailable'],
      ['a link with a login in it', body => ({ ...body, url: 'https://user:secret@storage.test/object' }), 'unavailable'],
      ['a link that is not a link', body => ({ ...body, url: 'not a url' }), 'unavailable'],
      ['a count that is not a number of bytes', body => ({ ...body, bytes: 0 }), 'unavailable'],
      ['a digest in capitals', body => ({ ...body, sha256: String(body.sha256).toUpperCase() }), 'unavailable'],
      ['no manifest digest', body => without(body, 'manifestSha256'), 'unavailable'],
      ['another root version', body => ({ ...body, rootVersion: 2 }), 'unavailable'],
      ['a field the contract does not write', body => ({ ...body, extra: true }), 'unavailable'],
      // The link is the right one; what it says the object holds is not what arrives through it.
      ['one byte more than the object holds', body => ({ ...body, bytes: Number(body.bytes) + 1 }), 'corrupt'],
      ['the digest of other bytes', body => ({ ...body, sha256: 'f'.repeat(64) }), 'corrupt']
    ]

    for (const [name, change, kind] of alterations) {
      const before = w.stub.storage.log.length
      const asked = w.stub.requests.length

      w.stub.alterAnswer = { action: 'CheckpointArchiveDownload', change }

      expect(await a.store.get(into(name.replaceAll(' ', '-')), signal()), name).toEqual({ ok: false, kind })

      // A link the Mac does not trust is never asked; a trusted one is asked and the bytes are checked.
      expect(w.stub.storage.log.length - before, name).toBe(kind === 'unavailable' ? 0 : 1)
      // Two requests of the Shell's in all (the placement read and the download), and no stray one to a host the answer named.
      expect(w.stub.requests.length - asked, name).toBe(2)
    }
  })
})

describe('the data key', () => {
  it('is 32 bytes for the home, the same for every Mac that may ask, and named as the platform names it', async () => {
    const { w, a, b, target } = await reserved()
    const home = { agent: w.agent, homeId: target.homeId }
    const first = await a.keys.key(home, signal())

    expect(first.ok && first.value.key.length).toBe(32)
    expect(first.ok && first.value.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    // The name covers the root version, the owner, the agent and the home: it is not the key's own digest.
    expect(first.ok && first.value.keyId).not.toBe(sha(first.ok ? first.value.key : ''))
    expect(first.ok && first.value.keyId).not.toBe(createHash('sha256').update(first.ok ? first.value.key : '').digest('base64url'))
    expect(await a.keys.key(home, signal())).toEqual(first)

    // The other Mac is not let in until a move is asked for.
    expect(await b.keys.key(home, signal())).toEqual({ ok: false, kind: 'forbidden' })
    await requestMove(w)
    expect(await b.keys.key(home, signal())).toEqual(first)
  })

  it('is asked for with a signed call: a JSON POST with the bearer and the wire version, and no cookie', async () => {
    const { w, a, target } = await reserved()

    await a.keys.key({ agent: w.agent, homeId: target.homeId }, signal())

    expect(actionsOf(w)).toEqual(['HomeKeyRead'])
    expect(w.stub.lastHeaders).toMatchObject({
      authorization: `Bearer ${w.stub.token}`,
      'atum-agent-home-wire': '2.1',
      'content-type': 'application/json'
    })
    expect(w.stub.lastHeaders).not.toHaveProperty('cookie')
  })

  it('is not read for a home the platform no longer names', async () => {
    const { w, a } = await reserved()

    expect(await a.keys.key({ agent: w.agent, homeId: OTHER_HOME }, signal())).toEqual({ ok: false, kind: 'conflict' })
    expect(actionsOf(w)).toEqual([])
  })

  describe('named as the platform names it: root version, owner, agent and home (atum-platform agentHomeSealKeyId)', () => {
    const NUL = String.fromCharCode(0)
    const OWNER = '00000000-0000-4000-8000-87d96e07d1bf'
    const OTHER_OWNER = '00000000-0000-4000-8000-98bee2407429'

    /** The platform's function, line for line: the root version byte, then the tuple under the contract's domain word. */
    const platformKeyId = (rootVersion: number, owner: string, agent: string, home: string) =>
      createHash('sha256')
        .update(Buffer.from([rootVersion]))
        .update(`atum.agent-home/2.1${NUL}owner_agent_home${NUL}${owner}${NUL}${agent}${NUL}${home}`, 'utf8')
        .digest('base64url')

    it('is recomputed to the byte: known answers made by the platform’s own function', () => {
      const agent = '00000000-0000-4000-8000-bd7662a5eeb4'
      const home = '00000000-0000-4000-8000-e8d95748107a'

      expect(agentHomeSealKeyId(1, OWNER, agent, home)).toBe('ZO1M-XVfw1mcSFhEWeT2m9AH19xpilYP64MypRCkmgo')
      expect(agentHomeSealKeyId(1, OTHER_OWNER, agent, home)).toBe('CNs7hj-FN59hTsMjsLU8dTfHFvVVHBY1Ref0RQ2Ov2I')
      expect(agentHomeSealKeyId(1, OWNER, agent, home)).toBe(platformKeyId(1, OWNER, agent, home))
    })

    it('is accepted when it is the name derived for this owner, agent and home', async () => {
      const { w, a, target } = await reserved()
      const key = await a.keys.key({ agent: w.agent, homeId: target.homeId }, signal())

      expect(key.ok && key.value.keyId).toBe(platformKeyId(1, w.stub.ownerPrincipal, w.agent, target.homeId))
    })

    it('is refused when the platform names it for another owner, agent, home or root version, or by the key’s own digest, before anything is sealed or opened', async () => {
      const names: Array<[string, (owner: string, agent: string, home: string, body: Answer) => string]> = [
        ['another owner', (_owner, agent, home) => platformKeyId(1, OTHER_OWNER, agent, home)],
        ['another agent', (owner, _agent, home) => platformKeyId(1, owner, OTHER_HOME, home)],
        ['another home', (owner, agent) => platformKeyId(1, owner, agent, OTHER_HOME)],
        ['another root version', (owner, agent, home) => platformKeyId(2, owner, agent, home)],
        ['the digest of the key', (_owner, _agent, _home, body) => createHash('sha256').update(Buffer.from(String(body.key), 'base64url')).digest('base64url')],
        ['a name of the right shape that is nobody’s', () => 'A'.repeat(43)]
      ]

      for (const [name, nameFor] of names) {
        const { w, a, target } = await reserved()

        w.stub.alterAnswer = {
          action: 'HomeKeyRead',
          change: body => ({ ...body, keyId: nameFor(w.stub.ownerPrincipal, w.agent, target.homeId, body) })
        }

        expect(await a.keys.key({ agent: w.agent, homeId: target.homeId }, signal()), name).toEqual({ ok: false, kind: 'unavailable' })
      }
    })

    it('is refused when this Mac cannot say who the owner is, or believes another owner than the one the platform derived it for', async () => {
      const { w, target } = await reserved()

      const ask = (ownerPrincipal: (signal: AbortSignal) => Promise<string | null>) =>
        shellArchive(w, w.a, { ownerPrincipal }).keys.key({ agent: w.agent, homeId: target.homeId }, signal())

      expect(await ask(async () => null)).toEqual({ ok: false, kind: 'unavailable' })
      expect(await ask(async () => OTHER_OWNER)).toEqual({ ok: false, kind: 'unavailable' })
      expect(await ask(async () => 'not-a-principal')).toEqual({ ok: false, kind: 'unavailable' })

      expect(
        await ask(async () => {
          throw new Error('offline')
        })
      ).toEqual({ ok: false, kind: 'unavailable' })

      expect(await ask(async () => w.stub.ownerPrincipal)).toMatchObject({ ok: true })
    })
  })

  it('is not taken from an answer that is not what the contract writes', async () => {
    const without = (body: Answer, name: string) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== name))

    const alterations: Alteration[] = [
      ['another version of the answer', body => ({ ...body, v: 2 }), 'unavailable'],
      ['another root version', body => ({ ...body, rootVersion: 2 }), 'unavailable'],
      ['no root version', body => without(body, 'rootVersion'), 'unavailable'],
      ['a key for another home', body => ({ ...body, homeId: OTHER_HOME }), 'unavailable'],
      ['a key of 31 bytes', body => ({ ...body, key: randomBytes(31).toString('base64url') }), 'unavailable'],
      ['a padded key', body => ({ ...body, key: `${String(body.key)}=` }), 'unavailable'],
      ['a key that is not a string', body => ({ ...body, key: 7 }), 'unavailable'],
      ['a name that is not 43 characters', body => ({ ...body, keyId: 'short' }), 'unavailable'],
      ['a field the contract does not write', body => ({ ...body, extra: true }), 'unavailable']
    ]

    for (const [name, change, kind] of alterations) {
      const { w, a, target } = await reserved()

      w.stub.alterAnswer = { action: 'HomeKeyRead', change }

      expect(await a.keys.key({ agent: w.agent, homeId: target.homeId }, signal()), name).toEqual({ ok: false, kind })
    }
  })
})

describe('a platform that cannot take or give an archive yet', () => {
  it('reads a Shell without the archive and key routes as one that has no such routes, in all three calls', async () => {
    const { w, a, file, target, into } = await reserved()

    w.stub.archiveRoutes = false

    expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(await a.store.get(into('got'), signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(await a.keys.key({ agent: w.agent, homeId: target.homeId }, signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(w.stub.storage.log).toEqual([])
  })

  it('reads a Shell with no object store client as unable to take or give an archive, and still gives the key', async () => {
    const home = await reserved()

    home.w.stub.storageConfigured = false

    expect(await home.a.store.put({ ...home.target, file: home.file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(await home.a.keys.key({ agent: home.w.agent, homeId: home.target.homeId }, signal())).toMatchObject({ ok: true })

    const done = await committed()

    done.w.stub.storageConfigured = false

    expect(await done.a.store.get(done.into('got'), signal())).toEqual({ ok: false, kind: 'unsupported' })
  })

  it('reads a Shell with no sealing root as unable to give a key, and still takes an archive', async () => {
    const { w, a, file, target } = await reserved()

    w.stub.sealingConfigured = false

    expect(await a.keys.key({ agent: w.agent, homeId: target.homeId }, signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toMatchObject({ ok: true })
  })

  it('reads a Shell that does not even have the placement route as unsupported, before signing anything', async () => {
    const { w, a, file, target, into } = await reserved()

    w.stub.unsupported = 'absent'

    expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(await a.store.get(into('got'), signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(await a.keys.key({ agent: w.agent, homeId: target.homeId }, signal())).toEqual({ ok: false, kind: 'unsupported' })
    expect(actionsOf(w)).toEqual([])
  })

  it('tells a failing platform from a missing one', async () => {
    const { w, a, file, target } = await reserved()

    // The placement read fails: nothing is signed.
    w.stub.failNext = { status: 500 }
    expect(await a.store.put({ ...target, file: file('one', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unavailable' })
    expect(actionsOf(w)).toEqual([])

    // The call itself fails.
    w.stub.failAction = { action: 'CheckpointArchiveBegin', status: 500 }
    expect(await a.store.put({ ...target, file: file('two', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unavailable' })

    w.stub.failAction = { action: 'CheckpointArchiveBegin', status: 503, reason: 'archive_store_unavailable' }
    expect(await a.store.put({ ...target, file: file('three', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unavailable' })

    w.stub.failAction = { action: 'CheckpointArchiveBegin', status: 401 }
    expect(await a.store.put({ ...target, file: file('four', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'unauthorized' })

    w.stub.failAction = { action: 'CheckpointArchiveBegin', status: 403 }
    expect(await a.store.put({ ...target, file: file('five', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'forbidden' })
  })
})

describe('who the store asks for, and what it asks before asking', () => {
  it('lets no Mac into the archive or the key unless it is the home or the target of its move, and asks no one when it is not', async () => {
    const { w, b, file, target, into } = await reserved()

    expect(await b.store.put({ ...target, file: file('sealed', 'sealed bytes') }, signal())).toEqual({ ok: false, kind: 'forbidden' })
    expect(await b.store.get(into('got'), signal())).toEqual({ ok: false, kind: 'forbidden' })
    expect(await b.keys.key({ agent: w.agent, homeId: target.homeId }, signal())).toEqual({ ok: false, kind: 'forbidden' })

    expect(actionsOf(w)).toEqual([])
    expect(w.stub.storage.log).toEqual([])
  })

  it('refuses what is not a home, a checkpoint or a generation before it asks anyone anything', async () => {
    const { w, a, file, target } = await reserved()
    const sealed = file('sealed', 'sealed bytes')

    expect(await a.store.put({ ...target, agent: 'not-a-uuid', file: sealed }, signal())).toEqual({ ok: false, kind: 'forbidden' })
    expect(await a.store.put({ ...target, homeId: 'not-a-uuid', file: sealed }, signal())).toEqual({ ok: false, kind: 'forbidden' })
    expect(await a.store.put({ ...target, checkpointId: 'not-a-uuid', file: sealed }, signal())).toEqual({ ok: false, kind: 'forbidden' })
    expect(await a.store.put({ ...target, generation: 0, file: sealed }, signal())).toEqual({ ok: false, kind: 'forbidden' })
    expect(await a.store.get({ agent: w.agent, homeId: target.homeId, generation: 0, file: path.join(scratch(), 'never') }, signal())).toEqual({ ok: false, kind: 'forbidden' })
    expect(await a.keys.key({ agent: 'not-a-uuid', homeId: target.homeId }, signal())).toEqual({ ok: false, kind: 'forbidden' })

    expect(actionsOf(w)).toEqual([])
  })

  it('has nothing to put when the file is empty or is not there', async () => {
    const { w, a, file, target, dir } = await reserved()

    expect(await a.store.put({ ...target, file: file('empty', '') }, signal())).toEqual({ ok: false, kind: 'unavailable' })
    expect(await a.store.put({ ...target, file: path.join(dir, 'missing') }, signal())).toEqual({ ok: false, kind: 'unavailable' })
    expect(actionsOf(w)).toEqual([])
  })

  it('stops when the caller has stopped it, asking no one', async () => {
    const { w, a, file, target, into } = await reserved()
    const stopped = AbortSignal.abort()

    expect(await a.store.put({ ...target, file: file('sealed', 'sealed bytes') }, stopped)).toEqual({ ok: false, kind: 'unavailable' })
    expect(await a.store.get(into('got'), stopped)).toEqual({ ok: false, kind: 'unavailable' })
    expect(await a.keys.key({ agent: w.agent, homeId: target.homeId }, stopped)).toEqual({ ok: false, kind: 'unavailable' })

    expect(actionsOf(w)).toEqual([])
    expect(w.stub.storage.log).toEqual([])
  })
})

describe('what a status of the Shell’s means', () => {
  it('is read as the platform’s closed words, and a missing route is told from a missing object by its body', () => {
    const cases: Array<[status: number, json: boolean, reason: string | null, kind: ArchiveFailure['kind']]> = [
      [401, true, null, 'unauthorized'],
      [403, true, null, 'forbidden'],
      [404, true, null, 'not_found'],
      [404, false, null, 'unsupported'],
      [405, false, null, 'unsupported'],
      [501, false, null, 'unsupported'],
      [409, true, 'agent_home_archive_upload_busy', 'busy'],
      [409, true, 'agent_home_archive_size_mismatch', 'corrupt'],
      [409, true, 'agent_home_archive_conflict', 'conflict'],
      [409, true, 'agent_home_archive_changed_replay', 'conflict'],
      [409, true, 'agent_home_archive_upload_incomplete', 'conflict'],
      [409, true, null, 'conflict'],
      [503, true, 'not_configured', 'unsupported'],
      [503, true, 'archive_store_unavailable', 'unavailable'],
      [503, true, 'binding_invalid', 'unavailable'],
      [500, true, null, 'unavailable'],
      [400, true, 'invalid', 'unavailable']
    ]

    for (const [status, json, reason, kind] of cases) {
      expect(failureOf(status, json, reason), `${status} ${reason ?? ''}`).toEqual({ ok: false, kind })
    }
  })
})

describe('the key of a pair of Macs that share a folder', () => {
  it('is a fixed key source', async () => {
    const key = newSealKey()

    expect(await new FixedSealKeySource(key).key()).toEqual({ ok: true, value: key })
  })
})
