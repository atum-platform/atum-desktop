import { describe, expect, it, vi } from 'vitest'

import type { MatrixMessage, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { MATRIX_COMPANY_CONVERSATION_TYPE } from '../../shared/matrix-company-channel-room'

import { CompanyConversationConfirmations } from './company-conversation-confirmations'
import { createRoomCommandGuard } from './company-room-dispatch'

const COMPANY = '00000000-0000-4000-8000-87c6455cae48'
const CONVERSATION = '00000000-0000-4000-8000-f6c6b8bb709f'
const OTHER_CONVERSATION = '00000000-0000-4000-8000-8a4e23bab81e'
const SCOPE = { accountKey: 'acct', generation: 1 }

const claim = (id: string, conversationId = CONVERSATION, over: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id,
  name: id,
  membership: 'join',
  encrypted: false,
  roomType: MATRIX_COMPANY_CONVERSATION_TYPE,
  companyConversation: { companyId: COMPANY, conversationId },
  ...over
})

const plain: MatrixRoom = { id: '!plain:test', name: 'Plain', membership: 'join', encrypted: true }

const message = { id: '$1', sender: '@bao:test', body: 'secret', timestamp: 1, own: false } as unknown as MatrixMessage

const snapshot = (rooms: MatrixRoom[], roomId: string | null = null): MatrixSnapshot =>
  ({ state: 'ready', rooms, roomId, destination: roomId ? { kind: 'room', roomId } : null, messages: roomId ? [message] : [],
    members: [], canSend: true, typing: ['@bao:test'], threads: [], membershipLines: [], error: null }) as unknown as MatrixSnapshot

/** The platform's conversation directory listing one conversation in one ready room. */
const directory = (...entries: Array<{ id: string; roomId: string | null }>) => ({
  schemaVersion: 6,
  conversations: entries.map(entry => ({
    id: entry.id,
    companyId: COMPANY,
    room: entry.roomId ? { state: 'ready', roomId: entry.roomId } : { state: 'provisioning', roomId: null }
  }))
})

