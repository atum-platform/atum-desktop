import { describe, expect, it } from 'vitest'

import type { MatrixInvocationMessage } from '../../../shared/matrix'

import { prepareGroupChain } from './chain'

function fixture() {
  const now = Date.now()

  const roomId = '!meeting:test',
    ownerId = '@owner:test',
    one = '@one:test',
    agentId = '@two:test'

  const stamp = { origin: '$origin', parent: '$origin', depth: 1 }

  const make = (
    eventId: string,
    sender: string,
    at: number,
    content: MatrixInvocationMessage['content']
  ): MatrixInvocationMessage => ({
    roomId,
    eventId,
    sender,
    senderDevice: 'VERIFIED',
    senderVerified: true,
    wireType: 'm.room.encrypted',
    timestamp: at,
    related: false,
    content
  })

  const events = new Map([
    [
      '$origin',
      make('$origin', ownerId, now - 1_000, { msgtype: 'm.text', body: 'Plan the trip', mentionedUserIds: [one] })
    ],
    [
      '$answer',
      make('$answer', one, now - 500, {
        msgtype: 'm.text',
        body: '@Two what do you think?',
        mentionedUserIds: [agentId],
        chain: stamp
      })
    ]
  ])

  const snapshot = {
    ownerId,
    roomId,
    agentId,
    members: [ownerId, one, agentId].map(userId => ({ userId, membership: 'join' })),
    ownAgentIds: [one, agentId],
    policy: { v: 1 as const, dailyTurns: 30, agents: { [agentId]: { mode: 'addressed' as 'addressed' | 'off' } } },
    usage: { v: 1 as const, day: new Date(now).toISOString().slice(0, 10), turns: 1 }
  }

  const input = { roomId, eventId: '$answer', ownerId, agentId, since: now - 2_000, acceptedAt: now }

  const deps = {
    now: () => now,
    snapshot: async () => snapshot,
    read: async (id: string) => {
      const event = events.get(id)

      if (!event) {
        throw new Error('matrix_invocation_untrusted')
      }

      return event
    }
  }

  return { input, deps, events, snapshot, now }
}

describe('native stored chain admission', () => {
  it('admits A naming B from a verified stored owner origin into a separate reply profile', async () => {
    const f = fixture()
    const admitted = await prepareGroupChain(f.input, f.deps)
    expect(await admitted.finish()).toMatchObject({
      mode: 'meeting',
      participation: 'addressed',
      chain: { origin: '$origin', parent: '$origin', depth: 1 }
    })
  })

  it('admits A to answer a verified B follow-up in an A to B to A exchange', async () => {
    const f = fixture()
    f.events.set('$answer-b', {
      ...f.events.get('$answer')!,
      eventId: '$answer-b',
      sender: '@two:test',
      timestamp: f.now - 250,
      content: {
        msgtype: 'm.text',
        body: '@One can you confirm?',
        mentionedUserIds: ['@one:test'],
        chain: { origin: '$origin', parent: '$answer', depth: 2 }
      }
    })
    f.input.eventId = '$answer-b'
    f.input.agentId = '@one:test'
    f.snapshot.policy.agents['@one:test'] = { mode: 'addressed' }

    const admitted = await prepareGroupChain(f.input, f.deps)
    expect(await admitted.finish()).toMatchObject({
      mode: 'meeting',
      chain: { origin: '$origin', parent: '$answer', depth: 2 }
    })
  })

  it.each(['shared', 'foreign', 'untrusted', 'repeat', 'depth', 'origin', 'room', 'cap', 'off'] as const)(
    'refuses %s before a caller can claim',
    async fault => {
      const f = fixture(),
        answer = f.events.get('$answer')!,
        origin = f.events.get('$origin')!

      if (fault === 'shared') {
        f.snapshot.members.push({ userId: '@friend:test', membership: 'join' })
      }

      if (fault === 'foreign') {
        answer.sender = '@foreign:test'
      }

      if (fault === 'untrusted') {
        answer.senderVerified = false
      }

      if (fault === 'repeat') {
        answer.sender = f.input.agentId
      }

      if (fault === 'depth') {
        answer.content.chain!.depth = 4
      }

      if (fault === 'origin') {
        origin.timestamp = f.now - 600_001
      }

      if (fault === 'room') {
        origin.roomId = '!other:test'
      }

      if (fault === 'cap') {
        f.snapshot.usage.turns = 30
      }

      if (fault === 'off') {
        f.snapshot.policy.agents[f.input.agentId]!.mode = 'off'
      }

      await expect(prepareGroupChain(f.input, f.deps)).rejects.toThrow(/^matrix_group_/)
    }
  )

  // 0.20: new groups are plain. The owner SDK's reader gives every event of such a group as
  // `m.room.message` and refuses plaintext inside an encrypted group, so both forms chain.
  it('admits the same chain read from a plain group', async () => {
    const f = fixture()

    for (const event of f.events.values()) {
      event.wireType = 'm.room.message'
      event.senderDevice = 'unencrypted'
    }

    const admitted = await prepareGroupChain(f.input, f.deps)
    expect(await admitted.finish()).toMatchObject({ mode: 'meeting', chain: { origin: '$origin', depth: 1 } })
  })

  it('refuses a chain event of any other type', async () => {
    const f = fixture()
    f.events.get('$origin')!.wireType = 'm.sticker'
    await expect(prepareGroupChain(f.input, f.deps)).rejects.toThrow(/^matrix_group_/)
  })

  it('re-reads membership and policy when the queued turn starts', async () => {
    const f = fixture()
    const admitted = await prepareGroupChain(f.input, f.deps)
    f.snapshot.members.push({ userId: '@friend:test', membership: 'join' })
    await expect(admitted.finish()).rejects.toThrow('matrix_group_chain_invalid')
  })
})
