import { expect, it, vi } from 'vitest'

import { groupFloor, GroupRoomQueue, prepareGroupFloor } from './floor'

const facts = {
  ownerUserId: '@owner:test',
  agentUserId: '@one:test',
  senderUserId: '@owner:test',
  senderVerified: true,
  roomMode: 'meeting' as const,
  ownAgentIds: ['@one:test', '@two:test', '@three:test'],
  joinedAgentIds: ['@one:test', '@two:test', '@three:test'],
  eventId: '$owner',
  eventKind: 'text' as const,
  mentions: [],
  policy: { v: 1 as const, agents: {} }
}

it('defaults owner-only meetings to everyone, honours an explicit addressed policy, and selects two consistent joins candidates', async () => {
  expect((await groupFloor(facts)).order).toHaveLength(2)

  const addressed = {
    v: 1 as const,
    agents: Object.fromEntries(facts.ownAgentIds.map(id => [id, { mode: 'addressed' as const }]))
  }

  await expect(groupFloor({ ...facts, policy: addressed })).resolves.toMatchObject({
    kind: 'none',
    position: -1,
    order: []
  })

  const policy = {
    v: 1 as const,
    agents: Object.fromEntries(facts.ownAgentIds.map(id => [id, { mode: 'joins' as const }]))
  }

  const first = await groupFloor({ ...facts, policy })
  const second = await groupFloor({ ...facts, policy, agentUserId: '@two:test' })
  expect(first.order).toHaveLength(2)
  expect(second.order).toEqual(first.order)
  await expect(groupFloor({ ...facts, policy, roomMode: 'shared' })).resolves.toMatchObject({ kind: 'none', order: [] })
})

it('named order excludes off or departed agents and never redirects to unmentioned assistants', async () => {
  const selected = await groupFloor({
    ...facts,
    mentions: ['@three:test', '@two:test', '@one:test'],
    joinedAgentIds: ['@one:test', '@two:test'],
    policy: { v: 1, agents: { '@two:test': { mode: 'off' } } }
  })

  expect(selected.order).toEqual(['@one:test'])
})

it('uses frozen relevance order for ambient messages, caps it, and rejects non-candidates', async () => {
  await expect(
    groupFloor({ ...facts, relevantAgentIds: ['@three:test', '@two:test', '@one:test'] })
  ).resolves.toMatchObject({
    kind: 'everyone',
    order: ['@three:test', '@two:test']
  })
  await expect(groupFloor({ ...facts, relevantAgentIds: ['@foreign:test'] })).rejects.toThrow(
    'matrix_group_routing_invalid'
  )
})

it('serializes one assistant while different assistants in the room run independently', async () => {
  const queue = new GroupRoomQueue()
  const calls: string[] = []
  let release!: () => void

  const blocked = new Promise<void>(resolve => {
    release = resolve
  })

  const first = queue.run('room\nagent-a', async () => {
    calls.push('first')
    await blocked
    throw new Error('failed')
  })

  const second = queue.run('room\nagent-a', async () => {
    calls.push('second')
  })

  await queue.run('room\nagent-b', async () => {
    calls.push('other')
  })
  expect(calls).toEqual(['first', 'other'])
  release()
  await expect(first).rejects.toThrow('failed')
  await second
  expect(calls).toEqual(['first', 'other', 'second'])
  await queue.run('room\nagent-a', async () => {
    calls.push('third')
  })
  expect(calls.at(-1)).toBe('third')
})

