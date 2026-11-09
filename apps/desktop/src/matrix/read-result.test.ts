// @vitest-environment node
import type { MatrixClient } from 'matrix-js-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixInvocationMessage, MatrixResultBinding } from '../../shared/matrix'
import { MATRIX_FIND_TURN } from '../../shared/matrix-turn'

import { readMatrixInvocation } from './read-invocation'
import { readMatrixResult } from './read-result'

vi.mock('./read-invocation', () => ({ readMatrixInvocation: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

const binding: MatrixResultBinding = {
  roomId: '!room:test',
  eventId: '$request',
  agentUserId: '@agent:test',
  agentDevice: 'OLD-AGENT',
  invocationId: 'invocation',
  transactionId: 'transaction'
}

function fixture() {
  const event: MatrixInvocationMessage = {
    roomId: binding.roomId,
    eventId: '$reply',
    wireType: 'm.room.encrypted',
    sender: binding.agentUserId,
    senderDevice: binding.agentDevice,
    senderVerified: true,
    timestamp: 1,
    related: true,
    content: {
      msgtype: 'm.text',
      body: 'Original result',
      result: { rootEventId: binding.eventId, invocationId: binding.invocationId, transactionId: binding.transactionId }
    }
  }

  vi.mocked(readMatrixInvocation).mockImplementation(async (_client, target) =>
    target.eventId === '$reply'
      ? event
      : { ...event, eventId: target.eventId, content: { ...event.content, result: undefined } }
  )

  const encrypted = (event_id: string, sender = binding.agentUserId) => ({
    type: 'm.room.encrypted',
    room_id: binding.roomId,
    event_id,
    sender,
    origin_server_ts: 1,
    content: { ciphertext: 'opaque' }
  })

  const createMessagesRequest = vi.fn(async (): Promise<any> => ({ chunk: [encrypted('$reply')] }))
  const getMyMembership = vi.fn(() => 'join')
  const hasEncryptionStateEvent = vi.fn(() => true)
  // The crypto store's record of the room: plain unless it has seen the room's encryption.
  const isEncryptionEnabledInRoom = vi.fn(async () => false)

  const client = {
    createMessagesRequest,
    getRoom: () => ({ roomId: binding.roomId, getMyMembership, hasEncryptionStateEvent }),
    getCrypto: () => ({ isEncryptionEnabledInRoom })
  } as unknown as MatrixClient

  return { encrypted, event, createMessagesRequest, getMyMembership, hasEncryptionStateEvent, isEncryptionEnabledInRoom, client }
}

it('reads the acknowledged encrypted result directly, without a second publication', async () => {
  const f = fixture()
  expect(await readMatrixResult(f.client, { ...binding, publishedEvent: '$reply' })).toEqual({
    state: 'published',
    eventId: '$reply',
    body: 'Original result'
  })
  expect(f.createMessagesRequest).not.toHaveBeenCalled()
})
it('finds one result from the fresh server timeline after lost acknowledgement', async () => {
  const f = fixture()
  f.createMessagesRequest.mockResolvedValueOnce({ chunk: [], end: 'next' })
  expect(await readMatrixResult(f.client, binding)).toEqual({
    state: 'published',
    eventId: '$reply',
    body: 'Original result'
  })
  expect(f.createMessagesRequest.mock.calls[1]).toEqual([
    binding.roomId,
    'next',
    MATRIX_FIND_TURN.pageSize,
    expect.anything()
  ])
})

it('skips mixed state and other-user timeline events, then stops at the root event', async () => {
  const f = fixture()
  f.createMessagesRequest.mockResolvedValueOnce({
    chunk: [
      { type: 'm.room.member', room_id: binding.roomId, event_id: '$join', sender: '@other:test', content: {} },
      f.encrypted('$other', '@other:test'),
      f.encrypted('$reply'),
      {
        type: 'm.room.encrypted',
        room_id: binding.roomId,
        event_id: binding.eventId,
        sender: '@owner:test',
        content: {}
      },
      f.encrypted('$before-root')
    ],
    end: 'older'
  })

  expect(await readMatrixResult(f.client, binding)).toEqual({
    state: 'published',
    eventId: '$reply',
    body: 'Original result'
  })
  expect(readMatrixInvocation).toHaveBeenCalledTimes(1)
  expect(readMatrixInvocation).toHaveBeenCalledWith(f.client, { roomId: binding.roomId, eventId: '$reply' })
  expect(f.createMessagesRequest).toHaveBeenCalledTimes(1)
})

it('keeps one recent exact result from a long active-room tail after exhausting the bounded scan', async () => {
  const f = fixture()
  f.createMessagesRequest.mockImplementation(async () => {
    const page = f.createMessagesRequest.mock.calls.length

    return {
      chunk: page === 1 ? [f.encrypted('$reply'), f.encrypted('$noise-1')] : [f.encrypted(`$noise-${page}`)],
      end: `page-${page}`
    }
  })

  expect(await readMatrixResult(f.client, binding)).toEqual({
    state: 'published',
    eventId: '$reply',
    body: 'Original result'
  })
  expect(f.createMessagesRequest).toHaveBeenCalledTimes(MATRIX_FIND_TURN.pages)
})

it('leaves an ancient lost-acknowledgement reply outside the scan budget unknown without publishing', async () => {
  const f = fixture()
  const sendEvent = vi.fn()
  Object.assign(f.client, { sendEvent })
  f.createMessagesRequest.mockImplementation(async () => {
    const page = f.createMessagesRequest.mock.calls.length

    return {
      // The matching result exists, but only beyond the bounded fresh tail.
      // Legacy thread replies and ordinary replies must both stay unknown here.
      chunk: [f.encrypted(page > MATRIX_FIND_TURN.pages ? '$reply' : `$noise-${page}`)],
      end: `page-${page}`
    }
  })

  expect(await readMatrixResult(f.client, binding)).toEqual({ state: 'unknown' })
  expect(f.createMessagesRequest).toHaveBeenCalledTimes(MATRIX_FIND_TURN.pages)
  expect(sendEvent).not.toHaveBeenCalled()
  expect(readMatrixInvocation).not.toHaveBeenCalledWith(f.client, { roomId: binding.roomId, eventId: '$reply' })
})

it('only an exact server-recorded event may be displayed as unverified restored history', async () => {
  const f = fixture()
  f.event.senderVerified = false
  expect(await readMatrixResult(f.client, { ...binding, publishedEvent: '$reply' })).toEqual({
    state: 'unverified',
    eventId: '$reply',
    body: 'Original result'
  })
  expect(f.createMessagesRequest).not.toHaveBeenCalled()
  expect(await readMatrixResult(f.client, binding)).toEqual({ state: 'unknown' })
})
it.each([
  'sender',
  'device',
  'trust',
  'root',
  'invocation',
  'transaction',
  'redacted',
  'ambiguous',
  'cycle',
  'bound',
  'left'
])('%s leaves the result unknown', async mode => {
  const f = fixture()

  if (mode === 'sender') {
    f.event.sender = '@other:test'
  }

  if (mode === 'device') {
    f.event.senderDevice = 'OTHER'
  }

  if (mode === 'trust') {
    f.event.senderVerified = false
  }

  if (mode === 'root') {
    f.event.content.result!.rootEventId = '$other'
  }

  if (mode === 'invocation') {
    f.event.content.result!.invocationId = 'other'
  }

  if (mode === 'transaction') {
    f.event.content.result!.transactionId = 'other'
  }

  if (mode === 'redacted') {
    vi.mocked(readMatrixInvocation).mockRejectedValue(Error('redacted or missing key'))
  }

  if (mode === 'ambiguous') {
    vi.mocked(readMatrixInvocation).mockResolvedValue(f.event)
    f.createMessagesRequest.mockResolvedValue({ chunk: [f.encrypted('$a'), f.encrypted('$b')] })
  }

  if (mode === 'cycle') {
    f.createMessagesRequest.mockResolvedValue({ chunk: [], end: 'same' })
  }

  if (mode === 'bound') {
    f.createMessagesRequest.mockImplementation(async () => ({
      chunk: [],
      end: String(f.createMessagesRequest.mock.calls.length)
    }))
  }

  if (mode === 'left') {
    f.getMyMembership.mockReturnValue('leave')
  }

  expect(await readMatrixResult(f.client, binding)).toEqual({ state: 'unknown' })
  expect(f.createMessagesRequest.mock.calls.length).toBeLessThanOrEqual(MATRIX_FIND_TURN.pages)
})

// 0.20: the agent's answer in its plain chat names no device (read-invocation.ts gives
// 'unencrypted'), so it is matched on sender, invocation and transaction.
describe('a room without end-to-end encryption', () => {
  function plainFixture() {
    const f = fixture()
    f.hasEncryptionStateEvent.mockReturnValue(false)
    f.event.wireType = 'm.room.message'
    f.event.senderDevice = 'unencrypted'

    const plain = (event_id: string, sender = binding.agentUserId) => ({
      ...f.encrypted(event_id, sender),
      type: 'm.room.message'
    })

    f.createMessagesRequest.mockResolvedValue({ chunk: [plain('$reply')] })

    return { ...f, plain }
  }

  it('finds the agent\u2019s plain answer by sender, invocation and transaction, not device', async () => {
    const f = plainFixture()
    expect(await readMatrixResult(f.client, binding)).toEqual({
      state: 'published',
      eventId: '$reply',
      body: 'Original result'
    })
    expect(await readMatrixResult(f.client, { ...binding, publishedEvent: '$reply' })).toEqual({
      state: 'published',
      eventId: '$reply',
      body: 'Original result'
    })
  })

  it('still needs the agent as sender and the exact invocation', async () => {
    const f = plainFixture()
    f.event.sender = '@other:test'
    expect(await readMatrixResult(f.client, binding)).toEqual({ state: 'unknown' })
    const g = plainFixture()
    g.event.content.result!.invocationId = 'other'
    expect(await readMatrixResult(g.client, binding)).toEqual({ state: 'unknown' })
  })

  it('never takes a ciphertext in a plain room as a candidate', async () => {
    const f = plainFixture()
    f.createMessagesRequest.mockResolvedValue({ chunk: [f.encrypted('$reply')] })
    expect(await readMatrixResult(f.client, binding)).toEqual({ state: 'unknown' })
    expect(readMatrixInvocation).not.toHaveBeenCalled()
  })
})

// After a restart or a new join the room's encryption state may not have synced yet while the
// crypto store already knows it: still an encrypted room (no downgrade, and no missed answer).
it('scans an encrypted room whose encryption state has not synced for its ciphertext answer, never plaintext', async () => {
  const f = fixture()
  f.hasEncryptionStateEvent.mockReturnValue(false)
  f.isEncryptionEnabledInRoom.mockResolvedValue(true)
  expect(await readMatrixResult(f.client, binding)).toEqual({
    state: 'published',
    eventId: '$reply',
    body: 'Original result'
  })

  vi.mocked(readMatrixInvocation).mockClear()
  const g = fixture()
  g.hasEncryptionStateEvent.mockReturnValue(false)
  g.isEncryptionEnabledInRoom.mockResolvedValue(true)
  g.createMessagesRequest.mockResolvedValue({ chunk: [{ ...g.encrypted('$reply'), type: 'm.room.message' }] })
  expect(await readMatrixResult(g.client, binding)).toEqual({ state: 'unknown' })
  expect(readMatrixInvocation).not.toHaveBeenCalled()
})

it('counts a room the crypto store cannot answer for as encrypted', async () => {
  const f = fixture()
  f.hasEncryptionStateEvent.mockReturnValue(false)
  f.isEncryptionEnabledInRoom.mockRejectedValue(new Error('store unavailable'))
  f.createMessagesRequest.mockResolvedValue({ chunk: [{ ...f.encrypted('$reply'), type: 'm.room.message' }] })
  expect(await readMatrixResult(f.client, binding)).toEqual({ state: 'unknown' })
  expect(readMatrixInvocation).not.toHaveBeenCalled()
})

it('in an encrypted room a plaintext answer is not a candidate, and the device must still match (no downgrade)', async () => {
  const f = fixture()
  f.createMessagesRequest.mockResolvedValue({ chunk: [{ ...f.encrypted('$reply'), type: 'm.room.message' }] })
  expect(await readMatrixResult(f.client, binding)).toEqual({ state: 'unknown' })
  expect(readMatrixInvocation).not.toHaveBeenCalled()

  const g = fixture()
  g.event.senderDevice = 'unencrypted'
  expect(await readMatrixResult(g.client, { ...binding, publishedEvent: '$reply' })).toEqual({ state: 'unknown' })
})
