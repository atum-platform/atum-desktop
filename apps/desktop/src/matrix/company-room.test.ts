import { createClient, EventType, MatrixEvent, Preset, Room } from 'matrix-js-sdk'
import type { IStateEventWithRoomId, MatrixClient } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MATRIX_COMPANY_PROJECT_BINDING,
  MATRIX_COMPANY_PROJECT_TYPE,
  MATRIX_COMPANY_ROOM_VERSION,
  type MatrixCompanyRoomBinding,
  type MatrixCompanyRoomTarget
} from '../../shared/matrix-company-room'

import { readAssistantRoom } from './assistant-room'
import {
  createCompanyProjectRoom,
  findCompanyProjectRoom,
  joinCompanyProjectRoom,
  readCompanyProjectRoom,
  reconcileCompanyProjectRoom,
  rotateCompanyProjectSession
} from './company-room'

const ROOM_ID = '!company-project:test'
const OTHER_ROOM_ID = '!other-company-project:test'
const MANAGER = '@manager:test'
const SERVICE = '@cos:test'
const MEMBER = '@member:test'
const OUTSIDER = '@outsider:test'
const FORMER = '@former:test'

const binding: MatrixCompanyRoomBinding = {
  companyId: '00000000-0000-4000-8000-bd7662a5eeb4',
  projectId: '00000000-0000-4000-8000-b454f82c5857',
  servicePrincipal: '00000000-0000-4000-8000-f6222a1106ee',
  managerUserId: MANAGER,
  serviceUserId: SERVICE
}

const target: MatrixCompanyRoomTarget = {
  ...binding,
  roomId: ROOM_ID,
  memberUserIds: [MEMBER]
}

let sequence = 0

function state(
  type: string,
  stateKey: string,
  content: Record<string, unknown>,
  sender = MANAGER,
  roomId = ROOM_ID
): IStateEventWithRoomId {
  sequence += 1

  return {
    type,
    state_key: stateKey,
    room_id: roomId,
    content,
    event_id: `$company-state-${sequence}`,
    sender,
    origin_server_ts: sequence
  }
}

function member(userId: string, membership: string) {
  return state(EventType.RoomMember, userId, { membership })
}

function validState(
  serviceMembership = 'join',
  members: IStateEventWithRoomId[] = []
): IStateEventWithRoomId[] {
  return [
    state(EventType.RoomCreate, '', {
      type: MATRIX_COMPANY_PROJECT_TYPE,
      room_version: MATRIX_COMPANY_ROOM_VERSION,
      [MATRIX_COMPANY_PROJECT_BINDING]: {
        companyId: binding.companyId,
        projectId: binding.projectId,
        servicePrincipal: binding.servicePrincipal,
        serviceUserId: SERVICE
      }
    }),
    state(EventType.RoomPowerLevels, '', {
      users: { [MANAGER]: 100 },
      users_default: 0,
      events: {},
      events_default: 0,
      state_default: 100,
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 100,
      notifications: { room: 100 }
    }),
    state(EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }),
    state(EventType.RoomHistoryVisibility, '', { history_visibility: 'joined' }),
    state(EventType.RoomJoinRules, '', { join_rule: 'invite' }),
    state(EventType.RoomGuestAccess, '', { guest_access: 'forbidden' }),
    member(MANAGER, 'join'),
    member(SERVICE, serviceMembership),
    member(MEMBER, 'join'),
    ...members
  ]
}

function client(userId = MANAGER, events = validState()): MatrixClient {
  const value = createClient({ baseUrl: 'https://matrix.test', userId })
  vi.spyOn(value.http, 'authedRequest').mockResolvedValue(events)

  return value
}

function discoveryClient(rooms: Record<string, IStateEventWithRoomId[]>) {
  const value = client()
  vi.spyOn(value, 'getJoinedRooms').mockResolvedValue({ joined_rooms: Object.keys(rooms) })
  vi.spyOn(value, 'getRoom').mockReturnValue(null)
  vi.spyOn(value, 'roomState').mockImplementation(async roomId => rooms[roomId] ?? [])

  return value
}

function invitation(value: MatrixClient, events = validState('invite')) {
  const room = new Room(ROOM_ID, value, SERVICE)
  room.currentState.setStateEvents(events.map(event => new MatrixEvent(event)))
  room.updateMyMembership('invite')
  vi.spyOn(value, 'getRoom').mockReturnValue(room)

  return room
}

