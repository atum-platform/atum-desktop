import { expect, it } from 'vitest'

import { MATRIX_PLAIN_SENDER_DEVICE, type MatrixInvocationMessage } from '../../shared/matrix'

import { trustedWorkReply } from './work-question'
it('requires exact room, sender, relation and encryption trust', () => {
  const message: MatrixInvocationMessage = {
    roomId: '!dm:test',
    eventId: '$answer',
    sender: '@agent:test',
    wireType: 'm.room.message',
    roomPlain: true,
    senderDevice: MATRIX_PLAIN_SENDER_DEVICE,
    senderVerified: true,
    timestamp: 1,
    related: true,
    content: { msgtype: 'm.text', body: 'answer', replyTo: '$question' }
  }

  const check = (m: MatrixInvocationMessage) => trustedWorkReply(m, '!dm:test', '@agent:test', '$question')
  expect(check(message)).toBe(true)

  for (const patch of [
    { roomId: '!wrong:test' },
    { sender: '@wrong:test' },
    { senderVerified: false },
    { thread: true as const },
    { content: { ...message.content, replyTo: '$other' } },
    { content: { ...message.content, msgtype: 'm.notice' } }
  ]) {
    expect(check({ ...message, ...patch })).toBe(false)
  }

  const encrypted = { ...message, roomPlain: undefined, wireType: 'm.room.encrypted', senderDevice: 'TRUSTED' }
  expect(check(encrypted)).toBe(true)
  expect(check({ ...encrypted, senderVerified: false })).toBe(false)
  expect(check({ ...encrypted, wireType: 'm.room.message' })).toBe(false)
})
