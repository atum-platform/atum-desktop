// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Attachment, initAsync } from '@matrix-org/matrix-sdk-crypto-wasm'
import { EventType, type IContent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk'
import { DecryptionFailureCode, EventShieldColour } from 'matrix-js-sdk/lib/crypto-api'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { requestDigestV2 } from '../../../../packages/device-protocol/hashes'
import { MATRIX_MAX_FILE_BYTES, MATRIX_PLAIN_SENDER_DEVICE, matrixOwnerWireType } from '../../shared/matrix'
import { MATRIX_GOOGLE_PROVENANCE_KEY } from '../../shared/matrix-google-tools'
import { MATRIX_TASK_FILES_KEY } from '../../shared/matrix-task-files'

import { PLAIN_ANSWER_MS } from './plain-room'
import { readMatrixInvocation } from './read-invocation'

beforeAll(() => initAsync())
afterEach(() => vi.useRealTimers())

function fixture() {
  const bytes = new TextEncoder().encode('Confidential Matrix file fixture')
  const encrypted = Attachment.encrypt(bytes)
  const ciphertext = new Uint8Array(encrypted.encryptedData)
  const file = { ...JSON.parse(encrypted.mediaEncryptionInfo!), url: 'mxc://test/opaque-id' }
  encrypted.free()
  let content: IContent = { msgtype: 'm.file', body: 'Please inspect', filename: 'report.txt', file }
  const target = { roomId: '!room:test', eventId: '$file' }

  const crypto = {
    getUserDeviceInfo: vi.fn(
      async () =>
        new Map([
          [
            '@owner:test',
            new Map([
              [
                'DEVICE',
                {
                  deviceId: 'DEVICE',
                  getIdentityKey: () => 'curve',
                  getFingerprint: () => 'ed'
                }
              ]
            ])
          ]
        ])
    ),
    getDeviceVerificationStatus: vi.fn(async () => ({ isVerified: (): boolean => true })),
    getEncryptionInfoForEvent: vi.fn(async () => ({ shieldColour: EventShieldColour.NONE, shieldReason: null }))
  }

  const membership = vi.fn(() => 'join')

  const fetchRoomEvent = vi.fn(async () => ({
    type: EventType.RoomMessageEncrypted,
    room_id: target.roomId,
    event_id: target.eventId,
    sender: '@owner:test',
    origin_server_ts: Date.now(),
    content: {}
  }))

  const request = vi.fn(async () => new Blob([ciphertext]))

  const decryptEventIfNeeded = vi.fn(async (event: MatrixEvent) => {
    vi.spyOn(event, 'getType').mockReturnValue(EventType.RoomMessage)
    vi.spyOn(event, 'getContent').mockImplementation(() => content)
    vi.spyOn(event, 'getSenderKey').mockReturnValue('curve')
    vi.spyOn(event, 'getClaimedEd25519Key').mockReturnValue('ed')
  })

  const client = {
    getRoom: () => ({ getMyMembership: membership, hasEncryptionStateEvent: () => true }),
    getCrypto: () => crypto,
    fetchRoomEvent,
    http: { authedRequest: request },
    decryptEventIfNeeded
  } as unknown as MatrixClient

  return {
    bytes,
    file,
    target,
    client,
    crypto,
    membership,
    fetchRoomEvent,
    decryptEventIfNeeded,
    request,
    replace: (value: IContent) => {
      content = value
    }
  }
}

it('uses the bounded missing-session retry in the live invocation reader', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const decrypt = f.decryptEventIfNeeded.getMockImplementation()!

  f.decryptEventIfNeeded.mockImplementationOnce(async event => {
    vi.spyOn(event, 'isDecryptionFailure').mockReturnValue(true)
    vi.spyOn(event, 'decryptionFailureReason', 'get').mockReturnValue(
      DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID
    )
  })
  f.decryptEventIfNeeded.mockImplementationOnce(decrypt)

  const pending = readMatrixInvocation(f.client, f.target)
  await vi.advanceTimersByTimeAsync(1_000)

  await expect(pending).resolves.toMatchObject({ content: { body: 'Please inspect' } })
  expect(f.decryptEventIfNeeded).toHaveBeenCalledTimes(2)
})

it('rechecks joined membership after awaited decryption', async () => {
  const f = fixture()
  const decrypt = f.decryptEventIfNeeded.getMockImplementation()!

  f.decryptEventIfNeeded.mockImplementationOnce(async event => {
    await decrypt(event)
    f.membership.mockReturnValue('leave')
  })

  await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_untrusted')
})

