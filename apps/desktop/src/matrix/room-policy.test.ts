// @vitest-environment node
import { EventType, type MatrixClient, Method } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { matrixRoomPolicy } from './room-policy'

const target = { roomId: '!room:test', ownerId: '@owner:test', agentId: '@one:test' }
const now = Date.UTC(2026, 9, 7)

function fixture() {
  const state = [
    { type: EventType.RoomCreate, state_key: '', content: {} },
    { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
    ...[target.ownerId, target.agentId, '@two:test'].map(state_key => ({
      type: EventType.RoomMember,
      state_key,
      content: { membership: 'join' }
    }))
  ]

  const data: Record<string, unknown> = {}

  const read = vi.fn(async (_method: Method, path: string) => {
    const type = path.split('/').at(-1)!

    if (!(type in data)) {
      throw { errcode: 'M_NOT_FOUND' }
    }

    return data[type]
  })

  const write = vi.fn(async (_room: string, type: string, value: unknown) => {
    data[type] = value
  })

  let owner = target.ownerId
  let active = true

  const client = {
    getUserId: () => owner,
    getAccountData: () => undefined,
    roomState: vi.fn(async () => state),
    http: { authedRequest: read },
    setRoomAccountData: write
  } as unknown as MatrixClient

  return {
    state,
    data,
    read,
    write,
    api: matrixRoomPolicy(
      client,
      () => active,
      () => now
    ),
    foreign: () => {
      owner = '@foreign:test'
    },
    stop: () => {
      active = false
    }
  }
}

it('uses real room authorization and fresh room-scoped HTTP, with absent-record defaults', async () => {
  const f = fixture()
  await expect(f.api.read(target)).resolves.toEqual({
    policy: { v: 1, agents: {} },
    usage: { v: 1, day: '2026-10-07', turns: 0 }
  })
  expect(f.read.mock.calls).toEqual([
    [Method.Get, '/user/%40owner%3Atest/rooms/!room%3Atest/account_data/io.atum.room.agents'],
    [Method.Get, '/user/%40owner%3Atest/rooms/!room%3Atest/account_data/io.atum.room.usage']
  ])
})

it('merges a settings change with a fresh policy, preserving future and unrelated assistant keys', async () => {
  const f = fixture()
  f.data['io.atum.room.agents'] = {
    v: 1,
    dailyTurns: 40,
    consentEpoch: 'future',
    agents: {
      '@one:test': { mode: 'addressed', speak: 'future' },
      '@two:test': { mode: 'off' }
    }
  }
  const settings = { ...target, agentIds: [target.agentId] }
  await f.api.settings({ ...settings, change: { agentId: target.agentId, mode: 'joins' } })
  expect(f.data['io.atum.room.agents']).toEqual({
    v: 1,
    dailyTurns: 40,
    consentEpoch: 'future',
    agents: {
      '@one:test': { mode: 'joins', speak: 'future' },
      '@two:test': { mode: 'off' }
    }
  })
  await f.api.settings({ ...settings, change: { dailyTurns: 60 } })
  expect(f.data['io.atum.room.agents']).toMatchObject({ dailyTurns: 60, consentEpoch: 'future' })
  await f.api.settings({ ...settings, change: { routingDisclosure: 1 } })
  expect(f.data['io.atum.room.agents']).toMatchObject({ routingDisclosure: 1, consentEpoch: 'future' })
})

it('a slow settings read never blocks the advisory claimed counter', async () => {
  const f = fixture()
  let release!: (value: unknown) => void
  f.read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  const pending = f.api.settings({ ...target, agentIds: [target.agentId] })
  await vi.waitFor(() => expect(f.read).toHaveBeenCalled())
  await expect(
    f.api.usage({ ...target, change: 'claimed', dailyTurns: 30, invocationId: '00000000-0000-4000-8000-58f0eb3872bb' })
  ).resolves.toMatchObject({ usage: { turns: 1 } })
  release(undefined)
  await pending
  expect(f.write).toHaveBeenCalledOnce()
})

it.each([0, 201, 1.5, NaN])('refuses invalid daily cap %s before writing', async dailyTurns => {
  const f = fixture()
  await expect(f.api.settings({ ...target, agentIds: [target.agentId], change: { dailyTurns } })).rejects.toThrow(
    'matrix_command_invalid'
  )
  expect(f.write).not.toHaveBeenCalled()
})

it('refuses a policy change for a foreign or no-longer-joined assistant', async () => {
  const f = fixture()
  await expect(
    f.api.settings({ ...target, agentIds: [target.agentId], change: { agentId: '@foreign:test', mode: 'joins' } })
  ).rejects.toThrow('matrix_command_invalid')
  f.state.find(row => row.state_key === target.agentId)!.content = { membership: 'leave' }
  await expect(f.api.settings({ ...target, agentIds: [target.agentId], change: { dailyTurns: 30 } })).rejects.toThrow(
    'matrix_group_room_required'
  )
  expect(f.write).not.toHaveBeenCalled()
})

it('preserves future usage keys and resets the count at UTC midnight', async () => {
  const f = fixture()
  f.data['io.atum.room.usage'] = { v: 1, day: '2026-10-06', turns: 30, pausedNoticed: true, extra: 'preserved' }
  await f.api.usage({
    ...target,
    change: 'claimed',
    dailyTurns: 30,
    invocationId: '00000000-0000-4000-8000-58f0eb3872bb'
  })
  expect(f.write).toHaveBeenCalledWith(target.roomId, 'io.atum.room.usage', {
    v: 1,
    day: '2026-10-07',
    turns: 1,
    pausedNoticed: false,
    countedClaims: ['00000000-0000-4000-8000-58f0eb3872bb'],
    extra: 'preserved'
  })
})

it('a paused receipt preserves the count and is acknowledged through the owner SDK', async () => {
  const f = fixture()
  f.data['io.atum.room.usage'] = { v: 1, day: '2026-10-07', turns: 30 }
  await f.api.usage({ ...target, change: 'paused', dailyTurns: 30, day: '2026-10-07' })
  expect(f.data['io.atum.room.usage']).toEqual({ v: 1, day: '2026-10-07', turns: 30, pausedNoticed: true })
})

it('does not apply yesterday’s notice acknowledgment to today after midnight', async () => {
  const f = fixture()
  await f.api.usage({ ...target, change: 'paused', dailyTurns: 30, day: '2026-10-06' })
  expect(f.write).not.toHaveBeenCalled()
})

it('a late notice receipt cannot pause a cap raised before the fresh SDK write', async () => {
  const f = fixture()
  f.data['io.atum.room.agents'] = { v: 1, agents: {}, dailyTurns: 31 }
  f.data['io.atum.room.usage'] = { v: 1, day: '2026-10-07', turns: 30 }
  await f.api.usage({ ...target, change: 'paused', dailyTurns: 30, day: '2026-10-07' })
  expect(f.write).not.toHaveBeenCalled()
  expect(f.data['io.atum.room.usage']).toEqual({ v: 1, day: '2026-10-07', turns: 30 })
})

it.each(['policy', 'usage', 'http', 'foreign', 'left', 'stop'])('fails closed on %s before a write', async fault => {
  const f = fixture()

  if (fault === 'policy') {
    f.data['io.atum.room.agents'] = { v: 2, agents: {} }
  }

  if (fault === 'usage') {
    f.data['io.atum.room.usage'] = { v: 1, day: '2026-02-30', turns: 0 }
  }

  if (fault === 'http') {
    f.read.mockRejectedValue(new Error('offline'))
  }

  if (fault === 'foreign') {
    f.foreign()
  }

  if (fault === 'left') {
    Object.assign(f.state[4].content, { membership: 'leave' })
  }

  if (fault === 'stop') {
    f.stop()
  }

  await expect(
    f.api.usage({ ...target, change: 'claimed', dailyTurns: 30, invocationId: '00000000-0000-4000-8000-58f0eb3872bb' })
  ).rejects.toThrow()
  expect(f.write).not.toHaveBeenCalled()
})

it('refuses a concurrent stale overwrite and rechecks identity after the server read', async () => {
  const f = fixture()
  f.read.mockImplementation(async () => {
    f.foreign()

    return undefined
  })
  await expect(f.api.read(target)).rejects.toThrow('matrix_group_changed')
  expect(f.write).not.toHaveBeenCalled()
})

it('a lost acknowledgment or claimed-grant replay cannot double the advisory count', async () => {
  const f = fixture()

  const claim = {
    ...target,
    change: 'claimed' as const,
    dailyTurns: 30,
    invocationId: '00000000-0000-4000-8000-58f0eb3872bb'
  }

  await f.api.usage(claim)
  await f.api.usage(claim)
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(f.data['io.atum.room.usage']).toMatchObject({ turns: 1 })
})