function ports() {
  let now = 1100

  const message = {
    roomId: '!room:test',
    eventId: '$owner',
    wireType: 'm.room.encrypted',
    sender: facts.ownerUserId,
    senderDevice: 'PHONE',
    senderVerified: true,
    timestamp: 1000,
    related: false,
    content: { msgtype: 'm.text', body: 'Discuss this', mentionedUserIds: ['@two:test', '@one:test'] }
  }

  const snapshot = {
    policy: { v: 1 as const, agents: {} },
    usage: { v: 1 as const, day: '1970-01-01', turns: 0 },
    ownAgentIds: facts.ownAgentIds,
    members: [facts.ownerUserId, ...facts.ownAgentIds].map(userId => ({ userId, membership: 'join' }))
  }

  const input = {
    roomId: message.roomId,
    eventId: message.eventId,
    ownerId: facts.ownerUserId,
    agentId: facts.agentUserId,
    since: 900,
    acceptedAt: now
  }

  const deps = {
    ownerEvent: vi.fn(async () => message),
    ownerDeviceDenied: vi.fn(),
    snapshot: vi.fn(async () => snapshot),
    replySender: vi.fn(async (): Promise<string | undefined> => undefined),
    now: () => now
  }

  return { input, deps, message, snapshot }
}

it('native admission starts independently, then rechecks policy and cap inside its own queue', async () => {
  const f = ports()
  const admission = await prepareGroupFloor(f.input, f.deps)
  expect(f.deps.now()).toBe(1100)
  expect(admission.state).toBe('ready')

  if (admission.state !== 'ready') {
    throw new Error('not admitted')
  }

  expect(await admission.finish()).toMatchObject({
    mode: 'meeting',
    dailyTurns: 30,
    floor: { position: 0, acceptedAt: 1100 }
  })
  f.snapshot.usage.turns = 30
  await expect(admission.finish()).rejects.toThrow('matrix_group_room_cap')
})

it('a message admitted fresh is not dropped for the time it waits in the room queue', async () => {
  const f = ports()
  let clock = 1100
  f.deps.now = () => clock
  const admission = await prepareGroupFloor(f.input, f.deps)

  if (admission.state !== 'ready') {
    throw new Error('not admitted')
  }

  // The agent's other turn takes ten minutes: far past the 120 s a message must be fresh when taken up.
  clock = 1000 + 10 * 60_000
  expect(await admission.finish()).toMatchObject({ mode: 'meeting', floor: { position: 0, acceptedAt: 1100 } })

  // A message already older than that when this Mac took it up is still refused at admission.
  const late = ports()
  late.input.acceptedAt = late.message.timestamp + 121_000
  await expect(prepareGroupFloor(late.input, late.deps)).rejects.toThrow('matrix_invocation_untrusted')
})

it('admits the owner message of a plain group (0.20) and refuses any other event type', async () => {
  const plain = ports()
  plain.message.wireType = 'm.room.message'
  plain.message.senderDevice = 'unencrypted'
  expect((await prepareGroupFloor(plain.input, plain.deps)).state).toBe('ready')
  expect(plain.deps.ownerDeviceDenied).not.toHaveBeenCalled()

  const other = ports()
  other.message.wireType = 'm.sticker'
  await expect(prepareGroupFloor(other.input, other.deps)).rejects.toThrow('matrix_invocation_untrusted')
})

it('the cap refuses before admission, and only the named first agent may notify', async () => {
  const f = ports()
  f.snapshot.usage.turns = 30
  expect(await prepareGroupFloor(f.input, f.deps)).toMatchObject({ state: 'paused', position: 1 })
})

it('uses one relevance decision for all shared eligible joins candidates and never waits when it is available', async () => {
  const f = ports()
  f.message.content.mentionedUserIds = []

  const relevance = vi.fn(async ({ candidateIds }: { candidateIds: readonly string[] }) => {
    expect(candidateIds).toEqual(facts.ownAgentIds)

    return ['@one:test']
  })

  const admission = await prepareGroupFloor(f.input, { ...f.deps, relevance })

  expect(relevance).toHaveBeenCalledExactlyOnceWith({
    message: f.message,
    candidateIds: facts.ownAgentIds,
    ownAgentIds: facts.ownAgentIds,
    routingDisclosed: false
  })
  expect(admission.state).toBe('ready')

  if (admission.state !== 'ready') {
    throw new Error('not admitted')
  }

  await admission.finish()
  expect(relevance).toHaveBeenCalledOnce()
})