describe('company project room creation and recovery', () => {
  it('posts a v11 invite-only plain room with shared history and exclusive manager control once', async () => {
    const value = client()
    const create = vi.spyOn(value, 'createRoom').mockResolvedValue({ room_id: ROOM_ID } as never)

    await expect(createCompanyProjectRoom(value, { ...binding, name: 'Project channel' })).resolves.toBe(ROOM_ID)

    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({
      name: 'Project channel',
      preset: Preset.PrivateChat,
      room_version: MATRIX_COMPANY_ROOM_VERSION,
      creation_content: {
        type: MATRIX_COMPANY_PROJECT_TYPE,
        [MATRIX_COMPANY_PROJECT_BINDING]: {
          companyId: binding.companyId,
          projectId: binding.projectId,
          servicePrincipal: binding.servicePrincipal,
          serviceUserId: SERVICE
        }
      },
      power_level_content_override: {
        users: { [MANAGER]: 100 }, users_default: 0,
        events: {}, events_default: 0, state_default: 100,
        invite: 100, kick: 100, ban: 100, redact: 100, notifications: { room: 100 }
      },
      initial_state: [
        { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } },
        { type: EventType.RoomJoinRules, state_key: '', content: { join_rule: 'invite' } },
        { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } }
      ]
    })
  })

  it('does not retry an unknown create reply and recovers only an exact single binding', async () => {
    const value = client()
    const create = vi.spyOn(value, 'createRoom').mockRejectedValue(new Error('reply lost'))

    await expect(createCompanyProjectRoom(value, { ...binding, name: 'Project channel' })).rejects.toThrow('reply lost')
    expect(create).toHaveBeenCalledTimes(1)

    await expect(findCompanyProjectRoom(discoveryClient({ [ROOM_ID]: validState() }), binding)).resolves.toBe(ROOM_ID)
    await expect(findCompanyProjectRoom(discoveryClient({
      [ROOM_ID]: validState(),
      [OTHER_ROOM_ID]: validState()
    }), binding)).rejects.toThrow('matrix_company_room_conflict')
  })

  it('recovers a lost create among more than 1,000 joined rooms and remembers each room it classified', async () => {
    const rooms: Record<string, IStateEventWithRoomId[]> = {}

    for (let index = 0; index < 1500; index++) {
      const id = `!stranger-${String(index).padStart(4, '0')}:test`

      rooms[id] = [state(EventType.RoomCreate, '', { type: 'm.space', room_version: '11' }, MANAGER, id)]
    }

    rooms[ROOM_ID] = validState()
    const value = discoveryClient(rooms)

    await expect(findCompanyProjectRoom(value, binding)).resolves.toBe(ROOM_ID)
    const reads = vi.mocked(value.roomState).mock.calls.length

    expect(reads).toBeGreaterThanOrEqual(1501)
    await expect(findCompanyProjectRoom(value, binding)).resolves.toBe(ROOM_ID)
    expect(vi.mocked(value.roomState).mock.calls.length - reads).toBe(1)
  })

  it('does not call a project room missing while its state is incomplete, and finds it once it is complete', async () => {
    const rooms: Record<string, IStateEventWithRoomId[]> = { [ROOM_ID]: [] }
    const value = discoveryClient(rooms)
    vi.spyOn(value, 'getRoom').mockReturnValue({ getType: () => undefined } as never)
    const create = vi.spyOn(value, 'createRoom')

    await expect(findCompanyProjectRoom(value, binding)).rejects.toThrow('matrix_company_room_required')
    expect(create).not.toHaveBeenCalled()
    rooms[ROOM_ID] = validState()
    await expect(findCompanyProjectRoom(value, binding)).resolves.toBe(ROOM_ID)
    expect(create).not.toHaveBeenCalled()
  })

  describe('with a joined room somebody else made that will not answer', () => {
    afterEach(() => { vi.useRealTimers() })

    it('is not stopped by it, and never leaves it (no journal reports this family\'s leaves)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const value = discoveryClient({ '!stuck:test': [] })

      vi.spyOn(value, 'getRoom').mockReturnValue({
        getType: () => undefined,
        currentState: { getStateEvents: () => ({ getSender: () => OUTSIDER, getContent: () => ({ type: 'm.space' }) }) }
      } as never)
      const leave = vi.spyOn(value, 'leave').mockResolvedValue({})
      const create = vi.spyOn(value, 'createRoom')

      for (const at of [0, 30_000, 60_000, 600_000]) {
        vi.setSystemTime(at)
        await expect(findCompanyProjectRoom(value, binding)).resolves.toBeNull()
      }

      expect(leave).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    })
  })

  it('rejects a malformed channel name before any room is created', async () => {
    const value = client()
    const create = vi.spyOn(value, 'createRoom')

    for (const name of ['', ' Project', 'Project ', 'P\nroject', `Project${String.fromCharCode(127)}`, 'x'.repeat(121)]) {
      await expect(createCompanyProjectRoom(value, { ...binding, name })).rejects.toThrow('matrix_company_room_required')
    }

    expect(create).not.toHaveBeenCalled()
  })

  it.each(['company', 'project', 'service', 'manager', 'version', 'history', 'encryption', 'join-rule', 'guest', 'power'])(
    'does not admit immutable %s drift',
    async mode => {
      const events = validState()
      const creation = events[0]!
      const powers = events[1]!

      if (mode === 'company') {Reflect.set(creation.content[MATRIX_COMPANY_PROJECT_BINDING] as object, 'companyId', binding.projectId)}

      if (mode === 'project') {Reflect.set(creation.content[MATRIX_COMPANY_PROJECT_BINDING] as object, 'projectId', binding.companyId)}

      if (mode === 'service') {Reflect.set(creation.content[MATRIX_COMPANY_PROJECT_BINDING] as object, 'serviceUserId', MEMBER)}

      if (mode === 'manager') {creation.sender = MEMBER}

      if (mode === 'version') {creation.content.room_version = '12'}

      if (mode === 'history') {events[3]!.content.history_visibility = 'shared'}

      if (mode === 'encryption') {events[2]!.content.algorithm = 'm.olm.v1.curve25519-aes-sha2'}

      if (mode === 'join-rule') {events[4]!.content.join_rule = 'public'}

      if (mode === 'guest') {events[5]!.content.guest_access = 'can_join'}

      if (mode === 'power') {(powers.content.users as Record<string, unknown>)[MEMBER] = 100}

      await expect(readCompanyProjectRoom(client(MANAGER, events), target)).rejects.toThrow('matrix_company_room_required')
      const recovery = findCompanyProjectRoom(discoveryClient({ [ROOM_ID]: events }), binding)

      if (['company', 'project', 'service', 'manager', 'version'].includes(mode)) {
        await expect(recovery).resolves.toBeNull()
      } else {
        await expect(recovery).rejects.toThrow('matrix_company_room_required')
      }
    }
  )
})