function make(read: (companyId: string) => Promise<unknown>, now?: () => number) {
  const changed = vi.fn()
  const confirmations = new CompanyConversationConfirmations({ read: (companyId: string) => read(companyId), changed, ...(now ? { now } : {}) })

  confirmations.activate(SCOPE)

  return { changed, confirmations }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('what the window is shown of a room that claims to be a company conversation', () => {
  it('shows nothing of it until the platform lists that conversation in that very room', async () => {
    const { changed, confirmations } = make(async () => directory({ id: CONVERSATION, roomId: '!dm:test' }))
    const room = claim('!dm:test')

    // The first read is in flight: the claim is held back, and the plain room is untouched.
    expect(confirmations.project(snapshot([plain, room])).rooms.map(value => value.id)).toEqual(['!plain:test'])

    await settle()
    expect(changed).toHaveBeenCalled()
    expect(confirmations.project(snapshot([plain, room])).rooms.map(value => value.id)).toEqual(['!plain:test', '!dm:test'])
  })

  it('never shows a room that claims the type with no readable binding, or a binding the directory does not list', async () => {
    const { confirmations } = make(async () => directory({ id: CONVERSATION, roomId: '!dm:test' }))
    const typeOnly = claim('!typeonly:test', CONVERSATION, { companyConversation: undefined })
    const unlisted = claim('!unlisted:test', OTHER_CONVERSATION)
    const forged = claim('!forged:test', CONVERSATION)

    confirmations.project(snapshot([unlisted, forged]))
    await settle()

    const shown = confirmations.project(snapshot([plain, typeOnly, unlisted, forged, claim('!dm:test')])).rooms.map(value => value.id)

    // Only the room the directory names for that conversation; the same id claimed in another room is not it.
    expect(shown).toEqual(['!plain:test', '!dm:test'])
  })

  it('takes the transcript, the composer’s power and the typing line away with a selected room it does not confirm', async () => {
    const { confirmations } = make(async () => directory())
    const forged = claim('!forged:test')

    confirmations.project(snapshot([forged], '!forged:test'))
    await settle()

    const shown = confirmations.project(snapshot([plain, forged], '!forged:test'))

    expect(shown.rooms.map(value => value.id)).toEqual(['!plain:test'])
    expect(shown).toMatchObject({ roomId: null, destination: null, messages: [], canSend: false, typing: [], members: [], threads: [], membershipLines: [] })
  })

  it('fails closed when the directory cannot be read, and again when it stops listing the room', async () => {
    let answer: unknown = directory({ id: CONVERSATION, roomId: '!dm:test' })
    let broken = false
    let clock = 1_000

    const { confirmations } = make(async () => {
      if (broken) {throw new Error('down')}

      return answer
    }, () => clock)

    const room = claim('!dm:test')

    confirmations.project(snapshot([room]))
    await settle()
    expect(confirmations.project(snapshot([room])).rooms).toHaveLength(1)

    // A removed participant: the platform no longer lists it, and the next read takes it away.
    answer = directory()
    clock += 120_000

    confirmations.project(snapshot([room]))
    await settle()
    expect(confirmations.project(snapshot([room])).rooms).toHaveLength(0)

    broken = true
    answer = directory({ id: CONVERSATION, roomId: '!dm:test' })
    clock += 120_000
    confirmations.project(snapshot([room]))
    await settle()
    expect(confirmations.project(snapshot([room])).rooms).toHaveLength(0)
  })

  it('looks again, soon, for a room the directory did not list yet: a new conversation’s room is listed a moment later', async () => {
    let answer: unknown = directory()
    let clock = 1_000
    const { confirmations } = make(async () => answer, () => clock)
    const room = claim('!dm:test')

    confirmations.project(snapshot([room]))
    await settle()
    expect(confirmations.project(snapshot([room])).rooms).toHaveLength(0)

    answer = directory({ id: CONVERSATION, roomId: '!dm:test' })
    clock += 6_000
    confirmations.project(snapshot([room]))
    await settle()
    expect(confirmations.project(snapshot([room])).rooms).toHaveLength(1)
  })

  it('does not know a room under another account or after a quit', async () => {
    const { confirmations } = make(async () => directory({ id: CONVERSATION, roomId: '!dm:test' }))
    const room = claim('!dm:test')

    confirmations.project(snapshot([room]))
    await settle()
    expect(confirmations.confirms(room)).toBe(true)

    confirmations.activate({ accountKey: 'someone-else', generation: 1 })
    expect(confirmations.confirms(room)).toBe(false)
    confirmations.stop()
    expect(confirmations.project(snapshot([room])).rooms).toEqual([])
  })

  it('hands the window no unread or mention counts for a claim the directory does not list: the badges are summed from what is shown', async () => {
    const { confirmations } = make(async () => directory({ id: CONVERSATION, roomId: '!dm:test' }))
    const loud = { highlights: 3, unread: true, unreadNotifications: 3 }
    const listed = claim('!dm:test', CONVERSATION, loud)
    const forged = claim('!forged:test', CONVERSATION, loud)

    confirmations.project(snapshot([listed, forged]))
    await settle()

    const shown = confirmations.project(snapshot([listed, forged])).rooms

    expect(shown.map(room => room.id)).toEqual(['!dm:test'])
    expect(shown.reduce((sum, room) => sum + (room.highlights ?? 0), 0)).toBe(3)
    expect(confirmations.project(snapshot([forged])).rooms.reduce((sum, room) => sum + (room.highlights ?? 0), 0)).toBe(0)
  })

  it('leaves every other room exactly as it was', () => {
    const { confirmations } = make(async () => directory())
    const input = snapshot([plain], '!plain:test')

    expect(confirmations.project(input)).toBe(input)
  })
})

describe('the one guard every Matrix membership command goes through', () => {
  const COMPANY_CHANNEL = '00000000-0000-4000-8000-b454f82c5857'

  const channelRoom: MatrixRoom = {
    id: '!ops:test',
    name: 'ops',
    membership: 'join',
    encrypted: false,
    roomType: 'io.atum.company_channel.v1',
    companyChannel: { companyId: COMPANY, channelId: COMPANY_CHANNEL }
  }

  const guard = (rooms: MatrixRoom[], confirmed: (room: MatrixRoom) => boolean = () => true) =>
    createRoomCommandGuard({
      rooms: () => rooms,
      directory: async () => ({ channels: [{ channel: { id: COMPANY_CHANNEL }, room: { state: 'ready', roomId: '!ops:test' } }] }),
      confirmsConversation: confirmed
    })

  it.each(['invite', 'leave', 'forget', 'removeMember', 'ban', 'unban'] as const)(
    'refuses %s on a joined company conversation, whoever asks (a bot invite is a membership command too)',
    async kind => {
      await expect(guard([claim('!dm:test')])(kind, '!dm:test')).rejects.toThrow('matrix_company_room_managed')
    }
  )

  it('refuses the same on a directory-confirmed company channel, and lets an ordinary room alone', async () => {
    await expect(guard([channelRoom])('invite', '!ops:test')).rejects.toThrow('matrix_company_room_managed')
    await expect(guard([plain])('invite', '!plain:test')).resolves.toBeUndefined()
    await expect(guard([plain])('send', undefined)).resolves.toBeUndefined()
  })

  it('refuses to select, join or send in a conversation room the platform does not list, but lets an invitation be declined', async () => {
    const unlisted = guard([claim('!dm:test')], () => false)

    for (const kind of ['select', 'join', 'send'] as const) {
      await expect(unlisted(kind, '!dm:test')).rejects.toThrow('matrix_company_conversation_unconfirmed')
    }

    const invited = guard([claim('!dm:test', CONVERSATION, { membership: 'invite' })], () => false)

    await expect(invited('leave', '!dm:test')).resolves.toBeUndefined()
    await expect(guard([claim('!dm:test')], () => true)('select', '!dm:test')).resolves.toBeUndefined()
  })
})

describe('looking again for a room the directory has not listed yet, with nobody asking', () => {
  const timed = (read: () => Promise<unknown>) => {
    vi.useFakeTimers()

    return make(read)
  }

  it('re-reads on its own after the unlisted window, without project() being called again', async () => {
    let answer: unknown = directory()
    const read = vi.fn(async () => answer)
    const { changed, confirmations } = timed(read)
    const room = claim('!dm:test')

    try {
      confirmations.project(snapshot([room]))
      await vi.advanceTimersByTimeAsync(0)
      expect(read).toHaveBeenCalledTimes(1)
      changed.mockClear()

      // The platform lists the room a moment later; nothing in the window asks again.
      answer = directory({ id: CONVERSATION, roomId: '!dm:test' })
      await vi.advanceTimersByTimeAsync(5_100)

      expect(read).toHaveBeenCalledTimes(2)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(confirmations.confirms(room)).toBe(true)
    } finally {
      confirmations.stop()
      vi.useRealTimers()
    }
  })

  it('moves a long wait forward when a claim that is not listed appears under a company that was all confirmed', async () => {
    let answer: unknown = directory({ id: CONVERSATION, roomId: '!dm:test' })
    const read = vi.fn(async () => answer)
    const { changed, confirmations } = timed(read)
    const listed = claim('!dm:test')
    const late = claim('!late:test', OTHER_CONVERSATION)

    try {
      confirmations.project(snapshot([listed]))
      await vi.advanceTimersByTimeAsync(0)
      expect(read).toHaveBeenCalledTimes(1)
      changed.mockClear()

      // One second on, a second conversation's room arrives; the platform lists it already, the directory read does not.
      await vi.advanceTimersByTimeAsync(1_000)
      answer = directory({ id: CONVERSATION, roomId: '!dm:test' }, { id: OTHER_CONVERSATION, roomId: '!late:test' })
      confirmations.project(snapshot([listed, late]))
      expect(read).toHaveBeenCalledTimes(1)

      // The 60 s timer is not what finds it: a read is due five seconds after the last one.
      await vi.advanceTimersByTimeAsync(4_100)

      expect(read).toHaveBeenCalledTimes(2)
      expect(confirmations.confirms(late)).toBe(true)
      expect(changed).toHaveBeenCalled()
    } finally {
      confirmations.stop()
      vi.useRealTimers()
    }
  })

  it('stops looking when nothing claims an unlisted room any more, and does not hammer the platform meanwhile', async () => {
    const read = vi.fn(async () => directory())
    const { confirmations } = timed(read)
    const room = claim('!dm:test')

    try {
      confirmations.project(snapshot([room]))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(16_000)

      // About one read per five seconds while it is claimed.
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(read.mock.calls.length).toBeLessThanOrEqual(5)

      confirmations.project(snapshot([plain]))
      const settled = read.mock.calls.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(read.mock.calls.length).toBeLessThanOrEqual(settled + 1)
    } finally {
      confirmations.stop()
      vi.useRealTimers()
    }
  })
})
