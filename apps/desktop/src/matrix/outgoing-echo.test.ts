import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixMessage } from '../../shared/matrix'

import type { MatrixTranscriptEntry } from './local-turns'
import {
  $outgoingEchoes,
  addOutgoingEcho,
  dropOutgoingEchoes,
  failOutgoingEcho,
  mergeOutgoingEchoes,
  settleOutgoingEcho
} from './outgoing-echo'

const roomId = '!room:test'
const me = '@owner:test'

const entry = (
  id: string,
  body: string,
  timestamp: number,
  patch: Partial<MatrixMessage> = {}
): MatrixTranscriptEntry => ({
  message: {
    id,
    sender: me,
    body,
    timestamp,
    own: true,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...patch
  }
})

beforeEach(() => {
  vi.useFakeTimers()
  $outgoingEchoes.set([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('your message shows the moment you press Send', () => {
  it('draws a pending message of yours at once, after everything already in the chat', () => {
    addOutgoingEcho(roomId, 'Hi Luna', { now: 5_000 })
    const { entries, matched } = mergeOutgoingEchoes(
      [entry('$old', 'Earlier', 1_000)],
      $outgoingEchoes.get(),
      roomId,
      me
    )

    expect(entries.map(value => value.message.body)).toEqual(['Earlier', 'Hi Luna'])
    expect(entries[1]?.message).toMatchObject({ own: true, pending: true, failed: false, sender: me })
    expect(matched).toEqual([])
  })

  it('carries the message it answers, so its quote shows at once and nothing jumps', () => {
    addOutgoingEcho(roomId, 'Yes', { replyTo: '$asked', now: 5_000 })
    addOutgoingEcho(roomId, 'Plain', { now: 5_001 })
    const { entries } = mergeOutgoingEchoes([], $outgoingEchoes.get(), roomId, me)

    expect(entries[0]?.message.replyTo).toBe('$asked')
    expect(entries[1]?.message).not.toHaveProperty('replyTo')
  })

  it('only in the chat it was sent in', () => {
    addOutgoingEcho('!other:test', 'Hi', { now: 5_000 })

    expect(mergeOutgoingEchoes([], $outgoingEchoes.get(), roomId, me).entries).toEqual([])
  })

  it('gives way to its local turn, so it never shows twice', () => {
    const id = addOutgoingEcho(roomId, 'Hi Luna', { now: 5_000 })
    settleOutgoingEcho(id, { turnId: 'turn-1' })
    const turn = entry('local-q-turn-1', 'Hi Luna', 4_000, { turn: 'turn-1' })
    const { entries, matched } = mergeOutgoingEchoes([turn], $outgoingEchoes.get(), roomId, me)

    expect(entries.map(value => value.message.id)).toEqual(['local-q-turn-1'])
    expect(matched).toEqual([id])
  })

  it("gives way to the room's own copy before the send even returns (same words, not older)", () => {
    const id = addOutgoingEcho(roomId, 'ok', { now: 5_000 })
    const older = entry('$older', 'ok', 1_000)
    const pending = entry('~txn', 'ok', 5_010, { pending: true })
    const { entries, matched } = mergeOutgoingEchoes([older, pending], $outgoingEchoes.get(), roomId, me)

    expect(entries.map(value => value.message.id)).toEqual(['$older', '~txn'])
    expect(matched).toEqual([id])
  })

  it('pairs two identical messages one to one', () => {
    addOutgoingEcho(roomId, 'ok', { now: 5_000 })
    addOutgoingEcho(roomId, 'ok', { now: 5_001 })
    const { entries } = mergeOutgoingEchoes([entry('~one', 'ok', 5_002)], $outgoingEchoes.get(), roomId, me)

    expect(entries.map(value => value.message.id)).toEqual(['~one', expect.stringMatching(/^echo-/)])
  })

  it('stays, marked not sent, when the send failed and nothing else shows it', () => {
    const id = addOutgoingEcho(roomId, 'Hi', { now: 5_000 })
    failOutgoingEcho(id)
    const [shown] = mergeOutgoingEchoes([], $outgoingEchoes.get(), roomId, me).entries

    expect(shown?.message).toMatchObject({ id, pending: false, failed: true })
    dropOutgoingEchoes([id])
    expect($outgoingEchoes.get()).toEqual([])
  })

  it('never lets a failed message take an identical later send, nor lose its Retry', () => {
    const failed = addOutgoingEcho(roomId, 'ok', { now: 5_000 })
    failOutgoingEcho(failed)
    const resent = addOutgoingEcho(roomId, 'ok', { now: 6_000 })
    settleOutgoingEcho(resent, { eventId: '$m2' })
    const { entries, matched } = mergeOutgoingEchoes([entry('$m2', 'ok', 6_001)], $outgoingEchoes.get(), roomId, me)

    expect(matched).toEqual([resent])
    expect(entries.map(value => value.message.id)).toEqual(['$m2', failed])
    expect(entries[1]?.message).toMatchObject({ failed: true, pending: false })
  })

  it('still lets a waiting message give way by its words when its exact copy is unknown', () => {
    const failed = addOutgoingEcho(roomId, 'ok', { now: 5_000 })
    failOutgoingEcho(failed)
    const waiting = addOutgoingEcho(roomId, 'ok', { now: 6_000 })
    const { entries, matched } = mergeOutgoingEchoes([entry('$m3', 'ok', 6_001)], $outgoingEchoes.get(), roomId, me)

    expect(matched).toEqual([waiting])
    expect(entries.map(value => value.message.id)).toEqual(['$m3', failed])
  })

  it('is let go if its real message never shows after the send returned', () => {
    const id = addOutgoingEcho(roomId, 'Hi', { now: 5_000 })
    settleOutgoingEcho(id, { eventId: '$never' })
    expect($outgoingEchoes.get()).toHaveLength(1)
    vi.advanceTimersByTime(15_000)
    expect($outgoingEchoes.get()).toEqual([])
  })
})
