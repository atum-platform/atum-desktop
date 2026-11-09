// @vitest-environment node
import { Direction, EventType, type IContent, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk'
import { EventShieldColour } from 'matrix-js-sdk/lib/crypto-api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { MATRIX_CONTINUITY } from '../../shared/matrix-continuity'
import { canResumeConversation, conversationAnchor } from '../../shared/matrix-continuity-seed'

import { readMatrixContinuity } from './continuity'
import { PLAIN_ANSWER_MS } from './plain-room'

const target = { roomId: '!room:test', ownerId: '@owner:test', agentId: '@agent:test' }
const invocation = '00000000-0000-4000-8000-bd7662a5eeb4'
const turn = '00000000-0000-4000-8000-b454f82c5857'

function wire(id: string, sender = target.ownerId, content: IContent = { msgtype: 'm.text', body: id }) {
  return { event_id: id, sender, room_id: target.roomId, type: EventType.RoomMessageEncrypted, content }
}

const answer = (id = '$answer') =>
  wire(id, target.agentId, {
    msgtype: 'm.text',
    body: '> <@owner:test> quoted request\n\nAnswer',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } },
    'io.atum.result': { invocation }
  })

function fixture() {
  const state = [
    { type: EventType.RoomCreate, state_key: '', content: { type: MATRIX_ASSISTANT_ROOM_TYPE } },
    { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
    ...[target.ownerId, target.agentId].map(state_key => ({
      type: EventType.RoomMember,
      state_key,
      content: { membership: 'join' }
    }))
  ]

  const crypto = {
    getUserDeviceInfo: vi.fn(
      async () =>
        new Map(
          [target.ownerId, target.agentId].map(id => [
            id,
            new Map([['DEVICE', { deviceId: 'DEVICE', getIdentityKey: () => 'curve', getFingerprint: () => 'ed' }]])
          ])
        )
    ),
    getDeviceVerificationStatus: vi.fn(async () => ({ isVerified: (): boolean => true })),
    getEncryptionInfoForEvent: vi.fn(async () => ({ shieldColour: EventShieldColour.NONE, shieldReason: null })),
    // The crypto store's own record (plain-room.ts): as synced, unless `stored` says otherwise.
    isEncryptionEnabledInRoom: vi.fn(async () => stored.encrypted ?? synced.encrypted)
  }

  const stored: { encrypted?: boolean } = {}
  const roomState = vi.fn(async () => state)

  const pages = vi.fn(
    async (
      _room: string,
      _from: string | null,
      _limit: number,
      _direction: Direction
    ): Promise<{ chunk: ReturnType<typeof wire>[]; end?: string }> => ({
      chunk: [wire('$current'), answer(), wire('$question')]
    })
  )

  const decrypt = vi.fn(async (event: MatrixEvent) => {
    vi.spyOn(event, 'getType').mockReturnValue(EventType.RoomMessage)
    vi.spyOn(event, 'getSenderKey').mockReturnValue('curve')
    vi.spyOn(event, 'getClaimedEd25519Key').mockReturnValue('ed')
  })

  // The room as this client has synced it; `encrypted` false is a 0.20 plain agent room.
  const synced = { encrypted: true }

  const room = {
    roomId: target.roomId,
    getMyMembership: () => 'join',
    hasEncryptionStateEvent: () => synced.encrypted,
    getType: () => MATRIX_ASSISTANT_ROOM_TYPE,
    currentState: { getStateEvents: () => null }
  }

  const client = {
    getUserId: () => target.ownerId,
    getRoom: () => room,
    roomState,
    getCrypto: () => crypto,
    createMessagesRequest: pages,
    decryptEventIfNeeded: decrypt
  } as unknown as MatrixClient

  return { client, crypto, state, roomState, pages, decrypt, synced, stored }
}

/** The same room made the 0.20 way: no encryption state, history from invitation. */
function plainFixture() {
  const f = fixture()
  f.synced.encrypted = false
  f.state.splice(
    f.state.findIndex(event => event.type === EventType.RoomEncryption),
    1
  )
  f.state.find(event => event.type === EventType.RoomHistoryVisibility)!.content = { history_visibility: 'invited' }
  f.pages.mockResolvedValue({
    chunk: [plainWire('$current'), { ...answer(), type: EventType.RoomMessage }, plainWire('$question')]
  })

  return f
}

function plainWire(id: string, sender = target.ownerId, content: IContent = { msgtype: 'm.text', body: id }) {
  return { ...wire(id, sender, content), type: EventType.RoomMessage }
}

afterEach(() => vi.useRealTimers())

it('reads fresh encrypted verified dialogue before this question, strips quote fallback and rechecks the private room', async () => {
  const f = fixture()
  const result = await readMatrixContinuity(f.client, { ...target, before: '$current' })
  expect(result).toEqual({
    ...target,
    entries: [
      { eventId: '$answer', role: 'assistant', text: 'Answer', invocationId: invocation },
      { eventId: '$question', role: 'user', text: '$question' }
    ],
    reachedStop: true,
    gaps: 0,
    uncertainAgent: false
  })
  expect(f.pages).toHaveBeenCalledWith(target.roomId, null, 50, Direction.Backward)
  expect(f.roomState).toHaveBeenCalledTimes(2)
  expect(f.decrypt).toHaveBeenCalledTimes(2)
})

it('follows pagination even across an empty page and stops only after reading its trusted anchor', async () => {
  const f = fixture()
  f.pages
    .mockResolvedValueOnce({ chunk: [], end: 'one' })
    .mockResolvedValueOnce({ chunk: [answer(), wire('$question')], end: 'two' })
  const result = await readMatrixContinuity(f.client, { ...target, stopAt: '$answer' })
  expect(result.reachedStop).toBe(true)
  expect(result.entries.map(e => e.eventId)).toEqual(['$answer'])
  expect(f.pages).toHaveBeenLastCalledWith(target.roomId, 'one', 50, Direction.Backward)
})

it('does not include the current local turn, plaintext, third parties, edits, files or unknown agent text', async () => {
  const f = fixture()
  f.pages.mockResolvedValue({
    chunk: [
      wire('$own', target.ownerId, { msgtype: 'm.text', body: 'current', 'io.atum.turn': turn }),
      { ...wire('$plain'), type: EventType.RoomMessage },
      wire('$stranger', '@third:test'),
      wire('$edit', target.ownerId, {
        msgtype: 'm.text',
        body: 'edited',
        'm.relates_to': { rel_type: 'm.replace', event_id: '$old' }
      }),
      wire('$file', target.ownerId, { msgtype: 'm.file', body: 'private file' }),
      wire('$unknown', target.agentId),
      answer()
    ]
  })
  const result = await readMatrixContinuity(f.client, { ...target, excludeTurn: turn })
  expect(result.entries.map(e => e.eventId)).toEqual(['$answer'])
  expect(result.uncertainAgent).toBe(true)
  expect(result.gaps).toBe(4)
})

it("reads past the agent's notice about a held reply: a status line, never unknown agent text", async () => {
  const f = fixture()
  f.pages.mockResolvedValue({
    chunk: [
      wire('$notice', target.agentId, {
        msgtype: 'm.notice',
        body: 'I couldn’t read the message you replied to — could you say it again?',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$held' } }
      }),
      wire('$held', target.ownerId, {
        msgtype: 'm.text',
        body: 'Yes, do it',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$unreadable' } }
      }),
      answer()
    ]
  })

  // The conversation stays resumable: the notice is neither a turn nor another session's answer.
  const result = await readMatrixContinuity(f.client, { ...target, stopAt: '$answer' })
  expect(result.entries.map(e => e.eventId)).toEqual(['$held', '$answer'])
  expect(result.uncertainAgent).toBe(false)
  expect(result.reachedStop).toBe(true)
})

it('reads past the agent\u2019s status line about a failed message: the stored session stays resumable', async () => {
  const f = fixture()
  const statusInvocation = '00000000-0000-4000-8000-f6222a1106ee'

  const status = (id: string, code: string, invocationId = statusInvocation, sender = target.agentId) =>
    wire(id, sender, {
      msgtype: 'm.text',
      body: 'I could not confirm that finished.',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$failed' } },
      'io.atum.result': { invocation: invocationId, status: code }
    })

  f.pages.mockResolvedValue({
    chunk: [
      wire('$next'),
      status('$notice', 'couldnt_confirm'),
      // The Mac that did not dispatch posts under a transaction ID, not a fence: still a status line.
      status('$other-mac', 'failed', '00000000-0000-4000-8000-f1d11edf5c5c'),
      wire('$failed'),
      answer(),
      wire('$question')
    ]
  })

  const read = await readMatrixContinuity(f.client, { ...target, before: '$next' })
  expect(read.entries.map(e => e.eventId)).toEqual(['$failed', '$answer', '$question'])
  expect(read.uncertainAgent).toBe(false)
  expect(read.gaps).toBe(0)
  // Only completed runs are the session's: the witness knows the answer, never the notices.
  expect(canResumeConversation({ anchor: '$answer', ours: [invocation] }, read)).toBe(true)
  expect(conversationAnchor(read)).toBe('$answer')

  // Another sender cannot pass as one, and a status line without a closed code is not one.
  f.pages.mockResolvedValue({
    chunk: [
      wire('$next'),
      status('$forged', 'couldnt_confirm', statusInvocation, target.ownerId),
      status('$open', 'made_up_code'),
      answer()
    ]
  })

  const forged = await readMatrixContinuity(f.client, { ...target, before: '$next' })
  expect(forged.entries.map(e => e.eventId)).toEqual(['$forged', '$open', '$answer'])
  expect(forged.entries[0]!.role).toBe('user')
  expect(forged.uncertainAgent).toBe(false)
  expect(canResumeConversation({ anchor: '$answer', ours: [invocation] }, forged)).toBe(false)
})

it('skips only the agent’s closing notices: an answer that carries a status code is still an answer', async () => {
  const f = fixture()

  // A cloud answer carries `saved_to_drive` (and the other answer codes) beside its real text
  // (cloud-controller contract ANSWER_STATUS_CODES); `resuming_on_device` is progress, not a close.
  const carrying = (id: string, code: string, invocationId: string) =>
    wire(id, target.agentId, {
      msgtype: 'm.text',
      body: `Here is the file. (${code})`,
      'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } },
      'io.atum.result': { invocation: invocationId, status: code }
    })

  const notice = (id: string, code: string) =>
    wire(id, target.agentId, {
      msgtype: 'm.text',
      body: 'I could not finish.',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$question' } },
      'io.atum.result': { invocation: '00000000-0000-4000-8000-fbfe405ca65f', status: code }
    })

  const answerCodes = ['saved_to_drive', 'saved_as_copy', 'save_unconfirmed', 'memory_not_saved']

  f.pages.mockResolvedValue({
    chunk: [
      wire('$next'),
      ...answerCodes.map((code, index) =>
        carrying(`$answer-${index}`, code, `6666666${index}-6666-4666-8666-666666666666`)
      ),
      carrying('$progress', 'resuming_on_device', '00000000-0000-4000-8000-f2da1f9533d4'),
      wire('$question')
    ]
  })

  const kept = await readMatrixContinuity(f.client, { ...target, before: '$next' })
  expect(kept.entries.map(e => e.eventId)).toEqual([
    ...answerCodes.map((_, index) => `$answer-${index}`),
    '$progress',
    '$question'
  ])
  expect(kept.entries.filter(e => e.eventId !== '$question').every(e => e.role === 'assistant')).toBe(true)

  // Every code that closes a message without an answer is still read past.
  const closing = ['stopped', 'failed', 'deadline', 'couldnt_confirm', 'unfunded', 'trial_expired', 'queue_full']

  f.pages.mockResolvedValue({
    chunk: [wire('$next'), ...closing.map(code => notice(`$notice-${code}`, code)), answer(), wire('$question')]
  })

  const skipped = await readMatrixContinuity(f.client, { ...target, before: '$next' })
  expect(skipped.entries.map(e => e.eventId)).toEqual(['$answer', '$question'])
  expect(skipped.uncertainAgent).toBe(false)
})

it.each(['unverified', 'wrong-key', 'decrypt', 'redacted'])(
  'omits %s history and marks an agent gap instead of treating it as a usable session witness',
  async mode => {
    const f = fixture()

    if (mode === 'unverified') {
      f.crypto.getDeviceVerificationStatus.mockResolvedValue({ isVerified: () => false })
    }

    if (mode === 'decrypt') {
      f.decrypt.mockRejectedValue(new Error('keys missing'))
    }

    if (mode === 'wrong-key' || mode === 'redacted') {
      const original = f.decrypt.getMockImplementation()!
      f.decrypt.mockImplementation(async event => {
        await original(event)

        if (mode === 'wrong-key') {
          vi.spyOn(event, 'getClaimedEd25519Key').mockReturnValue('wrong')
        } else {
          vi.spyOn(event, 'isRedacted').mockReturnValue(true)
        }
      })
    }

    const result = await readMatrixContinuity(f.client, { ...target, before: '$current' })
    expect(result.entries).toEqual([])
    expect(result.gaps).toBe(2)
    expect(result.uncertainAgent).toBe(true)
  }
)

it('fails closed on absent current event, changed membership, failed fetch or looping cursor', async () => {
  const f = fixture()
  await expect(readMatrixContinuity(f.client, { ...target, before: '$missing' })).rejects.toThrow(
    'continuity_unavailable'
  )
  f.pages.mockRejectedValueOnce(new Error('network'))
  await expect(readMatrixContinuity(f.client, target)).rejects.toThrow('network')
  f.pages.mockResolvedValue({ chunk: [], end: 'loop' })
  await expect(readMatrixContinuity(f.client, target)).rejects.toThrow('continuity_unavailable')
  f.pages.mockResolvedValue({ chunk: [answer()] })
  f.roomState.mockResolvedValueOnce(f.state).mockResolvedValueOnce(f.state.slice(0, -1))
  await expect(readMatrixContinuity(f.client, target)).rejects.toThrow('private_assistant_room_required')
})

it('enforces page and elapsed-time caps with no unbounded background pagination', async () => {
  const f = fixture()
  let page = 0
  f.pages.mockImplementation(async () => ({ chunk: [], end: `page-${++page}` }))
  expect((await readMatrixContinuity(f.client, target)).reachedStop).toBe(false)
  expect(f.pages).toHaveBeenCalledTimes(MATRIX_CONTINUITY.pages)
  vi.useFakeTimers()
  let complete!: (value: { chunk: ReturnType<typeof wire>[] }) => void
  f.pages.mockImplementation(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  const pending = readMatrixContinuity(f.client, target)
  const rejected = expect(pending).rejects.toThrow('continuity_unavailable')
  await vi.advanceTimersByTimeAsync(MATRIX_CONTINUITY.deadlineMs)
  await rejected
  complete({ chunk: [answer()] })
  await Promise.resolve()
  expect(f.pages).toHaveBeenCalledTimes(MATRIX_CONTINUITY.pages + 1)
})

describe('the agent\u2019s plain chat (0.20)', () => {
  it('reads the owner\u2019s and the agent\u2019s plain messages like decrypted ones, with no device check', async () => {
    const f = plainFixture()
    const result = await readMatrixContinuity(f.client, { ...target, before: '$current' })
    expect(result).toEqual({
      ...target,
      entries: [
        { eventId: '$answer', role: 'assistant', text: 'Answer', invocationId: invocation },
        { eventId: '$question', role: 'user', text: '$question' }
      ],
      reachedStop: true,
      gaps: 0,
      uncertainAgent: false
    })
    expect(f.decrypt).not.toHaveBeenCalled()
    expect(f.crypto.getDeviceVerificationStatus).not.toHaveBeenCalled()
  })

  it('counts a ciphertext in a plain room as a gap, never as an entry', async () => {
    const f = plainFixture()
    f.pages.mockResolvedValue({ chunk: [wire('$locked', target.agentId), plainWire('$question')] })
    const result = await readMatrixContinuity(f.client, target)
    expect(result.entries.map(entry => entry.eventId)).toEqual(['$question'])
    expect(result.gaps).toBe(1)
    expect(result.uncertainAgent).toBe(true)
  })

  it('still leaves out third parties and unknown agent text', async () => {
    const f = plainFixture()
    f.pages.mockResolvedValue({ chunk: [plainWire('$stranger', '@third:test'), plainWire('$unknown', target.agentId)] })
    const result = await readMatrixContinuity(f.client, target)
    expect(result.entries).toEqual([])
    expect(result.uncertainAgent).toBe(true)
  })

  it('reads no plaintext when the crypto store says the room is encrypted, though its state has not synced', async () => {
    const f = plainFixture()
    f.stored.encrypted = true
    const result = await readMatrixContinuity(f.client, target)
    expect(result.entries).toEqual([])
    expect(result.gaps).toBeGreaterThan(0)
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  // No answer from the crypto store in time is a failed read, not an encrypted room: a plain chat
  // read as encrypted would look empty, and the resumed conversation would be dropped for good.
  it('fails the read while the crypto store has not answered, never reading the plain chat as empty', async () => {
    const f = plainFixture()
    f.crypto.isEncryptionEnabledInRoom.mockReturnValue(new Promise<boolean>(() => {}))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const read = readMatrixContinuity(f.client, target)
    read.catch(() => {})
    await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)
    await expect(read).rejects.toThrow('matrix_continuity_unavailable')
    expect(f.pages).not.toHaveBeenCalled()
  })

  it('fails closed when encryption is turned on while the history is read', async () => {
    const f = plainFixture()
    f.roomState
      .mockImplementationOnce(async () => f.state)
      .mockImplementationOnce(async () => {
        f.synced.encrypted = true

        return f.state
      })
    await expect(readMatrixContinuity(f.client, target)).rejects.toThrow('continuity_unavailable')
  })
})

it('in an encrypted room a plaintext message stays a gap (no downgrade)', async () => {
  const f = fixture()
  f.pages.mockResolvedValue({ chunk: [plainWire('$plain-agent', target.agentId), wire('$question')] })
  const result = await readMatrixContinuity(f.client, target)
  expect(result.entries.map(entry => entry.eventId)).toEqual(['$question'])
  expect(result.gaps).toBe(1)
  expect(result.uncertainAgent).toBe(true)
})

// A read that only seeds a new session (0.20 turn path): short of time, the newest dialogue it
// read stands for the conversation, under the same checks, instead of failing the turn.
describe('a bounded read', () => {
  it('keeps the newest page when an older one is late, and still re-checks the room in time', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.pages
      .mockResolvedValueOnce({ chunk: [wire('$current'), answer(), wire('$question')], end: 'older' })
      .mockImplementationOnce(() => new Promise(() => {}))

    const pending = readMatrixContinuity(f.client, { ...target, before: '$current', bounded: true })
    await vi.advanceTimersByTimeAsync(MATRIX_CONTINUITY.deadlineMs - MATRIX_CONTINUITY.settleMs)
    const read = await pending

    expect(read).toEqual({
      ...target,
      entries: [
        { eventId: '$answer', role: 'assistant', text: 'Answer', invocationId: invocation },
        { eventId: '$question', role: 'user', text: '$question' }
      ],
      reachedStop: false,
      gaps: 0,
      uncertainAgent: false,
      clipped: true
    })
    // The room is read before and again after, as for any read.
    expect(f.roomState).toHaveBeenCalledTimes(2)
  })

  it('stops within a page once its time is spent, keeping only what it fully checked', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.pages
      .mockResolvedValueOnce({ chunk: [wire('$current'), answer(), wire('$question')], end: 'older' })
      .mockResolvedValueOnce({ chunk: [answer('$older-answer'), wire('$older-question')], end: 'oldest' })
    const decrypt = f.decrypt.getMockImplementation()!
    f.decrypt.mockImplementation(async event => {
      await decrypt(event)

      // A slow decryption uses up the paging time (no timer fires: only the clock moves).
      if (event.getId() === '$older-answer') {
        vi.setSystemTime(Date.now() + MATRIX_CONTINUITY.deadlineMs - MATRIX_CONTINUITY.settleMs)
      }
    })

    const read = await readMatrixContinuity(f.client, { ...target, before: '$current', bounded: true })
    expect(read.entries.map(entry => entry.eventId)).toEqual(['$answer', '$question', '$older-answer'])
    expect(read).toMatchObject({ clipped: true, reachedStop: false })
    expect(f.pages).toHaveBeenCalledTimes(2)
  })

  it('still fails when not even the newest page arrives, and an ordinary read still fails on a late page', async () => {
    vi.useFakeTimers()
    const first = fixture()
    first.pages.mockImplementation(() => new Promise(() => {}))
    const none = readMatrixContinuity(first.client, { ...target, bounded: true })
    const refused = expect(none).rejects.toThrow('continuity_unavailable')
    await vi.advanceTimersByTimeAsync(MATRIX_CONTINUITY.deadlineMs)
    await refused

    const strict = fixture()
    strict.pages
      .mockResolvedValueOnce({ chunk: [wire('$current'), answer(), wire('$question')], end: 'older' })
      .mockImplementationOnce(() => new Promise(() => {}))
    const late = readMatrixContinuity(strict.client, { ...target, before: '$current' })
    const failed = expect(late).rejects.toThrow('continuity_unavailable')
    await vi.advanceTimersByTimeAsync(MATRIX_CONTINUITY.deadlineMs)
    await failed
  })

  it('never keeps an unverified message, even when it is the newest one read', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.crypto.getDeviceVerificationStatus.mockResolvedValue({ isVerified: () => false })
    f.pages
      .mockResolvedValueOnce({ chunk: [wire('$current'), answer(), wire('$question')], end: 'older' })
      .mockImplementationOnce(() => new Promise(() => {}))

    const pending = readMatrixContinuity(f.client, { ...target, before: '$current', bounded: true })
    await vi.advanceTimersByTimeAsync(MATRIX_CONTINUITY.deadlineMs - MATRIX_CONTINUITY.settleMs)
    const read = await pending
    expect(read.entries).toEqual([])
    expect(read).toMatchObject({ clipped: true, gaps: 2, uncertainAgent: true })
  })
})