it('treats a valid empty relevance decision as silence and bypasses relevance for explicit addressing', async () => {
  const silent = ports()
  silent.message.content.mentionedUserIds = []
  const silence = vi.fn(async () => [])
  expect((await prepareGroupFloor(silent.input, { ...silent.deps, relevance: silence })).state).toBe('ignored')
  expect(silence).toHaveBeenCalledOnce()

  const named = ports()
  const relevance = vi.fn(async () => ['@one:test'])
  const admission = await prepareGroupFloor(named.input, { ...named.deps, relevance })
  expect(admission.state).toBe('ready')
  expect(relevance).not.toHaveBeenCalled()
})

it('does not let the local agent mode narrow the shared relevance candidates and freezes membership for finish', async () => {
  const f = ports()
  f.message.content.mentionedUserIds = []
  f.snapshot.policy.agents['@one:test'] = { mode: 'addressed' }

  const relevance = vi.fn(async ({ candidateIds }: { candidateIds: readonly string[] }) => {
    expect(candidateIds).toEqual(['@two:test', '@three:test'])

    return ['@two:test']
  })

  expect((await prepareGroupFloor(f.input, { ...f.deps, relevance })).state).toBe('ignored')
  expect(relevance).toHaveBeenCalledOnce()

  const selected = ports()
  selected.message.content.mentionedUserIds = []

  const ready = await prepareGroupFloor(selected.input, {
    ...selected.deps,
    relevance: async () => ['@one:test']
  })

  expect(ready.state).toBe('ready')

  if (ready.state !== 'ready') {
    throw new Error('not admitted')
  }

  selected.snapshot.members = selected.snapshot.members.filter(member => member.userId !== '@one:test')
  await expect(ready.finish()).rejects.toThrow('matrix_group_changed')
})

it('a newly shared room ends an admitted meeting before model work starts', async () => {
  const f = ports()
  const admission = await prepareGroupFloor(f.input, f.deps)
  expect(admission.state).toBe('ready')

  if (admission.state !== 'ready') {
    throw new Error('not admitted')
  }

  f.snapshot.members.push({ userId: '@foreign:test', membership: 'join' })
  await expect(admission.finish()).rejects.toThrow('matrix_group_changed')
})

it('foreign or unverified hints cannot even reach room policy or floor reads', async () => {
  const f = ports()
  f.message.senderVerified = false
  await expect(prepareGroupFloor(f.input, f.deps)).rejects.toThrow('matrix_invocation_untrusted')
  expect(f.deps.snapshot).not.toHaveBeenCalled()
  expect(f.deps.ownerDeviceDenied).toHaveBeenCalledExactlyOnceWith(f.message.senderDevice)

  f.message.sender = '@foreign:test'
  await expect(prepareGroupFloor(f.input, f.deps)).rejects.toThrow('matrix_invocation_untrusted')
  expect(f.deps.ownerDeviceDenied).toHaveBeenCalledOnce()
})

it('an owner-stamped shared event keeps the normal shared profile and never grants chain authority', async () => {
  const f = ports()
  f.snapshot.members.push({ userId: '@foreign:test', membership: 'join' })
  f.message.content = {
    ...f.message.content,
    chain: { origin: '$forged', parent: '$prior', depth: 1 }
  } as typeof f.message.content
  f.message.content.mentionedUserIds = [f.input.agentId]
  const admission = await prepareGroupFloor(f.input, f.deps)
  expect(admission.state).toBe('ready')

  if (admission.state !== 'ready') {
    throw new Error('not admitted')
  }

  const group = await admission.finish()
  expect(group.mode).toBe('shared')
  expect(group).not.toHaveProperty('chain')
  expect(group.audience).toContain('@foreign:test')
})
