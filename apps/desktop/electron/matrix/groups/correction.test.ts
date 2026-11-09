import { expect, it, vi } from 'vitest'

import type { MatrixInvocationMessage } from '../../../shared/matrix'

import { groupCorrectionTarget, GroupTurnCorrections, publishCurrentGroupTurn } from './correction'

const now = Date.now()
const input = {
  roomId: '!meeting:test',
  eventId: '$correction',
  ownerId: '@owner:test',
  since: now - 10_000,
  acceptedAt: now
}

function message(changes: Partial<MatrixInvocationMessage> = {}): MatrixInvocationMessage {
  return {
    roomId: input.roomId,
    eventId: input.eventId,
    wireType: 'm.room.encrypted',
    sender: input.ownerId,
    senderDevice: 'PHONE',
    senderVerified: true,
    timestamp: now - 100,
    related: true,
    content: { msgtype: 'm.text', body: 'Actually, use the revised figures.', replyTo: '$original' },
    ...changes
  }
}

it('stops every active bot on the quoted task and leaves unrelated work running', () => {
  const turns = new GroupTurnCorrections()
  const first = new AbortController()
  const second = new AbortController()
  const unrelated = new AbortController()
  turns.track({ roomId: input.roomId, eventId: '$original', abort: first })
  turns.track({ roomId: input.roomId, eventId: '$original', abort: second })
  turns.track({ roomId: input.roomId, eventId: '$other', abort: unrelated })

  const corrected = groupCorrectionTarget(message(), input)
  expect(corrected).toBe('$original')
  expect(turns.apply(input.roomId, corrected!)).toBe(2)
  expect(first.signal.reason).toEqual(new Error('matrix_group_corrected'))
  expect(second.signal.aborted).toBe(true)
  expect(unrelated.signal.aborted).toBe(false)
})

it('does not enqueue an answer when a correction arrives during final room revalidation', async () => {
  const abort = new AbortController()
  let finishRead!: () => void
  const revalidating = new Promise<void>(resolve => {
    finishRead = resolve
  })
  const publish = vi.fn(async () => '$answer')
  const pending = publishCurrentGroupTurn(
    abort.signal,
    async () => {
      await revalidating
    },
    publish
  )

  abort.abort(new Error('matrix_group_corrected'))
  finishRead()

  await expect(pending).rejects.toThrow('matrix_group_corrected')
  expect(publish).not.toHaveBeenCalled()
})

it('does not treat a new owner message as a correction and refuses unverified control', () => {
  expect(
    groupCorrectionTarget(message({ related: false, content: { msgtype: 'm.text', body: 'New task' } }), input)
  ).toBe(undefined)
  expect(() => groupCorrectionTarget(message({ senderVerified: false }), input)).toThrow('matrix_invocation_untrusted')
  expect(() => groupCorrectionTarget(message({ sender: '@other:test' }), input)).toThrow('matrix_invocation_untrusted')
})