it('reads past the agent\u2019s interim remark: its own words in a turn the session ran, never a gap or another session', async () => {
  const f = fixture()
  f.pages.mockResolvedValue({
    chunk: [
      wire('$interim', target.agentId, { msgtype: 'm.text', body: 'Để mình xem video này rồi tóm tắt nhé.', 'io.atum.interim': true }),
      answer()
    ]
  })

  const result = await readMatrixContinuity(f.client, { ...target, stopAt: '$answer' })
  expect(result.entries.map(e => e.eventId)).toEqual(['$answer'])
  // The stored session (and its cached prefix) stays usable.
  expect(result.uncertainAgent).toBe(false)
  expect(result.gaps).toBe(0)
  expect(result.reachedStop).toBe(true)

  // The same text without the marker is unknown agent text, as before.
  f.pages.mockResolvedValue({ chunk: [wire('$unmarked', target.agentId, { msgtype: 'm.text', body: 'Để mình xem.' }), answer()] })
  const unmarked = await readMatrixContinuity(f.client, { ...target, stopAt: '$answer' })
  expect(unmarked.uncertainAgent).toBe(true)
})

describe('read by the agent’s own client (the cloud controller, 2026-11-07)', () => {
  // The cloud controller's Matrix client is the agent's account, never the owner's. A read that only
  // the owner's client could make left every cloud sweep `conversation` source `unavailable` and
  // every cloud session seed empty, with the same room readable by both participants.
  const asUser = (f: ReturnType<typeof plainFixture>, userId: string) =>
    ({ ...f.client, getUserId: () => userId }) as unknown as MatrixClient

  it('reads a plain room as the agent, with the same entries and roles as the owner reads', async () => {
    const f = plainFixture()
    const owner = await readMatrixContinuity(f.client, { ...target, before: '$current' })
    const agent = await readMatrixContinuity(asUser(f, target.agentId), { ...target, before: '$current' })
    expect(agent).toEqual(owner)
    expect(agent.entries.map(entry => entry.role)).toEqual(['assistant', 'user'])
  })

  it('still refuses a client that is neither the owner nor the agent', async () => {
    const f = plainFixture()
    await expect(readMatrixContinuity(asUser(f, '@third:test'), target)).rejects.toThrow('matrix_continuity_unavailable')
    expect(f.pages).not.toHaveBeenCalled()
  })
})
