import { describe, expect, it, vi } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'
import { MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'

import {
  assertCompanyRoomCommandAllowed,
  CompanyChannelConfirmations,
  companyChannelOpenFailedLine,
  companyChannelSelectedLine,
  companyRoomCommandRefused,
  companyRoomConfirmed
} from './company-room-guard'

const COMPANY = '00000000-0000-4000-8000-bd7662a5eeb4'
const CHANNEL = '00000000-0000-4000-8000-b454f82c5857'
const OTHER_COMPANY = '00000000-0000-4000-8000-f6222a1106ee'
const OTHER_CHANNEL = '00000000-0000-4000-8000-f1d11edf5c5c'

function room(id: string, companyId = COMPANY, channelId = CHANNEL): MatrixRoom {
  return {
    id,
    name: id,
    membership: 'join',
    encrypted: false,
    roomType: MATRIX_COMPANY_CHANNEL_TYPE,
    companyChannel: { companyId, channelId }
  }
}

/** The platform's list-channels answer for one company. */
function directory(entries: Array<{ channelId: string; roomId: string | null }>) {
  return {
    schemaVersion: 2,
    channels: entries.map(({ channelId, roomId }) => ({
      schemaVersion: 2,
      channel: { id: channelId, companyId: COMPANY, displayName: 'general', state: 'active' },
      memberCount: 3,
      room: roomId ? { state: 'ready', roomId } : { state: 'provisioning', roomId: null }
    }))
  }
}

describe('company room guard', () => {
  it('names the commands a company authority owns', () => {
    for (const kind of ['leave', 'forget', 'removeMember', 'ban', 'unban', 'invite'] as const) {
      expect(companyRoomCommandRefused(kind)).toBe(true)
    }

    for (const kind of ['mute', 'select', 'attach'] as const) {
      expect(companyRoomCommandRefused(kind)).toBe(false)
    }
  })

  it.each(['leave', 'forget', 'removeMember', 'ban', 'unban', 'invite'] as const)(
    'refuses %s on a room the directory lists with this exact room ID',
    async kind => {
      const read = vi.fn(async () => directory([{ channelId: CHANNEL, roomId: '!real:test' }]))

      await expect(assertCompanyRoomCommandAllowed(kind, room('!real:test'), read)).rejects.toThrow(
        'matrix_company_room_managed'
      )
      expect(read).toHaveBeenCalledWith(COMPANY)
    }
  )

  it('lets other commands through on a confirmed room without asking the platform', async () => {
    const read = vi.fn(async () => directory([{ channelId: CHANNEL, roomId: '!real:test' }]))

    await expect(assertCompanyRoomCommandAllowed('mute', room('!real:test'), read)).resolves.toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('does not trust a room that only claims the type with plausible UUID bindings', async () => {
    // The creator picked the create-event type and valid-looking IDs; the directory has never heard of this room.
    const spoof = room('!spoof:test')

    for (const listing of [
      directory([]),
      directory([{ channelId: OTHER_CHANNEL, roomId: '!real:test' }]),
      // The real channel's IDs copied into a different room: the directory binds them to another room ID.
      directory([{ channelId: CHANNEL, roomId: '!real:test' }]),
      directory([{ channelId: CHANNEL, roomId: null }]),
      { schemaVersion: 2 },
      null
    ]) {
      expect(await companyRoomConfirmed(spoof, async () => listing)).toBe(false)
      await expect(assertCompanyRoomCommandAllowed('leave', spoof, async () => listing)).resolves.toBeUndefined()
      await expect(assertCompanyRoomCommandAllowed('forget', spoof, async () => listing)).resolves.toBeUndefined()
    }
  })

  it('fails closed for a joined company room when the directory is unavailable', async () => {
    const read = vi.fn(async () => {
      throw new Error('matrix_company_unavailable')
    })

    expect(await companyRoomConfirmed(room('!real:test'), read)).toBe(false)
    await expect(assertCompanyRoomCommandAllowed('leave', room('!real:test'), read)).rejects.toThrow(
      'matrix_company_room_unavailable'
    )

    await expect(assertCompanyRoomCommandAllowed(
      'leave',
      { ...room('!invite:test'), membership: 'invite' },
      read
    )).resolves.toBeUndefined()
  })

  it('never guards a room without the claim', async () => {
    const read = vi.fn(async () => directory([{ channelId: CHANNEL, roomId: '!real:test' }]))

    await expect(assertCompanyRoomCommandAllowed('leave', undefined, read)).resolves.toBeUndefined()
    await expect(
      assertCompanyRoomCommandAllowed('leave', { id: '!real:test', roomType: MATRIX_COMPANY_CHANNEL_TYPE }, read)
    ).resolves.toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('company channel confirmations (what the window sees)', () => {
  const ME = { accountKey: '@me:test', generation: 1 }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  function setup(answer: (companyId: string) => Promise<unknown>) {
    const changed = vi.fn()
    const read = vi.fn(answer)
    let clock = 0
    const confirmations = new CompanyChannelConfirmations({ read, changed, now: () => Date.now() + clock })
    confirmations.activate(ME)

    return { changed, read, confirmations, advance: (ms: number) => (clock += ms) }
  }

  it('keeps the claim while the first read is in flight, then shows only confirmed channels as channels', async () => {
    const { confirmations, changed, read } = setup(async () =>
      directory([{ channelId: CHANNEL, roomId: '!real:test' }])
    )
    const rooms = [room('!real:test'), room('!spoof:test', COMPANY, OTHER_CHANNEL)]

    expect(confirmations.view(rooms).map(value => Boolean(value.companyChannel))).toEqual([true, true])
    await settle()
    expect(changed).toHaveBeenCalledTimes(1)

    const [real, spoof] = confirmations.view(rooms)
    expect(real?.companyChannel).toEqual({ companyId: COMPANY, channelId: CHANNEL })
    expect(real?.roomType).toBe(MATRIX_COMPANY_CHANNEL_TYPE)
    // The spoof is an ordinary room now: it lists in Home and can be declined or left.
    expect(spoof?.companyChannel).toBeUndefined()
    expect(spoof?.roomType).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps an outage inside the company boundary and quarantines an open transcript', async () => {
    const { confirmations, changed } = setup(async () => {
      throw new Error('unavailable')
    })
    const claimed = room('!real:test')
    const state = {
      state: 'ready' as const,
      rooms: [claimed],
      roomId: claimed.id,
      destination: { kind: 'room' as const, roomId: claimed.id },
      messages: [{ id: '$secret:test' }],
      members: [{ userId: '@member:test' }],
      canSend: true,
      typing: ['@member:test'],
      threads: [{ id: '$thread:test' }],
      membershipLines: [{ id: '$member:test' }]
    }

    confirmations.project(state as never)
    await settle()
    expect(changed).toHaveBeenCalled()
    const projected = confirmations.project(state as never) as typeof state
    expect(projected.rooms[0]).toMatchObject({ id: '!real:test', roomType: MATRIX_COMPANY_CHANNEL_TYPE })
    expect(projected.rooms[0]?.companyChannel).toEqual({ companyId: COMPANY, channelId: CHANNEL })
    expect(projected.roomId).toBeNull()
    expect(projected.messages).toEqual([])
    expect(projected.canSend).toBe(false)
  })

  it('never recasts a previously confirmed private room as Personal after a negative refresh', async () => {
    let listing = directory([{ channelId: CHANNEL, roomId: '!private:test' }])
    const { confirmations, advance } = setup(async () => listing)
    const rooms = [room('!private:test')]

    confirmations.view(rooms)
    await settle()
    expect(confirmations.view(rooms)[0]?.companyChannel).toBeDefined()

    listing = directory([])
    advance(61_000)
    confirmations.view(rooms)
    await settle()

    expect(confirmations.view(rooms)[0]).toMatchObject({
      id: '!private:test',
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId: COMPANY, channelId: CHANNEL }
    })
  })

  it('reads each company once and re-reads after the interval', async () => {
    const { confirmations, read, advance } = setup(async companyId =>
      companyId === COMPANY
        ? directory([{ channelId: CHANNEL, roomId: '!a:test' }])
        : directory([{ channelId: OTHER_CHANNEL, roomId: '!b:test' }])
    )
    const rooms = [room('!a:test'), room('!b:test', OTHER_COMPANY, OTHER_CHANNEL)]

    confirmations.view(rooms)
    await settle()
    confirmations.view(rooms)
    expect(read).toHaveBeenCalledTimes(2)

    advance(61_000)
    confirmations.view(rooms)
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('forgets everything when the account changes', async () => {
    const { confirmations, read } = setup(async () => directory([{ channelId: CHANNEL, roomId: '!real:test' }]))
    const rooms = [room('!real:test')]

    confirmations.view(rooms)
    await settle()
    confirmations.activate({ accountKey: '@someone-else:test', generation: 1 })
    confirmations.view(rooms)
    expect(read).toHaveBeenCalledTimes(2)
    // Signed out: nothing is a company channel.
    confirmations.activate(null)
    expect(confirmations.view(rooms)[0]?.companyChannel).toBeUndefined()
  })

  it('leaves rooms without a claim, and the array itself, alone', () => {
    const { confirmations, read } = setup(async () => directory([]))
    const plain: MatrixRoom[] = [{ id: '!dm:test', name: 'dm', membership: 'join', encrypted: true }]

    expect(confirmations.view(plain)).toBe(plain)
    expect(read).not.toHaveBeenCalled()
  })

  it('projects a snapshot the same way for every renderer path (push and pull)', async () => {
    const { confirmations } = setup(async () => directory([{ channelId: CHANNEL, roomId: '!real:test' }]))
    const state = {
      state: 'ready',
      rooms: [room('!real:test'), room('!spoof:test', COMPANY, OTHER_CHANNEL)],
      identity: { userId: '@me:test' }
    }

    confirmations.project(state)
    await settle()

    // main sends `project(state)` on the push and `{ ...project(state), ...flags }` on the pull.
    const push = confirmations.project(state)
    const pull = { ...confirmations.project(state), domainEnabled: true }

    expect(pull.rooms).toEqual(push.rooms)
    expect(pull.rooms[1]?.companyChannel).toBeUndefined()
    expect(pull.rooms[1]?.roomType).toBeUndefined()
    expect(pull.rooms[0]?.companyChannel).toEqual({ companyId: COMPANY, channelId: CHANNEL })
    expect(pull.identity).toBe(state.identity)
    // main's own state keeps the raw claim so a later confirmation can still happen.
    expect(state.rooms[1]?.companyChannel).toBeDefined()
  })

  describe('over time', () => {
    const lifecycle = () => {
      vi.useFakeTimers()

      return () => vi.useRealTimers()
    }

    it('reclassifies a channel the directory dropped when the confirmation expires, with no new view', async () => {
      const restore = lifecycle()

      try {
        let listing = directory([{ channelId: CHANNEL, roomId: '!real:test' }])
        const { confirmations, changed, read } = setup(async () => listing)
        const rooms = [room('!real:test')]

        confirmations.view(rooms)
        await vi.advanceTimersByTimeAsync(0)
        expect(changed).toHaveBeenCalledTimes(1)
        expect(confirmations.view(rooms)[0]?.companyChannel).toBeDefined()

        // Quiet session: nobody calls view(). The answer is unchanged at first expiry: no republish.
        await vi.advanceTimersByTimeAsync(60_000)
        expect(read).toHaveBeenCalledTimes(2)
        expect(changed).toHaveBeenCalledTimes(1)

        listing = directory([])
        await vi.advanceTimersByTimeAsync(60_000)
        expect(read).toHaveBeenCalledTimes(3)
        expect(changed).toHaveBeenCalledTimes(2)
        expect(confirmations.view(rooms)[0]?.companyChannel).toBeDefined()
        expect(confirmations.view(rooms)[0]?.roomType).toBe(MATRIX_COMPANY_CHANNEL_TYPE)
      } finally {
        restore()
      }
    })

    it('stops re-reading once no room claims the company, and on stop()', async () => {
      const restore = lifecycle()

      try {
        const { confirmations, read } = setup(async () => directory([{ channelId: CHANNEL, roomId: '!real:test' }]))

        confirmations.view([room('!real:test')])
        await vi.advanceTimersByTimeAsync(0)
        confirmations.view([])
        await vi.advanceTimersByTimeAsync(180_000)
        expect(read).toHaveBeenCalledTimes(1)

        confirmations.view([room('!real:test')])
        await vi.advanceTimersByTimeAsync(0)
        expect(read).toHaveBeenCalledTimes(2)
        confirmations.stop()
        await vi.advanceTimersByTimeAsync(180_000)
        expect(read).toHaveBeenCalledTimes(2)
      } finally {
        restore()
      }
    })

    it('does not let a read from before a same-user sign-out and sign-in apply (ABA)', async () => {
      const resolvers: Array<(value: unknown) => void> = []
      const signals: AbortSignal[] = []
      const changed = vi.fn()

      const confirmations = new CompanyChannelConfirmations({
        read: (_company, signal) => {
          signals.push(signal)

          return new Promise(resolve => resolvers.push(resolve))
        },
        changed
      })
      const rooms = [room('!real:test')]

      confirmations.activate({ accountKey: '@me:test', generation: 1 })
      confirmations.view(rooms)
      // Sign out, then the same user signs in again: a new session, same userId.
      confirmations.activate(null)
      confirmations.activate({ accountKey: '@me:test', generation: 2 })
      expect(signals[0]?.aborted).toBe(true)
      confirmations.view(rooms)
      expect(resolvers).toHaveLength(2)

      // The old session's answer (confirming) arrives late and must be ignored.
      resolvers[0]?.(directory([{ channelId: CHANNEL, roomId: '!real:test' }]))
      await settle()
      expect(changed).not.toHaveBeenCalled()

      // The new session's answer says the directory no longer lists it.
      resolvers[1]?.(directory([]))
      await settle()
      expect(changed).toHaveBeenCalledTimes(1)
      expect(confirmations.view(rooms)[0]?.companyChannel).toBeUndefined()
    })
  })
})

describe('company channel diagnostics (OB1: a channel pane that stays empty)', () => {
  const ME = { accountKey: '@me:test', generation: 1 }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  it('says how the window is shown a selected channel: held for its first read, confirmed, held after a failed read, or ordinary', async () => {
    let answer: () => Promise<unknown> = async () => directory([{ channelId: CHANNEL, roomId: '!real:test' }])
    let clock = 0
    const confirmations = new CompanyChannelConfirmations({ read: () => answer(), changed: () => {}, now: () => clock })
    const real = room('!real:test')
    const stranger = room('!stranger:test', COMPANY, OTHER_CHANNEL)

    expect(confirmations.status(real)).toBe('signed-out')
    confirmations.activate(ME)
    confirmations.view([real, stranger])
    expect(confirmations.status(real)).toBe('pending')

    await settle()
    expect(confirmations.status(real)).toBe('confirmed')
    expect(confirmations.status(stranger)).toBe('unlisted')

    answer = async () => { throw new Error('unavailable') }
    clock += 61_000
    confirmations.view([real])
    await settle()
    expect(confirmations.status(real)).toBe('read-failed')
    expect(confirmations.status({ ...real, companyChannel: undefined, roomType: undefined })).toBe('unclaimed')
  })

  it('logs closed words only: never a room, company or channel id, never an error message', () => {
    expect(companyChannelSelectedLine('pending', 'invite')).toBe('[Matrix] company channel selected: projection=pending membership=invite')
    expect(companyChannelSelectedLine('confirmed', '!room:test')).toBe('[Matrix] company channel selected: projection=confirmed membership=none')
    expect(companyChannelSelectedLine('unclaimed', 'join')).toBeNull()
    expect(companyChannelOpenFailedLine('select', new Error('matrix_room_missing'))).toBe('[Matrix] company channel select failed: matrix_room_missing')
    expect(companyChannelOpenFailedLine('join', new Error(`M_FORBIDDEN for ${COMPANY} in !room:test`))).toBe('[Matrix] company channel join failed: error')
  })
})
