import { expect, it, vi } from 'vitest'

import { createWorkHistory } from './history'
import type { OwnerEventSource } from './owner-event'
it('canonical main room authority controls the SDK history command', async () => {
  const command = vi.fn(async () => [])
  const host = { userId: '@owner:test', command }

  const source: OwnerEventSource = {
    ownerUserId: () => host.userId,
    agentUserId: async () => '@agent:test',
    assistantRoom: async () => '!dm:test',
    readEvent: vi.fn()
  }

  const history = createWorkHistory(source, () => host)
  await expect(
    history.read({ agentPrincipal: 'agent', roomId: '!wrong:test', before: '$upper', after: null, floor: null })
  ).rejects.toThrow('wrong_room')
  expect(command).not.toHaveBeenCalled()
  await history.read({ agentPrincipal: 'agent', roomId: '!dm:test', before: '$upper', after: null, floor: null })
  expect(command).toHaveBeenCalledWith({
    kind: 'readWorkHistory',
    roomId: '!dm:test',
    before: '$upper',
    after: null,
    floor: null
  })
})