describe('company project room authority', () => {
  it('requires exactly the current manager, service, and roster for active or invited members', async () => {
    const safeFormer = validState('join', [member(FORMER, 'leave'), member(OUTSIDER, 'ban')])
    await expect(readCompanyProjectRoom(client(MANAGER, safeFormer), target)).resolves.toBeUndefined()

    for (const membership of ['join', 'invite', 'knock']) {
      await expect(readCompanyProjectRoom(client(MANAGER, validState('join', [member(OUTSIDER, membership)])), target)).rejects.toThrow('matrix_company_room_required')
    }

    await expect(readCompanyProjectRoom(client(OUTSIDER), target)).rejects.toThrow('matrix_company_room_required')

    for (const membership of ['leave', 'ban', 'knock', 'absent']) {
      const events = validState().filter(event => event.state_key !== MEMBER)

      if (membership !== 'absent') {events.push(member(MEMBER, membership))}
      await expect(readCompanyProjectRoom(client(MANAGER, events), target)).rejects.toThrow('matrix_company_room_required')
    }
  })

  it('allows a pending CoS invitation only for service enrollment, never ordinary reads', async () => {
    const events = validState('invite')
    await expect(readCompanyProjectRoom(client(MANAGER, events), target)).rejects.toThrow('matrix_company_room_required')
    await expect(readCompanyProjectRoom(client(SERVICE, events), { ...target, allowServiceInvite: true })).resolves.toBeUndefined()
  })

  it('keeps the personal assistant-room gate private', async () => {
    await expect(readAssistantRoom(client(MANAGER), {
      roomId: ROOM_ID,
      ownerId: MANAGER,
      agentId: SERVICE
    })).rejects.toThrow('matrix_private_assistant_room_required')
  })
})

