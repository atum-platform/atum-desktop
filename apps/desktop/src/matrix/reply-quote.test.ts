// @vitest-environment node
import { EventType, type IContent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk'
import { EventShieldColour } from 'matrix-js-sdk/lib/crypto-api'
import { expect, it, vi } from 'vitest'

import { PLAIN_ANSWER_MS } from './plain-room'
import { readMatrixReplyQuote } from './reply-quote'

const OWNER = '@owner:test'
const AGENT = '@agent:test'

function fixture() {
  const target = { roomId: '!room:test', eventId: '$answer', ownerId: OWNER, agentId: AGENT }
  let sender = AGENT
  let content: IContent = { msgtype: 'm.text', body: 'Sunny in Huế.' }
  let failure = false

  const device = (deviceId: string) => ({ deviceId, getIdentityKey: () => 'curve', getFingerprint: () => 'ed' })

  const crypto = {
    getUserDeviceInfo: vi.fn(
      async () =>
        new Map([
          [OWNER, new Map([['PHONE', device('PHONE')]])],
          [AGENT, new Map([['AGENT', device('AGENT')]])]
        ])
    ),
    getDeviceVerificationStatus: vi.fn(async () => ({ isVerified: (): boolean => true })),
    getEncryptionInfoForEvent: vi.fn(async () => ({ shieldColour: EventShieldColour.NONE, shieldReason: null })),
    // The crypto store's own record of the room (plain-room.ts).
    isEncryptionEnabledInRoom: vi.fn(async (_roomId: string) => true)
  }

  const raw = (fields: Record<string, unknown> = {}) => ({
    type: EventType.RoomMessageEncrypted,
    room_id: target.roomId,
    event_id: target.eventId,
    sender,
    origin_server_ts: 1_000,
    content: {},
    ...fields
  })

  const fetchRoomEvent = vi.fn(async (_roomId: string, _eventId: string): Promise<Record<string, unknown>> => raw())

  const decryptEventIfNeeded = vi.fn(async (event: MatrixEvent) => {
    vi.spyOn(event, 'getType').mockReturnValue(EventType.RoomMessage)
    vi.spyOn(event, 'getContent').mockImplementation(() => content)
    vi.spyOn(event, 'getSenderKey').mockReturnValue('curve')
    vi.spyOn(event, 'getClaimedEd25519Key').mockReturnValue('ed')
    vi.spyOn(event, 'isDecryptionFailure').mockReturnValue(failure)
  })

  const client = {
    getUserId: () => OWNER,
    getRoom: vi.fn(() => ({ getMyMembership: (): string => 'join', hasEncryptionStateEvent: (): boolean => true })),
    getCrypto: () => crypto,
    fetchRoomEvent,
    decryptEventIfNeeded
  }

  return {
    target,
    client,
    crypto,
    raw,
    fetchRoomEvent,
    decryptEventIfNeeded,
    read: (override: Partial<typeof target> & { anyMember?: true } = {}) =>
      readMatrixReplyQuote(client as unknown as MatrixClient, { ...target, ...override }),
    from: (value: string) => {
      sender = value
    },
    content: (value: IContent) => {
      content = value
    },
    undecryptable: () => {
      failure = true
    }
  }
}

it("quotes the agent's answer without its rich-reply fallback, and never fetches the message it answers", async () => {
  const f = fixture()
  f.content({
    msgtype: 'm.text',
    body: '> <@owner:test> Weather in Huế?\n\nSunny in Huế.',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } },
    'io.atum.result': { invocation: 'i', transaction: 't' }
  })

  await expect(f.read()).resolves.toEqual({
    state: 'message',
    eventId: '$answer',
    sender: AGENT,
    text: 'Sunny in Huế.'
  })
  expect(f.fetchRoomEvent).toHaveBeenCalledExactlyOnceWith('!room:test', '$answer')
})

it('quotes a long answer (or one part of a split one) up to the message bound, and nothing longer', async () => {
  const f = fixture()
  const long = 'A long answer line.\n'.repeat(1500)
  expect(long.length).toBeGreaterThan(16_000)
  f.content({ msgtype: 'm.text', body: long, 'io.atum.result': { invocation: 'i', transaction: 't' } })
  await expect(f.read()).resolves.toMatchObject({ state: 'message', eventId: '$answer', sender: AGENT, text: long })

  f.content({ msgtype: 'm.text', body: 'x'.repeat(40_000) })
  await expect(f.read()).resolves.toEqual({ state: 'none' })
})

