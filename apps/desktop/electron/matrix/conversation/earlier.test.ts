import { expect, it, vi } from 'vitest'

import { EarlierConversationError } from '../../../shared/agent-conversation'

import { postEarlierConversationNotice } from './earlier'

it('only the lease holder publishes a static notice once per UTC room/day and remembers after success', async () => {
  let lastDay: string | undefined
  let holder = true
  const publish = vi.fn(async () => {})
  const ports = {
    current: () => true,
    leaseHolder: () => holder,
    lastDay: () => lastDay,
    rememberDay: (_room: string, day: string) => {
      lastDay = day
    },
    publish
  }
  const error = new EarlierConversationError('!earlier:test', '!main:test')
  const now = Date.UTC(2026, 9, 7)
  await postEarlierConversationNotice(error, ports, 'Continue in your main conversation.', now)
  expect(lastDay).toBe('2026-10-07')
  expect(publish).toHaveBeenCalledTimes(1)
  await postEarlierConversationNotice(error, ports, 'copy', now)
  await postEarlierConversationNotice(error, ports, 'copy', now - 86400000)
  holder = false
  await postEarlierConversationNotice(error, ports, 'copy', now + 86400000)
  expect(publish).toHaveBeenCalledTimes(1)
  holder = true
  await postEarlierConversationNotice(error, ports, 'copy', now + 86400000)
  expect(publish).toHaveBeenCalledTimes(2)
  expect(await postEarlierConversationNotice(new Error('network'), ports, 'copy', now)).toBe(false)
})

it('failed publication never spends the day and retries without a model/claim/hold', async () => {
  const rememberDay = vi.fn()
  const publish = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  const ports = { current: () => true, leaseHolder: () => true, lastDay: () => undefined, rememberDay, publish }
  const error = new EarlierConversationError('!earlier:test')
  await expect(postEarlierConversationNotice(error, ports, 'static copy', 100)).rejects.toThrow('offline')
  expect(rememberDay).not.toHaveBeenCalled()
  await postEarlierConversationNotice(error, ports, 'static copy', 100)
  expect(rememberDay).toHaveBeenCalledTimes(1)
})
