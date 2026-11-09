// @vitest-environment node
import { type MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import type { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api'
import { afterEach, expect, it, vi } from 'vitest'

import { decryptMatrixInvocation, MATRIX_INVOCATION_KEY_RETRY_MS } from './invocation-decryption-retry'

afterEach(() => vi.useRealTimers())

function fixture(reason: string | null, roomId: string | undefined = '!room:test') {
  let joined = true

  const event = new MatrixEvent({
    type: 'm.room.encrypted',
    room_id: roomId,
    event_id: '$event',
    content: { ciphertext: 'opaque' }
  })

  vi.spyOn(event, 'isDecryptionFailure').mockImplementation(() => reason !== null)
  vi.spyOn(event, 'decryptionFailureReason', 'get').mockReturnValue(reason as DecryptionFailureCode | null)
  const decryptEventIfNeeded = vi.fn(async () => {})

  const client = {
    decryptEventIfNeeded,
    getRoom: () => ({ getMyMembership: () => (joined ? 'join' : 'leave') })
  } as unknown as MatrixClient

  return {
    client,
    event,
    decryptEventIfNeeded,
    leave: () => {
      joined = false
    }
  }
}

it.each(['MEGOLM_UNKNOWN_INBOUND_SESSION_ID', 'OLM_UNKNOWN_MESSAGE_INDEX'])(
  'retries %s exactly once after the bound',
  async reason => {
    vi.useFakeTimers()
    const f = fixture(reason)
    const result = decryptMatrixInvocation(f.client, f.event)
    await vi.advanceTimersByTimeAsync(MATRIX_INVOCATION_KEY_RETRY_MS - 1)
    expect(f.decryptEventIfNeeded).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const retry = await result
    expect(f.decryptEventIfNeeded).toHaveBeenCalledTimes(2)
    expect(retry).not.toBe(f.event)
    expect(retry.getWireContent()).toEqual(f.event.getWireContent())
    expect(f.decryptEventIfNeeded).toHaveBeenLastCalledWith(retry)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.decryptEventIfNeeded).toHaveBeenCalledTimes(2)
  }
)

it.each([null, 'UNSIGNED_SENDER_DEVICE', 'MEGOLM_KEY_WITHHELD', 'SENDER_IDENTITY_PREVIOUSLY_VERIFIED'])(
  'does not retry %s',
  async reason => {
    const f = fixture(reason)
    await decryptMatrixInvocation(f.client, f.event)
    expect(f.decryptEventIfNeeded).toHaveBeenCalledTimes(1)
  }
)

it('refuses a retry after membership is withdrawn', async () => {
  vi.useFakeTimers()
  const f = fixture('MEGOLM_UNKNOWN_INBOUND_SESSION_ID')
  const result = decryptMatrixInvocation(f.client, f.event)
  const rejected = expect(result).rejects.toThrow('matrix_invocation_untrusted')
  f.leave()
  await vi.advanceTimersByTimeAsync(MATRIX_INVOCATION_KEY_RETRY_MS)
  await rejected
  expect(f.decryptEventIfNeeded).toHaveBeenCalledTimes(1)
})

it('does not delay or retry a redacted event', async () => {
  const f = fixture('MEGOLM_UNKNOWN_INBOUND_SESSION_ID')
  vi.spyOn(f.event, 'isRedacted').mockReturnValue(true)
  expect(await decryptMatrixInvocation(f.client, f.event)).toBe(f.event)
  expect(f.decryptEventIfNeeded).toHaveBeenCalledTimes(1)
})

it('returns a closed policy denial when a failed event has no room', async () => {
  vi.useFakeTimers()
  const f = fixture('MEGOLM_UNKNOWN_INBOUND_SESSION_ID')
  vi.spyOn(f.event, 'getRoomId').mockReturnValue(undefined)
  const result = decryptMatrixInvocation(f.client, f.event)
  const rejected = expect(result).rejects.toThrow('matrix_invocation_untrusted')
  await vi.advanceTimersByTimeAsync(MATRIX_INVOCATION_KEY_RETRY_MS)
  await rejected
  expect(f.decryptEventIfNeeded).toHaveBeenCalledTimes(1)
})