describe('manager reconciliation and CoS custody', () => {
  it('reads a long-lived room without treating former members as its current audience', async () => {
    const history = Array.from({ length: 1001 }, (_, index) => member(`@former-${index}:test`, 'ban'))
    await expect(readCompanyProjectRoom(client(SERVICE, validState('join', history)), target)).resolves.toBeUndefined()
  })

  it('rereads an already joined CoS without issuing another join', async () => {
    const value = client(SERVICE)
    invitation(value, validState()).updateMyMembership('join')
    const join = vi.spyOn(value, 'joinRoom')
    const read = vi.spyOn(value, 'roomState').mockResolvedValue(validState())
    await expect(joinCompanyProjectRoom(value, target)).resolves.toBeUndefined()
    expect(join).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('has the manager ban outsiders, restore authorized people, then reread the result', async () => {
    const before = validState('invite', [
      member(OUTSIDER, 'join'),
      member('@invitee:test', 'invite'),
      member('@knocking:test', 'knock')
    ])

    before.find(event => event.type === EventType.RoomMember && event.state_key === MEMBER)!.content.membership = 'ban'

    const after = validState('invite', [
      member(OUTSIDER, 'ban'),
      member('@invitee:test', 'ban'),
      member('@knocking:test', 'ban')
    ])

    after.find(event => event.type === EventType.RoomMember && event.state_key === MEMBER)!.content.membership = 'invite'
    const value = client()
    const roomState = vi.spyOn(value, 'roomState').mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    const ban = vi.spyOn(value, 'ban').mockResolvedValue({})
    const unban = vi.spyOn(value, 'unban').mockResolvedValue({})
    const invite = vi.spyOn(value, 'invite').mockResolvedValue({})

    await expect(reconcileCompanyProjectRoom(value, target)).resolves.toBeUndefined()

    expect(ban).toHaveBeenCalledWith(ROOM_ID, OUTSIDER)
    expect(ban).toHaveBeenCalledWith(ROOM_ID, '@invitee:test')
    expect(ban).toHaveBeenCalledWith(ROOM_ID, '@knocking:test')
    expect(unban).toHaveBeenCalledWith(ROOM_ID, MEMBER)
    expect(invite).toHaveBeenCalledWith(ROOM_ID, MEMBER)
    expect(roomState).toHaveBeenCalledTimes(2)
  })

  it('rejects reconciliation outside manager custody', async () => {
    const value = client(SERVICE)
    const ban = vi.spyOn(value, 'ban').mockResolvedValue({})
    await expect(reconcileCompanyProjectRoom(value, target)).rejects.toThrow('matrix_company_room_required')
    expect(ban).not.toHaveBeenCalled()
  })

  it('lets only the service join and fences a stale authorization after joining', async () => {
    const after = validState('join')
    const value = client(SERVICE)
    invitation(value)

    const read = vi.spyOn(value, 'roomState').mockImplementation(async () => {
      expect(join).toHaveBeenCalled()

      return after
    })

    const join = vi.spyOn(value, 'joinRoom').mockResolvedValue({ roomId: ROOM_ID } as never)

    await expect(joinCompanyProjectRoom(value, target)).resolves.toBeUndefined()
    expect(join).toHaveBeenCalledWith(ROOM_ID)
    expect(read).toHaveBeenCalledTimes(1)

    let active = true
    const stale = client(SERVICE)
    invitation(stale)
    vi.spyOn(stale, 'roomState').mockResolvedValue(validState())
    vi.spyOn(stale, 'joinRoom').mockImplementation(async () => {
      active = false

      return { roomId: ROOM_ID } as never
    })
    await expect(joinCompanyProjectRoom(stale, target, () => active)).rejects.toThrow('matrix_company_room_required')
    await expect(joinCompanyProjectRoom(client(MANAGER), target)).rejects.toThrow('matrix_company_room_required')
  })

  it('requires the exact manager invitation and validates full state after joining', async () => {
    for (const change of ['inviter', 'binding', 'encryption', 'absent']) {
      const value = client(SERVICE)
      const events = validState('invite')

      if (change === 'inviter') {events.find(event => event.state_key === SERVICE)!.sender = OUTSIDER}

      if (change === 'binding') {Reflect.set(events[0]!.content[MATRIX_COMPANY_PROJECT_BINDING] as object, 'projectId', binding.companyId)}

      if (change === 'encryption') {events[2]!.content.algorithm = 'plaintext'}

      if (change !== 'absent') {invitation(value, events)}
      const join = vi.spyOn(value, 'joinRoom').mockResolvedValue({ roomId: ROOM_ID } as never)
      await expect(joinCompanyProjectRoom(value, target)).rejects.toThrow('matrix_company_room_required')
      expect(join).not.toHaveBeenCalled()
    }

    const value = client(SERVICE)
    invitation(value)
    const joined = validState('join', [member(OUTSIDER, 'join')])
    vi.spyOn(value, 'roomState').mockResolvedValue(joined)
    vi.spyOn(value, 'joinRoom').mockResolvedValue({ roomId: ROOM_ID } as never)
    await expect(joinCompanyProjectRoom(value, target)).rejects.toThrow('matrix_company_room_required')
  })

  it('rotates only from the service and checks current authority again afterwards', async () => {
    const value = client(SERVICE)
    invitation(value, validState()).updateMyMembership('join')
    vi.spyOn(value, 'roomState').mockResolvedValue(validState())
    const discard = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(value, 'getCrypto').mockReturnValue({ forceDiscardSession: discard } as never)

    await expect(rotateCompanyProjectSession(value, target)).resolves.toBeUndefined()
    expect(discard).toHaveBeenCalledWith(ROOM_ID)

    let active = true
    const stale = client(SERVICE)
    invitation(stale, validState()).updateMyMembership('join')
    vi.spyOn(stale, 'roomState').mockResolvedValue(validState())
    const staleDiscard = vi.fn().mockImplementation(async () => { active = false })
    vi.spyOn(stale, 'getCrypto').mockReturnValue({ forceDiscardSession: staleDiscard } as never)
    await expect(rotateCompanyProjectSession(stale, target, () => active)).rejects.toThrow('matrix_company_room_required')
    expect(staleDiscard).toHaveBeenCalledWith(ROOM_ID)

    await expect(rotateCompanyProjectSession(client(MANAGER), target)).rejects.toThrow('matrix_company_room_required')
  })

  it('waits for the SDK encryption audience to exclude a removed person before rotating', async () => {
    const value = client(SERVICE)
    invitation(value, validState('join', [member(OUTSIDER, 'join')])).updateMyMembership('join')
    // The server is current but this device has not received the ban through sync.
    vi.spyOn(value, 'roomState').mockResolvedValue(validState())
    const discard = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(value, 'getCrypto').mockReturnValue({ forceDiscardSession: discard } as never)
    await expect(rotateCompanyProjectSession(value, target)).rejects.toThrow('matrix_company_room_required')
    expect(discard).not.toHaveBeenCalled()
  })
})

/** A room as 0.20 makes it: no encryption state, history shared like any group. */
function plainState(serviceMembership = 'join', history = 'shared') {
  return validState(serviceMembership)
    .filter(event => event.type !== EventType.RoomEncryption)
    .map(event =>
      event.type === EventType.RoomHistoryVisibility ? { ...event, content: { history_visibility: history } } : event
    )
}

describe('company project rooms without encryption (0.20)', () => {
  it('admits a plain room with shared history, never another history, and keeps old rooms on Megolm', async () => {
    await expect(readCompanyProjectRoom(client(MANAGER, plainState()), target)).resolves.toBeUndefined()
    await expect(findCompanyProjectRoom(discoveryClient({ [ROOM_ID]: plainState() }), binding)).resolves.toBe(ROOM_ID)

    for (const history of ['joined', 'invited', 'world_readable']) {
      await expect(readCompanyProjectRoom(client(MANAGER, plainState('join', history)), target)).rejects.toThrow(
        'matrix_company_room_required'
      )
    }

    // A room with encryption keeps today's rule: shared history there is still drift.
    const encryptedShared = validState().map(event =>
      event.type === EventType.RoomHistoryVisibility ? { ...event, content: { history_visibility: 'shared' } } : event
    )

    await expect(readCompanyProjectRoom(client(MANAGER, encryptedShared), target)).rejects.toThrow(
      'matrix_company_room_required'
    )
  })

  it('lets the service join a plain invitation, then checks full state', async () => {
    const value = client(SERVICE)
    invitation(value, plainState('invite'))
    vi.spyOn(value, 'roomState').mockResolvedValue(plainState())
    const join = vi.spyOn(value, 'joinRoom').mockResolvedValue({ roomId: ROOM_ID } as never)

    await expect(joinCompanyProjectRoom(value, target)).resolves.toBeUndefined()
    expect(join).toHaveBeenCalledWith(ROOM_ID)
  })

  it('has no session to rotate in a plain room, and still checks current authority', async () => {
    const value = client(SERVICE)
    invitation(value, plainState()).updateMyMembership('join')
    const read = vi.spyOn(value, 'roomState').mockResolvedValue(plainState())
    const discard = vi.fn()
    vi.spyOn(value, 'getCrypto').mockReturnValue({ forceDiscardSession: discard } as never)

    await expect(rotateCompanyProjectSession(value, target)).resolves.toBeUndefined()
    expect(read).toHaveBeenCalledOnce()
    expect(discard).not.toHaveBeenCalled()

    const outsider = client(SERVICE)
    invitation(outsider, plainState()).updateMyMembership('join')
    vi.spyOn(outsider, 'roomState').mockResolvedValue(validState('join', [member(OUTSIDER, 'join')]))
    await expect(rotateCompanyProjectSession(outsider, target)).rejects.toThrow('matrix_company_room_required')
  })
})
