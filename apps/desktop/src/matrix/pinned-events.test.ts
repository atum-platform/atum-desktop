import { EventType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixMessage } from '../../shared/matrix'

import { changeMatrixMessagePin, matrixPinnedEventIds, matrixPinnedMessages } from './pinned-events'

const ROOM_ID = '!room:test'
const OWN = '@alice:test'

function event(eventId: string, options: { redacted?: boolean; replacement?: boolean } = {}): MatrixEvent {
  return {
    getId: () => eventId,
    getRoomId: () => ROOM_ID,
    getType: () => EventType.RoomMessage,
    isRelation: () => options.replacement === true,
    isRedacted: () => options.redacted === true,
    localRedactionEvent: () => undefined,
    isDecryptionFailure: () => false,
    status: null
  } as unknown as MatrixEvent
}

function room(
  options: {
    allowed?: boolean
    ids?: unknown
    events?: MatrixEvent[]
    membership?: string
  } = {}
): Room {
  const events = new Map((options.events ?? []).map(value => [value.getId()!, value]))
  const state = options.ids === undefined ? undefined : { getContent: () => ({ pinned: options.ids }) }

  return {
    roomId: ROOM_ID,
    currentState: {
      getStateEvents: vi.fn(() => state),
      maySendStateEvent: vi.fn(() => options.allowed ?? true)
    },
    findEventById: vi.fn((eventId: string) => events.get(eventId)),
    getMyMembership: vi.fn(() => options.membership ?? 'join')
  } as unknown as Room
}

function message(id: string, options: Partial<MatrixMessage> = {}): MatrixMessage {
  return {
    id,
    sender: '@bob:test',
    body: 'Pinned decision',
    timestamp: 1,
    own: false,
    encrypted: false,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...options
  }
}

describe('Matrix shared pinned events', () => {
  it('projects edited messages, keeps bounded missing-event tombstones, and drops redacted pins', () => {
    const edited = event('$edited')
    const redacted = event('$redacted', { redacted: true })
    const value = room({ ids: ['$edited', '$missing', '$redacted'], events: [edited, redacted] })

    const project = vi.fn((candidate: MatrixEvent) =>
      candidate === edited
        ? message('$edited', { body: 'Latest words', edited: true })
        : message('$redacted', { redacted: true })
    )

    expect(matrixPinnedMessages(value, OWN, project)).toEqual({
      canChange: true,
      entries: [
        { eventId: '$edited', message: expect.objectContaining({ body: 'Latest words', edited: true }) },
        { eventId: '$missing' }
      ]
    })
  })

  it('uses the live pinned-state send threshold and rejects malformed state content', () => {
    expect(matrixPinnedMessages(room({ allowed: false, ids: ['$one'] }), OWN, () => null)).toEqual({
      canChange: false,
      entries: [{ eventId: '$one' }]
    })
    expect(matrixPinnedEventIds(room({ ids: ['$one', '$one'] }))).toBeNull()
    expect(matrixPinnedEventIds(room({ ids: ['not-an-event'] }))).toBeNull()
    expect(matrixPinnedMessages(room({ ids: 'wrong' }), OWN, () => null)).toEqual({ canChange: true, entries: [] })
  })

  it('adds and removes one message while preserving the other standard pins', async () => {
    const sendStateEvent = vi.fn(async () => ({ event_id: '$state' }))
    const client = { getSafeUserId: () => OWN, sendStateEvent } as unknown as MatrixClient
    const target = event('$target')

    await changeMatrixMessagePin(client, room({ ids: ['$other'], events: [target] }), '$target', true)
    expect(sendStateEvent).toHaveBeenCalledWith(
      ROOM_ID,
      EventType.RoomPinnedEvents,
      { pinned: ['$other', '$target'] },
      ''
    )

    sendStateEvent.mockClear()
    await changeMatrixMessagePin(client, room({ ids: ['$other', '$target'], events: [target] }), '$target', false)
    expect(sendStateEvent).toHaveBeenCalledWith(ROOM_ID, EventType.RoomPinnedEvents, { pinned: ['$other'] }, '')
  })

  it('does not rewrite state when the operation is already satisfied or the power level forbids it', async () => {
    const sendStateEvent = vi.fn(async () => ({ event_id: '$state' }))
    const client = { getSafeUserId: () => OWN, sendStateEvent } as unknown as MatrixClient
    const target = event('$target')

    await changeMatrixMessagePin(client, room({ ids: ['$target'], events: [target] }), '$target', true)
    expect(sendStateEvent).not.toHaveBeenCalled()

    await expect(
      changeMatrixMessagePin(client, room({ allowed: false, ids: [], events: [target] }), '$target', true)
    ).rejects.toThrow('matrix_pin_forbidden')
    expect(sendStateEvent).not.toHaveBeenCalled()
  })
})