it("keeps an answer's own leading blockquote: the assistant's Markdown is not a fallback", async () => {
  const f = fixture()
  const body = '> Can I ship on Friday?\n\nNo: migration 0148 must land first.'
  f.content({ msgtype: 'm.text', body, 'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } } })

  await expect(f.read()).resolves.toEqual({ state: 'message', eventId: '$answer', sender: AGENT, text: body })
})

it('quotes an earlier question of the owner, local-path marker and all', async () => {
  const f = fixture()
  f.from(OWNER)
  f.content({ msgtype: 'm.text', body: 'Plan two days in Huế', 'io.atum.turn': '00000000-0000-4000-8000-31f949766961' })

  await expect(f.read()).resolves.toEqual({
    state: 'message',
    eventId: '$answer',
    sender: OWNER,
    text: 'Plan two days in Huế'
  })
})

it('never quotes a message from anyone but the owner and the room agent', async () => {
  const f = fixture()
  f.from('@stranger:test')

  await expect(f.read()).resolves.toEqual({ state: 'none' })
  expect(f.decryptEventIfNeeded).not.toHaveBeenCalled()
})

it('reads the reply’s own room only and refuses an event the server places in another room', async () => {
  const f = fixture()
  f.fetchRoomEvent.mockResolvedValue(f.raw({ room_id: '!other:test' }))

  await expect(f.read()).resolves.toEqual({ state: 'none' })
  expect(f.fetchRoomEvent).toHaveBeenCalledExactlyOnceWith('!room:test', '$answer')

  f.client.getRoom.mockReturnValue({ getMyMembership: () => 'leave', hasEncryptionStateEvent: () => true })
  f.fetchRoomEvent.mockClear()
  await expect(f.read()).resolves.toEqual({ state: 'none' })
  expect(f.fetchRoomEvent).not.toHaveBeenCalled()
})

it('never quotes a deleted message', async () => {
  const f = fixture()
  f.fetchRoomEvent.mockResolvedValue(
    f.raw({ unsigned: { redacted_because: { type: EventType.RoomRedaction, sender: AGENT, content: {} } } })
  )

  await expect(f.read()).resolves.toEqual({ state: 'none' })
  expect(f.decryptEventIfNeeded).not.toHaveBeenCalled()
})

it('asks again later for a message it cannot decrypt yet, and never returns its content', async () => {
  const f = fixture()
  f.undecryptable()

  await expect(f.read()).resolves.toEqual({ state: 'pending' })

  const other = fixture()
  other.decryptEventIfNeeded.mockRejectedValue(new Error('no keys yet'))
  await expect(other.read()).resolves.toEqual({ state: 'pending' })
})

it('tells a missing event from a passing failure to fetch it', async () => {
  const f = fixture()
  f.fetchRoomEvent.mockRejectedValueOnce(Object.assign(new Error('not found'), { errcode: 'M_NOT_FOUND' }))
  await expect(f.read()).resolves.toEqual({ state: 'none' })
  f.fetchRoomEvent.mockRejectedValueOnce(new Error('offline'))
  await expect(f.read()).resolves.toEqual({ state: 'pending' })
})

it.each([
  [
    'an unverified device',
    (f: ReturnType<typeof fixture>) =>
      f.crypto.getDeviceVerificationStatus.mockResolvedValue({ isVerified: () => false })
  ],
  [
    'a plaintext event',
    (f: ReturnType<typeof fixture>) =>
      f.fetchRoomEvent.mockResolvedValue(
        f.raw({ type: EventType.RoomMessage, content: { msgtype: 'm.text', body: 'forged' } })
      )
  ],
  [
    'an edit',
    (f: ReturnType<typeof fixture>) =>
      f.content({
        msgtype: 'm.text',
        body: '* new',
        'm.new_content': { msgtype: 'm.text', body: 'new' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$q' }
      })
  ],
  [
    'an edit marked outside the ciphertext',
    (f: ReturnType<typeof fixture>) =>
      f.fetchRoomEvent.mockResolvedValue(
        f.raw({ content: { 'm.relates_to': { rel_type: 'm.replace', event_id: '$q' } } })
      )
  ],
  ['a message without words', (f: ReturnType<typeof fixture>) => f.content({ msgtype: 'm.text', body: '   ' })],
  [
    'another event id',
    (f: ReturnType<typeof fixture>) => f.fetchRoomEvent.mockResolvedValue(f.raw({ event_id: '$other' }))
  ]
])('never quotes %s', async (_name, arrange) => {
  const f = fixture()
  arrange(f)

  await expect(f.read()).resolves.toEqual({ state: 'none' })
})

it('reads only as the room’s owner or its agent, for a room with a distinct agent', async () => {
  const f = fixture()

  await expect(f.read({ ownerId: '@someone:test' })).resolves.toEqual({ state: 'none' })
  await expect(f.read({ agentId: OWNER })).resolves.toEqual({ state: 'none' })
  expect(f.fetchRoomEvent).not.toHaveBeenCalled()
})

it("reads as the agent too (the cloud brain holds only the agent's keys), by the same rules", async () => {
  const f = fixture()
  f.client.getUserId = () => AGENT
  f.from(OWNER)
  f.content({ msgtype: 'm.text', body: 'Plan two days in Huế' })

  await expect(f.read()).resolves.toEqual({ state: 'message', eventId: '$answer', sender: OWNER, text: 'Plan two days in Huế' })
  f.from('@stranger:test')
  await expect(f.read()).resolves.toEqual({ state: 'none' })
})

/** The same fixture in a room without end-to-end encryption (every chat since 0.20). */
function plainFixture() {
  const f = fixture()
  let encrypted = false
  f.crypto.isEncryptionEnabledInRoom.mockImplementation(async () => encrypted)
  f.client.getRoom.mockImplementation(() => ({
    roomId: f.target.roomId,
    getMyMembership: () => 'join',
    hasEncryptionStateEvent: () => encrypted
  }))
  f.fetchRoomEvent.mockImplementation(async () =>
    f.raw({ type: EventType.RoomMessage, content: { msgtype: 'm.text', body: 'Sunny in Huế.' } })
  )

  return {
    ...f,
    encrypt: () => {
      encrypted = true
    }
  }
}

it('quotes the owner’s and the agent’s plain messages with no device check', async () => {
  const agent = plainFixture()
  await expect(agent.read()).resolves.toEqual({
    state: 'message',
    eventId: '$answer',
    sender: AGENT,
    text: 'Sunny in Huế.'
  })
  expect(agent.decryptEventIfNeeded).not.toHaveBeenCalled()
  expect(agent.crypto.getDeviceVerificationStatus).not.toHaveBeenCalled()

  const owner = plainFixture()
  owner.from(OWNER)
  owner.fetchRoomEvent.mockImplementation(async () =>
    owner.raw({ type: EventType.RoomMessage, content: { msgtype: 'm.text', body: 'Weather?' } })
  )
  await expect(owner.read()).resolves.toEqual({ state: 'message', eventId: '$answer', sender: OWNER, text: 'Weather?' })
})

it('still quotes only the owner or the agent in a plain room, and anyone in a plain group as verified', async () => {
  const f = plainFixture()
  f.from('@stranger:test')
  f.fetchRoomEvent.mockImplementation(async () =>
    f.raw({ type: EventType.RoomMessage, content: { msgtype: 'm.text', body: 'Hi' } })
  )
  await expect(f.read()).resolves.toEqual({ state: 'none' })
  // A group turn may quote anyone there; the homeserver authenticated who sent it.
  await expect(f.read({ anyMember: true })).resolves.toEqual({
    state: 'message',
    eventId: '$answer',
    sender: '@stranger:test',
    text: 'Hi',
    verified: true
  })
})

it('never quotes a ciphertext in a plain room, or a plaintext once the room turns encryption on', async () => {
  const cipher = plainFixture()
  cipher.fetchRoomEvent.mockImplementation(async () => cipher.raw())
  await expect(cipher.read()).resolves.toEqual({ state: 'none' })

  const turned = plainFixture()
  turned.fetchRoomEvent.mockImplementation(async () => {
    turned.encrypt()

    return turned.raw({ type: EventType.RoomMessage, content: { msgtype: 'm.text', body: 'Sunny in Huế.' } })
  })
  await expect(turned.read()).resolves.toEqual({ state: 'none' })
})

it('never quotes a plaintext in a room the crypto store knows is encrypted, though its state has not synced', async () => {
  const f = plainFixture()
  f.crypto.isEncryptionEnabledInRoom.mockResolvedValue(true)
  await expect(f.read()).resolves.toEqual({ state: 'none' })
  expect(f.crypto.isEncryptionEnabledInRoom).toHaveBeenCalledWith(f.target.roomId)
})

// No answer from the crypto store in time is "not yet" (main asks again), never "no quote", which
// would post a held-reply notice and leave a plain reply unanswered.
it('answers "not yet" while the crypto store has not answered, and quotes the plain message once it does', async () => {
  const f = plainFixture()
  f.crypto.isEncryptionEnabledInRoom.mockReturnValue(new Promise<boolean>(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const read = f.read()
    await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)
    await expect(read).resolves.toEqual({ state: 'pending' })
  } finally {
    vi.useRealTimers()
  }

  f.crypto.isEncryptionEnabledInRoom.mockResolvedValue(false)
  await expect(f.read()).resolves.toMatchObject({ state: 'message', text: 'Sunny in Huế.' })
})

it('never quotes a plaintext message in an encrypted room (no downgrade)', async () => {
  const f = fixture()
  f.fetchRoomEvent.mockImplementation(async () =>
    f.raw({ type: EventType.RoomMessage, content: { msgtype: 'm.text', body: 'forged' } })
  )
  await expect(f.read()).resolves.toEqual({ state: 'none' })
  await expect(f.read({ anyMember: true })).resolves.toEqual({ state: 'none' })
})
