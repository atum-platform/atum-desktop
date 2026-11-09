// @vitest-environment node
import { type MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api'
import { afterEach, expect, it, vi } from 'vitest'

import { MATRIX_TIMELINE_KEY_RETRY_MS, matrixTimelineKeyRetry } from './timeline-key-retry'

afterEach(() => vi.useRealTimers())

function setup(code: DecryptionFailureCode = DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID) {
  let joined = true
  let redacted = false

  const event = new MatrixEvent({
    type: 'm.room.encrypted',
    room_id: '!room:test',
    event_id: '$event',
    content: { ciphertext: 'opaque' }
  })

  vi.spyOn(event, 'isDecryptionFailure').mockReturnValue(true)
  vi.spyOn(event, 'decryptionFailureReason', 'get').mockReturnValue(code)
  vi.spyOn(event, 'isRedacted').mockImplementation(() => redacted)

  const decrypt = vi.fn(async (retry: MatrixEvent) => {
    vi.spyOn(retry, 'isDecryptionFailure').mockReturnValue(false)
  })

  const changed = vi.fn()

  const client = {
    getRoom: () => ({ getMyMembership: () => (joined ? 'join' : 'leave') }),
    decryptEventIfNeeded: decrypt
  } as unknown as MatrixClient

  return {
    event,
    decrypt,
    changed,
    retry: matrixTimelineKeyRetry(client, changed),
    leave: () => {
      joined = false
    },
    redact: () => {
      redacted = true
    }
  }
}

it('projects a recovered event after exactly one bounded retry over unchanged ciphertext', async () => {
  vi.useFakeTimers()
  const f = setup()
  expect(f.retry.project(f.event)).toBe(f.event)
  f.retry.project(f.event)
  await vi.advanceTimersByTimeAsync(MATRIX_TIMELINE_KEY_RETRY_MS - 1)
  expect(f.decrypt).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  const recovered = f.retry.project(f.event)
  expect(recovered).not.toBe(f.event)
  expect(recovered.getWireContent()).toEqual(f.event.getWireContent())
  expect(f.changed).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  f.retry.project(f.event)
  expect(f.decrypt).toHaveBeenCalledTimes(1)
  f.retry.stop()
})

it.each([
  DecryptionFailureCode.UNSIGNED_SENDER_DEVICE,
  DecryptionFailureCode.MEGOLM_KEY_WITHHELD,
  DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED,
  DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP
])('never retries verification, withheld, identity or absent-backup failure %s', async code => {
  vi.useFakeTimers()
  const f = setup(code)
  f.retry.project(f.event)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.decrypt).not.toHaveBeenCalled()
  expect(f.changed).not.toHaveBeenCalled()
  f.retry.stop()
})

it.each(['stop', 'leave', 'redact'] as const)('cancels the pending retry after %s', async action => {
  vi.useFakeTimers()
  const f = setup()
  f.retry.project(f.event)

  if (action === 'stop') {
    f.retry.stop()
  } else if (action === 'leave') {
    f.leave()
  } else {
    f.redact()
  }

  await vi.advanceTimersByTimeAsync(MATRIX_TIMELINE_KEY_RETRY_MS)
  expect(f.decrypt).not.toHaveBeenCalled()
  expect(f.changed).not.toHaveBeenCalled()
  f.retry.stop()
})

it('finishes after one failed retry without a loop or a retry button', async () => {
  vi.useFakeTimers()
  const f = setup()
  f.decrypt.mockImplementation(async retry => {
    vi.spyOn(retry, 'isDecryptionFailure').mockReturnValue(true)
  })
  f.retry.project(f.event)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.retry.project(f.event)).toBe(f.event)
  expect(f.decrypt).toHaveBeenCalledTimes(1)
  expect(f.changed).not.toHaveBeenCalled()
  f.retry.stop()
})

it('cancels a waiting retry if the SDK replaces its reason with an unsigned sender', async () => {
  vi.useFakeTimers()
  const f = setup()
  f.retry.project(f.event)
  vi.spyOn(f.event, 'decryptionFailureReason', 'get').mockReturnValue(DecryptionFailureCode.UNSIGNED_SENDER_DEVICE)
  await vi.advanceTimersByTimeAsync(MATRIX_TIMELINE_KEY_RETRY_MS)
  expect(f.decrypt).not.toHaveBeenCalled()
  expect(f.retry.project(f.event)).toBe(f.event)
  f.retry.stop()
})