it('reads metadata without downloading or exporting media keys, then returns identical Rust-decrypted bytes', async () => {
  const f = fixture()
  const first = await readMatrixInvocation(f.client, f.target)
  expect(first.content.attachment).toEqual({ name: 'report.txt', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(first.attachmentBytes).toBeUndefined()
  expect(JSON.stringify(first)).not.toContain('mxc://')
  expect(JSON.stringify(first)).not.toContain(f.file.key.k)
  expect(f.request).not.toHaveBeenCalled()
  const result = await readMatrixInvocation(f.client, { ...f.target, includeAttachment: true })
  expect(result.attachmentBytes).toEqual(f.bytes)
  expect(f.fetchRoomEvent).toHaveBeenCalledTimes(3)
  expect(f.request).toHaveBeenCalledWith(
    'GET',
    '/media/download/test/opaque-id',
    undefined,
    undefined,
    expect.objectContaining({ prefix: '/_matrix/client/v1', rawResponseBody: true })
  )
})

it('projects the exact verified encrypted task-file promise without treating it as a room attachment', async () => {
  const f = fixture()

  const promise = {
    version: 1,
    requestIds: ['00000000-0000-4000-8000-6e1357ad4c59', '00000000-0000-4000-8000-914ef7a13b20']
  }

  f.replace({ msgtype: 'm.text', body: 'Use my selected Drive files', [MATRIX_TASK_FILES_KEY]: promise })

  const result = await readMatrixInvocation(f.client, f.target)

  expect(result.senderVerified).toBe(true)
  expect(result.content.taskFiles).toEqual(promise)
  expect(result.content.invalidTaskFiles).toBeUndefined()
  expect(result.content.attachment).toBeUndefined()
})

it.each([
  null,
  0,
  {},
  { version: 1, requestIds: [] },
  { version: 1, requestIds: ['00000000-0000-4000-8000-6e1357ad4c59', '00000000-0000-4000-8000-6e1357ad4c59'] },
  { version: 1, requestIds: ['00000000-0000-4000-8000-6E1357AD4C59'] },
  { version: 1, requestIds: ['00000000-0000-4000-8000-6e1357ad4c59'], extra: true }
])('retains malformed task-file extensions as a denial (%j)', async extension => {
  const f = fixture()
  f.replace({
    msgtype: 'm.text',
    body: 'Do not degrade to a file-free task',
    [MATRIX_TASK_FILES_KEY]: extension
  } as IContent)

  const result = await readMatrixInvocation(f.client, f.target)

  expect(result.content.taskFiles).toBeUndefined()
  expect(result.content.invalidTaskFiles).toBe(true)
  expect(result.content.attachment).toBeUndefined()
})

it('preserves sender verification state when projecting a task-file promise', async () => {
  const f = fixture()
  f.crypto.getDeviceVerificationStatus.mockResolvedValue({ isVerified: (): boolean => false })
  f.replace({
    msgtype: 'm.text',
    body: 'No implicit trust',
    [MATRIX_TASK_FILES_KEY]: { version: 1, requestIds: ['00000000-0000-4000-8000-6e1357ad4c59'] }
  })

  const result = await readMatrixInvocation(f.client, f.target)

  expect(result.senderVerified).toBe(false)
  expect(result.content.taskFiles).toEqual({ version: 1, requestIds: ['00000000-0000-4000-8000-6e1357ad4c59'] })
})

it.each([
  { name: 'legacy decrypted thread reply', relation: { rel_type: 'm.thread', event_id: '$request' } },
  { name: 'standard decrypted rich reply', relation: { 'm.in_reply_to': { event_id: '$request' } } }
])('projects result identity from a $name', async ({ relation }) => {
  const f = fixture()
  f.replace({
    msgtype: 'm.text',
    body: 'Completed',
    'm.relates_to': relation,
    'io.atum.result': { invocation: 'invocation', transaction: 'transaction' }
  })
  const result = await readMatrixInvocation(f.client, f.target)
  expect(result.content.result).toEqual({
    rootEventId: '$request',
    invocationId: 'invocation',
    transactionId: 'transaction'
  })
  expect(result.senderVerified).toBe(true)
  expect(f.request).not.toHaveBeenCalled()
})

it('does not project a result from a non-reply relation with a forged reply field', async () => {
  const f = fixture()
  f.replace({
    msgtype: 'm.text',
    body: 'Completed',
    'm.relates_to': { rel_type: 'm.replace', event_id: '$replacement', 'm.in_reply_to': { event_id: '$request' } },
    'io.atum.result': { invocation: 'invocation', transaction: 'transaction' }
  })

  expect((await readMatrixInvocation(f.client, f.target)).content).not.toHaveProperty('result')
})

it('projects only explicit standard user mentions, not HTML or room notification intent', async () => {
  const f = fixture()
  f.replace({
    msgtype: 'm.text',
    body: 'A plain request',
    'm.mentions': { user_ids: ['@proxy:test', '@proxy:test', '@other:test'], room: true },
    formatted_body: '<a href="https://matrix.to/#/@forged:test">App</a>'
  })
  const result = await readMatrixInvocation(f.client, f.target)
  expect(result.content.mentionedUserIds).toEqual(['@proxy:test', '@other:test'])
  expect(result.content).not.toHaveProperty('formatted_body')
  expect(f.request).not.toHaveBeenCalled()
})

it('preserves Google provenance as a protected routing marker without exporting its value', async () => {
  const f = fixture()
  f.replace({
    msgtype: 'm.text',
    body: 'Protected source summary',
    [MATRIX_GOOGLE_PROVENANCE_KEY]: { v: 1, google: true, source: 'unexported' }
  })

  const result = await readMatrixInvocation(f.client, f.target)
  expect(result.content.googleProtected).toBe(true)
  expect(result.content).not.toHaveProperty(MATRIX_GOOGLE_PROVENANCE_KEY)
})

it.each([
  undefined,
  {},
  { room: true },
  { user_ids: '@proxy:test' },
  { user_ids: ['@proxy:test', 42] },
  { user_ids: ['not-a-mxid'] },
  { user_ids: ['@proxy:test\n'] },
  { user_ids: ['@two words:test'] },
  { user_ids: ['@proxy:test host'] },
  { user_ids: Array(101).fill('@proxy:test') },
  { user_ids: [`@${'a'.repeat(1024)}:test`] }
])('does not invent user addressing from malformed or absent mentions (%j)', async mentions => {
  const f = fixture()
  // Wire content is untrusted; deliberately exercise shapes outside IMentions.
  f.replace({ msgtype: 'm.text', body: '@proxy:test please help', 'm.mentions': mentions } as IContent)
  const result = await readMatrixInvocation(f.client, f.target)
  expect(result.content.mentionedUserIds).toBeUndefined()
  expect(result.content.body).toBe('@proxy:test please help')
})

it.each([
  null,
  [],
  'bad',
  { room: 'true' },
  { user_ids: null },
  { user_ids: [42] },
  { user_ids: Array(101).fill('@a:test') }
])('retains invalid addressing as a denial instead of permitting ambient Hermes fallback (%j)', async mentions => {
  const f = fixture()
  f.replace({ msgtype: 'm.text', body: 'Do not execute', 'm.mentions': mentions } as unknown as IContent)
  expect((await readMatrixInvocation(f.client, f.target)).content.invalidMentions).toBe(true)
})

it.each([undefined, {}, { user_ids: [] }, { room: true }, { user_ids: ['@app:test'] }])(
  'does not mark supported or absent addressing invalid (%j)',
  async mentions => {
    const f = fixture()
    f.replace({ msgtype: 'm.text', body: 'Hello', 'm.mentions': mentions })
    expect((await readMatrixInvocation(f.client, f.target)).content.invalidMentions).toBeUndefined()
  }
)

it.each(['url', 'integrity', 'unverified', 'oversize', 'left', 'revoked', 'changed'] as const)(
  'rejects %s rather than handing off bytes',
  async mode => {
    const f = fixture()

    if (mode === 'url') {
      f.replace({ msgtype: 'm.file', body: 'file', file: { ...f.file, url: 'https://elsewhere.test/secret' } })
    }

    if (mode === 'integrity') {
      f.request.mockResolvedValue(new Blob([new Uint8Array([1, 2])]))
    }

    if (mode === 'unverified') {
      f.crypto.getDeviceVerificationStatus.mockResolvedValue({ isVerified: () => false })
    }

    if (mode === 'oversize') {
      f.request.mockResolvedValue(new Blob([new Uint8Array(MATRIX_MAX_FILE_BYTES + 1)]))
    }

    const original = f.request.getMockImplementation()!

    if (['left', 'revoked', 'changed'].includes(mode)) {
      f.request.mockImplementation(async () => {
        const blob = await original()

        if (mode === 'left') {
          f.membership.mockReturnValue('leave')
        }

        if (mode === 'revoked') {
          f.crypto.getDeviceVerificationStatus.mockResolvedValue({ isVerified: () => false })
        }

        if (mode === 'changed') {
          f.replace({ msgtype: 'm.text', body: 'redacted replacement' })
        }

        return blob
      })
    }

    await expect(readMatrixInvocation(f.client, { ...f.target, includeAttachment: true })).rejects.toThrow()

    if (mode === 'url' || mode === 'unverified') {
      expect(f.request).not.toHaveBeenCalled()
    }
  }
)

it('projects a valid io.atum.turn marker so the server-path fence can refuse the turn', async () => {
  const f = fixture()
  const turn = '00000000-0000-4000-8000-31f949766961'
  f.replace({ msgtype: 'm.text', body: 'Hello', 'io.atum.turn': turn })
  expect((await readMatrixInvocation(f.client, f.target)).content.turn).toBe(turn)
})

it.each([undefined, 42, 'not-a-uuid', '00000000-0000-4000-8000-31F949766961', '00000000-0000-1000-8000-2a5349edf7e0'])(
  'never projects a malformed turn marker (%j)',
  async turn => {
    const f = fixture()
    f.replace({ msgtype: 'm.text', body: 'Hello', 'io.atum.turn': turn } as IContent)
    expect((await readMatrixInvocation(f.client, f.target)).content).not.toHaveProperty('turn')
  }
)

it('reads an edit as related even when its relation is only outside the ciphertext, so it never runs as a turn', async () => {
  const f = fixture()
  f.replace({ msgtype: 'm.text', body: '* Hello again', 'm.new_content': { msgtype: 'm.text', body: 'Hello again' } })
  // Older clients moved the relation out of the encrypted content, where the server sees it.
  f.fetchRoomEvent.mockResolvedValue({
    type: EventType.RoomMessageEncrypted,
    room_id: f.target.roomId,
    event_id: f.target.eventId,
    sender: '@owner:test',
    origin_server_ts: Date.now(),
    content: { 'm.relates_to': { rel_type: 'm.replace', event_id: '$question' } }
  })

  expect((await readMatrixInvocation(f.client, f.target)).related).toBe(true)

  f.fetchRoomEvent.mockResolvedValue({
    type: EventType.RoomMessageEncrypted,
    room_id: f.target.roomId,
    event_id: f.target.eventId,
    sender: '@owner:test',
    origin_server_ts: Date.now(),
    content: {}
  })
  f.replace({ msgtype: 'm.text', body: 'A new question' })
  expect((await readMatrixInvocation(f.client, f.target)).related).toBe(false)
})

/** The frozen atum.cloud-answering/1 request digest v2 vectors. */
function vectors() {
  const pack = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/device-protocol/fixtures/cloud-answering/fixtures'
  )

  return (
    JSON.parse(readFileSync(path.join(pack, 'digest.vectors.json'), 'utf8')).vectors as Array<{
      name: string
      version: number
      content: IContent
      dg: string
    }>
  ).filter(vector => vector.version === 2)
}

describe('the cloud brain’s projection', () => {
  it.each(vectors().map(vector => [vector.name, vector] as const))(
    'digests the whole content as request digest v2: %s',
    async (_name, vector) => {
      const f = fixture()
      f.replace(vector.content)
      const result = await readMatrixInvocation(f.client, f.target)
      expect(result.contentDigest).toBe(vector.dg)
    }
  )

  it('carries the sender device’s fingerprint and the raw origin assertion, which grants nothing here', async () => {
    const f = fixture()
    const origin = { v: 1, dsid: '00000000-0000-4000-8000-b86a6ca39e23', sig: 'x' }
    f.replace({ msgtype: 'm.text', body: 'Make hello.txt', 'io.atum.origin': origin })
    const result = await readMatrixInvocation(f.client, f.target)
    expect(result.senderFingerprint).toBe('ed')
    expect(result.content.origin).toEqual(origin)
    // The digest never covers the assertion that signs it.
    const plain = fixture()
    plain.replace({ msgtype: 'm.text', body: 'Make hello.txt' })
    expect((await readMatrixInvocation(plain.client, plain.target)).contentDigest).toBe(result.contentDigest)
  })

  it('marks a message sent inside a thread, which never names a reply target', async () => {
    const f = fixture()
    f.replace({
      msgtype: 'm.text',
      body: 'side note',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' }
    } as IContent)
    const threaded = await readMatrixInvocation(f.client, f.target)
    expect(threaded.thread).toBe(true)
    expect(threaded.related).toBe(true)
    expect(threaded.content).not.toHaveProperty('replyTo')

    // A plain message, a reply and an edit are never marked as a thread.
    for (const content of [
      { msgtype: 'm.text', body: 'Hello' },
      { msgtype: 'm.text', body: 'And tomorrow?', 'm.relates_to': { 'm.in_reply_to': { event_id: '$answer' } } },
      { msgtype: 'm.text', body: '* fixed', 'm.relates_to': { rel_type: 'm.replace', event_id: '$earlier' } }
    ]) {
      f.replace(content as IContent)
      expect((await readMatrixInvocation(f.client, f.target)).thread).toBeUndefined()
    }
  })
})

it('projects a pure reply with the message it answers, still as related', async () => {
  const f = fixture()
  f.replace({
    msgtype: 'm.text',
    body: '> <@agent:test> Sunny\n\nAnd tomorrow?',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$answer' } }
  })

  const result = await readMatrixInvocation(f.client, f.target)

  expect(result.related).toBe(true)
  expect(result.content.replyTo).toBe('$answer')
  // The body stays the event's own: the request hash binds the message as sent.
  expect(result.content.body).toBe('> <@agent:test> Sunny\n\nAnd tomorrow?')
})

it.each([
  ['an edit', { rel_type: 'm.replace', event_id: '$question', 'm.in_reply_to': { event_id: '$answer' } }, undefined],
  [
    'a thread message',
    { rel_type: 'm.thread', event_id: '$root', 'm.in_reply_to': { event_id: '$answer' } },
    undefined
  ],
  ['a reply with another key', { 'm.in_reply_to': { event_id: '$answer' }, extra: true }, undefined],
  ['a reply to a non-event', { 'm.in_reply_to': { event_id: 'answer' } }, undefined],
  [
    'a reply whose clear relation names another message',
    { 'm.in_reply_to': { event_id: '$answer' } },
    { 'm.in_reply_to': { event_id: '$other' } }
  ],
  [
    'a reply hiding an edit outside the ciphertext',
    { 'm.in_reply_to': { event_id: '$answer' } },
    { rel_type: 'm.replace', event_id: '$question' }
  ],
  // Only the clear text names it: the server could have made a plain message a reply.
  ['a reply the ciphertext does not name', undefined, { 'm.in_reply_to': { event_id: '$answer' } }]
])('never projects a reply target for %s', async (_name, relation, wire) => {
  const f = fixture()
  f.replace({ msgtype: 'm.text', body: 'Hello', ...(relation ? { 'm.relates_to': relation } : {}) } as IContent)
  f.fetchRoomEvent.mockResolvedValue({
    type: EventType.RoomMessageEncrypted,
    room_id: f.target.roomId,
    event_id: f.target.eventId,
    sender: '@owner:test',
    origin_server_ts: Date.now(),
    content: wire ? { 'm.relates_to': wire } : {}
  })

  const result = await readMatrixInvocation(f.client, f.target)

  expect(result.related).toBe(true)
  expect(result.content).not.toHaveProperty('replyTo')
})

it('never projects a reply target for a local-path question, which keeps its turn marker', async () => {
  const f = fixture()
  const turn = '00000000-0000-4000-8000-31f949766961'
  f.replace({
    msgtype: 'm.text',
    body: 'And tomorrow?',
    'io.atum.turn': turn,
    'm.relates_to': { 'm.in_reply_to': { event_id: '$answer' } }
  })

  const result = await readMatrixInvocation(f.client, f.target)

  expect(result.content.turn).toBe(turn)
  expect(result.content).not.toHaveProperty('replyTo')
})

/**
 * A room without end-to-end encryption (every room since 0.20): its messages arrive as sent. The
 * room has no crypto to consult on this path, so the client below has none.
 */
function plainFixture(content: IContent = { msgtype: 'm.text', body: 'xin chào' }, sender = '@owner:test') {
  const bytes = new TextEncoder().encode('Plain Matrix file fixture')
  const target = { roomId: '!plain:test', eventId: '$plain' }
  const membership = vi.fn(() => 'join')
  const encrypted = vi.fn(() => false)
  // The crypto store's own record of the room (plain-room.ts): plain unless a test says not.
  const cryptoEncrypted = vi.fn(async (_roomId: string) => false)
  let current = content

  const fetchRoomEvent = vi.fn(async () => ({
    type: EventType.RoomMessage,
    room_id: target.roomId,
    event_id: target.eventId,
    sender,
    origin_server_ts: Date.now(),
    content: current
  }))

  const request = vi.fn(async () => new Blob([bytes]))
  const decryptEventIfNeeded = vi.fn()

  const client = {
    getRoom: () => ({ roomId: target.roomId, getMyMembership: membership, hasEncryptionStateEvent: encrypted }),
    getCrypto: vi.fn(() => ({ isEncryptionEnabledInRoom: cryptoEncrypted })),
    fetchRoomEvent,
    http: { authedRequest: request },
    decryptEventIfNeeded
  } as unknown as MatrixClient

  return {
    bytes,
    target,
    client,
    membership,
    encrypted,
    cryptoEncrypted,
    fetchRoomEvent,
    request,
    decryptEventIfNeeded,
    replace: (value: IContent) => {
      current = value
    }
  }
}

describe('a message from a room without end-to-end encryption (0.20)', () => {
  it('reads the owner’s text as sent: no decryption, the homeserver’s sender verified, the plain device', async () => {
    const f = plainFixture()
    const result = await readMatrixInvocation(f.client, f.target)

    expect(result).toMatchObject({
      wireType: EventType.RoomMessage,
      sender: '@owner:test',
      senderVerified: true,
      senderDevice: MATRIX_PLAIN_SENDER_DEVICE,
      related: false,
      content: { msgtype: 'm.text', body: 'xin chào' }
    })
    expect(result.senderFingerprint).toBeUndefined()
    expect(result.roomPlain).toBe(true)
    expect(matrixOwnerWireType(result.wireType)).toBe(true)
    expect(f.decryptEventIfNeeded).not.toHaveBeenCalled()
    expect(f.cryptoEncrypted).toHaveBeenCalledWith(f.target.roomId)
  })

  it('carries whoever sent it, so a caller answers only the owner (a group member is not the owner)', async () => {
    const f = plainFixture(
      { msgtype: 'm.text', body: '@Atum giúp tôi', 'm.mentions': { user_ids: ['@agent:test'] } },
      '@linh:test'
    )

    const result = await readMatrixInvocation(f.client, f.target)

    expect(result.sender).toBe('@linh:test')
    expect(result.content.mentionedUserIds).toEqual(['@agent:test'])
  })

  it('digests the content the way the origin assertion binds it, and carries the assertion', async () => {
    const origin = { v: 1, dsid: '00000000-0000-4000-8000-b86a6ca39e23', sig: 'x' }
    const content = { msgtype: 'm.text', body: 'Tạo file hello.txt', 'io.atum.origin': origin }
    const f = plainFixture(content)
    const result = await readMatrixInvocation(f.client, f.target)

    expect(result.contentDigest).toBe(requestDigestV2(content))
    expect(result.content.origin).toEqual(origin)
  })

  it.each(vectors().map(vector => [vector.name, vector] as const))(
    'digests a plain message exactly as the same content encrypted: %s',
    async (_name, vector) => {
      const f = plainFixture(vector.content)
      expect((await readMatrixInvocation(f.client, f.target)).contentDigest).toBe(vector.dg)
    }
  )

  it('reads a reply as a reply, with the message it answers', async () => {
    const f = plainFixture({
      msgtype: 'm.text',
      body: 'Còn ngày mai?',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$answer' } }
    })

    const result = await readMatrixInvocation(f.client, f.target)

    expect(result.related).toBe(true)
    expect(result.content.replyTo).toBe('$answer')
  })

  it('refuses an encrypted event where the room has no encryption', async () => {
    const f = plainFixture()
    f.fetchRoomEvent.mockResolvedValue({ ...(await f.fetchRoomEvent()), type: EventType.RoomMessageEncrypted })

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_untrusted')
  })

  it('refuses its plaintext once the room gains encryption while the event is read', async () => {
    const f = plainFixture()
    const read = f.fetchRoomEvent.getMockImplementation()!
    f.fetchRoomEvent.mockImplementation(async () => {
      const raw = await read()
      f.encrypted.mockReturnValue(true)

      return raw
    })

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_untrusted')
  })

  it('refuses a message in a room this account has left', async () => {
    const f = plainFixture()
    f.membership.mockReturnValue('leave')

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_encrypted_room_required')
    expect(f.fetchRoomEvent).not.toHaveBeenCalled()
  })

  it('reads a file by its plain URL without exporting it, then downloads it as is', async () => {
    const f = plainFixture({ msgtype: 'm.file', body: 'ghi-chu.txt', url: 'mxc://test/plain-id' })
    const first = await readMatrixInvocation(f.client, f.target)

    expect(first.content.attachment).toEqual({
      name: 'ghi-chu.txt',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(JSON.stringify(first)).not.toContain('mxc://')
    expect(f.request).not.toHaveBeenCalled()

    const result = await readMatrixInvocation(f.client, { ...f.target, includeAttachment: true })
    expect(result.attachmentBytes).toEqual(f.bytes)
    expect(f.request).toHaveBeenCalledWith(
      'GET',
      '/media/download/test/plain-id',
      undefined,
      undefined,
      expect.objectContaining({ prefix: '/_matrix/client/v1', rawResponseBody: true })
    )
  })

  it('never downloads a plain file from anywhere but the homeserver’s media', async () => {
    const f = plainFixture({ msgtype: 'm.file', body: 'file', url: 'https://elsewhere.test/secret' })

    await expect(readMatrixInvocation(f.client, { ...f.target, includeAttachment: true })).rejects.toThrow(
      'matrix_file_unavailable'
    )
    expect(f.request).not.toHaveBeenCalled()
  })
})

describe('an m.image (what the phone’s photo picker sends)', () => {
  it('reads an encrypted image like a file: the same name rule, fingerprint binding and bytes', async () => {
    const f = fixture()
    const asFile = await readMatrixInvocation(f.client, f.target)
    f.replace({
      msgtype: 'm.image',
      body: 'IMG_0001.jpg',
      filename: 'IMG_0001.jpg',
      file: f.file,
      info: { mimetype: 'image/jpeg', size: 12, w: 4, h: 3 }
    })

    const first = await readMatrixInvocation(f.client, f.target)
    expect(first.content.msgtype).toBe('m.image')
    expect(first.content.attachment).toEqual({
      name: 'IMG_0001.jpg',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    // The fingerprint binds the media descriptor alone: the same media, the same fingerprint.
    expect(first.content.attachment!.fingerprint).toBe(asFile.content.attachment!.fingerprint)
    expect(JSON.stringify(first)).not.toContain('mxc://')
    expect(JSON.stringify(first)).not.toContain(f.file.key.k)
    expect(f.request).not.toHaveBeenCalled()

    const result = await readMatrixInvocation(f.client, { ...f.target, includeAttachment: true })
    expect(result.attachmentBytes).toEqual(f.bytes)
  })

  it('names the image by its body when it has no filename', async () => {
    const f = fixture()
    f.replace({ msgtype: 'm.image', body: 'IMG_0002.heic', file: f.file })
    expect((await readMatrixInvocation(f.client, f.target)).content.attachment?.name).toBe('IMG_0002.heic')
  })

  it.each([['an empty filename', ''], ['a 256-character filename', 'x'.repeat(256)]])(
    'refuses an image with %s',
    async (_label, filename) => {
      const f = fixture()
      f.replace({ msgtype: 'm.image', body: 'photo', filename, file: f.file })
      await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_invalid')
    }
  )

  it('refuses an image in an encrypted room that names only a plain URL (no downgrade)', async () => {
    const f = fixture()
    f.replace({ msgtype: 'm.image', body: 'IMG.jpg', url: 'mxc://test/plain-id' })

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_invalid')
    expect(f.request).not.toHaveBeenCalled()
  })

  it.each(['m.video', 'm.audio'])('still refuses %s, even with encrypted media', async msgtype => {
    const f = fixture()
    f.replace({ msgtype, body: 'clip.mp4', file: f.file })

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_invalid')
  })

  it('reads a plain-room image by its plain URL without exporting it, then downloads it as is', async () => {
    const f = plainFixture({ msgtype: 'm.image', body: 'IMG_0003.jpg', url: 'mxc://test/plain-id' })
    const first = await readMatrixInvocation(f.client, f.target)

    expect(first.content.msgtype).toBe('m.image')
    expect(first.content.attachment).toEqual({
      name: 'IMG_0003.jpg',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(JSON.stringify(first)).not.toContain('mxc://')
    expect(f.request).not.toHaveBeenCalled()

    const result = await readMatrixInvocation(f.client, { ...f.target, includeAttachment: true })
    expect(result.attachmentBytes).toEqual(f.bytes)
  })

  it('never downloads a plain image from anywhere but the homeserver’s media', async () => {
    const f = plainFixture({ msgtype: 'm.image', body: 'img', url: 'https://elsewhere.test/secret' })

    await expect(readMatrixInvocation(f.client, { ...f.target, includeAttachment: true })).rejects.toThrow(
      'matrix_file_unavailable'
    )
    expect(f.request).not.toHaveBeenCalled()
  })

  it('refuses a plain-room m.video even with a plain URL', async () => {
    const f = plainFixture({ msgtype: 'm.video', body: 'clip.mp4', url: 'mxc://test/plain-id' })

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_invalid')
  })
})

describe('no downgrade in a room whose encryption state has not synced yet', () => {
  // After a restart, a lagging sync or a new join, an encrypted room can show no encryption
  // state while the crypto store already knows it is encrypted. Plaintext injected there is never
  // a plain message: not text, not a plain file URL.
  it('refuses plaintext when the crypto store says the room is encrypted', async () => {
    const f = plainFixture()
    f.cryptoEncrypted.mockResolvedValue(true)

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_untrusted')
    expect(f.decryptEventIfNeeded).not.toHaveBeenCalled()
  })

  it('refuses a plain file URL there, and never downloads it', async () => {
    const f = plainFixture({ msgtype: 'm.file', body: 'ghi-chu.txt', url: 'mxc://test/plain-id' })
    f.cryptoEncrypted.mockResolvedValue(true)

    await expect(readMatrixInvocation(f.client, { ...f.target, includeAttachment: true })).rejects.toThrow(
      'matrix_invocation_untrusted'
    )
    expect(f.request).not.toHaveBeenCalled()
  })

  it('never reads plaintext when the crypto store cannot answer, or there is none, and fails the read to be retried', async () => {
    // Not a refusal of the message ("untrusted"): the caller's ordinary retry applies.
    const failing = plainFixture()
    failing.cryptoEncrypted.mockRejectedValue(new Error('store closed'))
    await expect(readMatrixInvocation(failing.client, failing.target)).rejects.toThrow('matrix_operation_failed')

    const none = plainFixture()
    vi.mocked(none.client.getCrypto).mockReturnValue(undefined)
    await expect(readMatrixInvocation(none.client, none.target)).rejects.toThrow('matrix_operation_failed')
  })

  it('fails the read, to be retried, when the crypto store does not answer in time', async () => {
    const silent = plainFixture()
    silent.cryptoEncrypted.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const read = readMatrixInvocation(silent.client, silent.target)
      read.catch(() => {})
      await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)
      await expect(read).rejects.toThrow('matrix_operation_failed')
    } finally {
      vi.useRealTimers()
    }

    // Asked again once the store answers: the plain message reads as sent.
    silent.cryptoEncrypted.mockResolvedValue(false)
    await expect(readMatrixInvocation(silent.client, silent.target)).resolves.toMatchObject({
      wireType: 'm.room.message'
    })
  })

  it('refuses plaintext read before the crypto store learned the room is encrypted', async () => {
    const f = plainFixture()
    const read = f.fetchRoomEvent.getMockImplementation()!
    f.fetchRoomEvent.mockImplementation(async () => {
      const raw = await read()
      f.cryptoEncrypted.mockResolvedValue(true)

      return raw
    })

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_untrusted')
  })
})

describe('no downgrade in a room with end-to-end encryption', () => {
  it('refuses a plaintext event there, without trying to decrypt it', async () => {
    const f = fixture()
    f.fetchRoomEvent.mockResolvedValue({
      type: EventType.RoomMessage,
      room_id: f.target.roomId,
      event_id: f.target.eventId,
      sender: '@owner:test',
      origin_server_ts: Date.now(),
      content: { msgtype: 'm.text', body: 'xin chào' }
    })

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_untrusted')
    expect(f.decryptEventIfNeeded).not.toHaveBeenCalled()
  })

  it('never takes a plain file URL inside an encrypted message', async () => {
    const f = fixture()
    f.replace({ msgtype: 'm.file', body: 'file', url: 'mxc://test/plain-id' })

    await expect(readMatrixInvocation(f.client, f.target)).rejects.toThrow('matrix_invocation_invalid')
    expect(f.request).not.toHaveBeenCalled()
  })

  it('reads an encrypted message with its sending device as before', async () => {
    const f = fixture()
    f.replace({ msgtype: 'm.text', body: 'Hello' })
    const result = await readMatrixInvocation(f.client, f.target)

    expect(result).toMatchObject({
      wireType: EventType.RoomMessageEncrypted,
      senderDevice: 'DEVICE',
      senderVerified: true
    })
    expect(result.senderFingerprint).toBe('ed')
    expect(matrixOwnerWireType(result.wireType)).toBe(true)
  })
})
